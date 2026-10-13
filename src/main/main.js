'use strict';

/**
 * main.js —— Electron 主进程
 *
 * 负责：窗口 / 托盘 / aria2 进程生命周期 / IPC 路由 / 自动关机 / 剪切板监听
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  shell,
  Tray,
  Menu,
  dialog,
  clipboard,
  nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');

const { BiliClient } = require('./bili');
const { DouyinClient } = require('./douyin');
const { api } = require('./api');
const { Config, NAME_VARS, getBin, getBinDir } = require('./config');
const { Downloader, buildTasks } = require('./downloader');
const { resolve: resolveLink, detectPlatform, extractStreams, humanSize } = require('./resolver');
const { Aria2 } = require('./aria2');
const logger = require('./logger');

const ARIA_SECRET = 'video-downloader';
const ICON = path.join(__dirname, '..', '..', 'assets', 'logo.ico');

/**
 * 构建标记。打包脚本会在 app 根目录写一个 build-info.json（版本 + 打包时间）。
 *
 * 用途：**分辨用户到底跑的是哪个包**。历史上好几个差异很大的包都叫 v1.1.0，
 * 结果「我明明修了，为什么还这样」排查起来极费劲 —— 现在关于页会直接显示构建时间，
 * 启动日志第一行也会记下来。
 * 开发态（源码直接跑）没有这个文件，记为 dev。
 */
const BUILD_INFO = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'build-info.json'), 'utf8'));
    return { version: j.version || '', builtAt: j.builtAt || '', stamp: j.stamp || '' };
  } catch (_) {
    return { version: '', builtAt: '', stamp: 'dev' };
  }
})();

/**
 * 应用展示名。原名 BiliDown-Next，现为通用名「视频下载器」（同时支持 B站 与 抖音）。
 * 改这里时记得同步另外两处：package.json 的 name、src/renderer/index.html 的
 * <title> 与标题栏文字。
 */
const APP_NAME = '视频下载器';

/**
 * 用户数据目录名（即 %APPDATA%\<这个名字>）——设置 / 下载记录 / B站 登录态都在里面。
 *
 * ★ 为什么取这个名字：
 *   1. 与 package.json 的 name 保持一致 → Electron 预先建好的「默认 userData 目录」
 *      和真正要用的目录是同一个，不会再凭空多出一个空壳目录（见下方回收逻辑）。
 *   2. 纯 ASCII，避免中文路径在转交给 aria2 / ffmpeg 子进程时踩编码坑。
 *
 * ★ 它曾经叫 bilidown-next（只支持 B站 那会儿留下的老名字）。直接换名 = 换目录 =
 *   老用户丢配置 + 得重新扫码登录，所以下面有一段**一次性迁移**把旧目录整份搬过来。
 */
const DATA_DIR_NAME = 'video-downloader';
const LEGACY_DATA_DIR_NAME = 'bilidown-next';

app.setName(APP_NAME);
let defaultUserDataDir = '';
try {
  const appData = app.getPath('appData');

  // Electron 在本文件被执行之前，就会按 package.json 的 name 先把「默认 userData 目录」
  // 建出来。以前 userData 指向的是另一个名字（bilidown-next），那个默认目录就变成了
  // **每次启动都凭空多出来的空文件夹**，用户看到会很困惑。
  // 现在 DATA_DIR_NAME 与 package.json 的 name 同名，两者是同一个目录，这段回收逻辑
  // 实际上不会触发 —— 保留它是为了将来万一有人把 DATA_DIR_NAME 改成别的名字。
  try {
    defaultUserDataDir = path.join(appData, require('../../package.json').name || '');
  } catch (e) {
    defaultUserDataDir = '';
  }

  const userDataDir = path.join(appData, DATA_DIR_NAME);

  // ★ 一次性迁移：老版本的目录叫 bilidown-next。换名不能顺手丢数据 ——
  //   设置、下载记录、B站 登录态全在里面，丢了就得重新扫码登录。
  try {
    migrateLegacyUserData(appData, DATA_DIR_NAME, LEGACY_DATA_DIR_NAME, userDataDir);
  } catch (e) {
    console.error('[app] legacy userData migration skipped: ' + e.message);
  }

  // 必须在 app ready 之前设置，否则 Chromium 已经按新名字建好缓存目录了
  app.setPath('userData', userDataDir);
} catch (e) {
  console.error('[app] failed to pin userData path: ' + e.message);
}

// 日志落盘的 init 放在下面 userData 定好之后（见 resolveLogBaseDir()）：
// 日志优先写在**程序同级目录**，只有那儿不可写才回退 userData，回退分支要用到最终的
// userData 路径，所以不能在这儿提前 init。

/**
 * 一次性迁移旧版用户数据目录（bilidown-next → video-downloader）。
 *
 * ★ 安全守则（宁可少迁，也不能搞坏）：
 *   1. 只在「新目录不存在、或确实是个空目录」时才动手 —— 新目录已有数据就绝不覆盖；
 *      注意 Electron 会预建一个空的新目录，那仍算"空"，要能迁。
 *   2. 逐条目 `renameSync`（同一块盘上搬家是瞬间完成的）。rename 失败（跨盘、被占用）
 *      才退回「递归复制 + 删源」。
 *   3. 单个条目搬不动就跳过它，**不能因为一个文件让整次迁移失败、更不能影响启动**。
 *   4. 旧目录搬空后删掉；里面还有搬运失败的残留就原样留着，交给用户自己判断。
 *
 * @param {string} appData  %APPDATA%
 * @param {string} newName  新目录名
 * @param {string} oldName  旧目录名
 * @param {string} newDir   新目录完整路径
 */
function migrateLegacyUserData(appData, newName, oldName, newDir) {
  if (!oldName || oldName === newName) return;

  const oldDir = path.join(appData, oldName);
  if (!fs.existsSync(oldDir)) return;

  if (fs.existsSync(newDir)) {
    let empty = false;
    try { empty = fs.readdirSync(newDir).length === 0; } catch (e) { empty = false; }
    if (!empty) return;   // 新版已经攒了数据，不动
  }
  fs.mkdirSync(newDir, { recursive: true });

  let moved = 0;
  for (const entry of fs.readdirSync(oldDir)) {
    const from = path.join(oldDir, entry);
    const to = path.join(newDir, entry);
    try {
      fs.renameSync(from, to);
      moved++;
    } catch (e) {
      try {
        copyTree(from, to);
        fs.rmSync(from, { recursive: true, force: true });
        moved++;
      } catch (e2) {
        /* 这一个搬不动就算了，继续下一个 */
      }
    }
  }

  try {
    if (fs.readdirSync(oldDir).length === 0) fs.rmdirSync(oldDir);
  } catch (e) { /* 被占用就留着 */ }

  console.log('[app] migrated ' + moved + ' item(s): ' + oldName + ' -> ' + newName);
}

/** 手写递归复制。**不用 fs.cpSync**：在某些沙箱环境里它会静默杀掉进程（无异常、exit 127）。 */
function copyTree(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src)) copyTree(path.join(src, e), path.join(dest, e));
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// 收掉上面说的空壳目录。★ 守卫从严：**只删确实是空的、且不是当前生效的那个**。
// 只要里面有任何东西（哪怕是用户自己放的），一律保留不动。
// 现在 DATA_DIR_NAME 与 package.json 的 name 同名，两个路径相同 → 这段自然不会执行。
if (defaultUserDataDir && defaultUserDataDir !== app.getPath('userData')) {
  try {
    if (fs.existsSync(defaultUserDataDir) && fs.readdirSync(defaultUserDataDir).length === 0) {
      fs.rmdirSync(defaultUserDataDir);
    }
  } catch (e) {
    /* 被占用就留着，不影响功能 */
  }
}

/**
 * 自动化模式：设了 BD_SCREENSHOT（截图自检）时视为无人值守运行。
 *
 * ★ 为什么需要它：调试/自检时**不能在用户屏幕上闪出任何窗口**。
 *   以前窗口无条件 `show()`，导致每跑一次截图自检就弹一次主窗口；
 *   若用户自己正开着程序，还会触发 second-instance 把用户那扇窗也顶到最前。
 *   现在自动化模式下：窗口不建托盘、不抢单实例锁、且 skipTaskbar + focusable:false。
 *   只有截图前那一瞬会 `showInactive()` 到 (-4000,-4000) —— 必须在屏幕外**真实显示**
 *   过，Chromium 才会为新内容产帧，否则会截到旧帧/空白（见下方截图那段注释）。
 */
const AUTOMATION = !!process.env.BD_SCREENSHOT;

/** 需要在调试时看到"谁想开新窗口"就设 BD_WINDOWS_DEBUG=1 */
const WIN_DEBUG = !!process.env.BD_WINDOWS_DEBUG;

// ---------------------------------------------------------------- 窗口兜底策略
// 程序里只有两种窗口：主界面 + 解析用的隐藏窗口（见 douyin.js）。
// 其余任何新窗口都视为"意外弹出"，一律拒绝。
//
// ★ 背景：解析抖音时加载的是抖音自己的页面，它会（在登录引导、活动弹窗、
//   外链跳转等场景）调用 window.open。若不拦截，Chromium 会真的开一个**可见**
//   小窗口糊在用户脸上 —— 这正是"测试时经常弹出小窗口"的直接来源。
//   douyin.js 里对隐藏窗口单独设过一次，这里是**全局兜底**：
//   任何 webContents（包括以后新增的）都不可能再冒出窗口。
app.on('web-contents-created', (_e, wc) => {
  try {
    wc.setWindowOpenHandler((details) => {
      if (WIN_DEBUG) {
        console.log('[windows] denied popup: ' + String((details && details.url) || '').slice(0, 160));
      }
      return { action: 'deny' };
    });
  } catch (e) {
    /* 某些类型的 webContents 不支持，忽略 */
  }
  try {
    wc.on('will-attach-webview', (e) => e.preventDefault());
  } catch (e) {
    /* ignore */
  }
});

// Windows 控制台默认是 GBK(936)，而 Node/Electron 向控制台写的是 UTF-8 字节，
// 中文日志会被按 GBK 解码成乱码。这里把当前控制台切成 UTF-8（只影响本程序所在窗口）。
if (process.platform === 'win32' && process.stdout && process.stdout.isTTY) {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore', windowsHide: true });
  } catch (e) {
    /* 没有控制台或不支持时忽略，不影响运行 */
  }
}

/**
 * 目录是否可写 —— 用来挑日志落盘位置。探测文件写进去再删掉，删不掉也不算失败。
 */
function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    try { fs.unlinkSync(probe); } catch (_) { /* 删不掉无妨 */ }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 日志落在哪儿 —— **跟着程序走，不往 C 盘塞**。
 *   1. 打包后：<exe 同级目录>\logs\app.log —— 绿色版/便携版就一个文件夹，日志一眼能找到，
 *      用户「把日志发回来」只需在程序目录里找，不用去 %APPDATA% 翻。
 *   2. 开发态（源码直接跑）：项目根目录\logs\app.log（没有"exe 同级目录"这一说）。
 *   3. 上面那个目录不可写（例如整个程序装在 Program Files、只读介质、U 盘写保护）→
 *      回退到 userData，保证任何环境下都还有日志，绝不因目录不可写而丢日志。
 */
function resolveLogBaseDir() {
  let preferred = '';
  try {
    preferred = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..', '..');
  } catch (_) {
    preferred = '';
  }
  if (preferred && isWritableDir(preferred)) return preferred;
  console.warn('[log] program dir not writable, falling back to userData');
  return app.getPath('userData');
}

/**
 * 确定用户数据目录（须在 app ready 之前完成）。
 * 优先用系统默认位置；若因权限等原因不可写，则自动回退到程序目录下的 data/，
 * 保证在受限环境下依然能启动。
 */
(function resolveUserDataDir() {
  const defaultDir = app.getPath('userData');
  const candidates = process.env.BD_USERDATA
    ? [process.env.BD_USERDATA]
    : [defaultDir, path.join(__dirname, '..', '..', 'data')];

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      if (dir !== defaultDir) {
        app.setPath('userData', dir);
        app.setPath('cache', path.join(dir, 'Cache'));
        // userData 换地方了，日志不用跟着走 —— 日志现在落在「程序同级目录」，
        // 与 userData 无关（只有程序目录不可写的回退分支才用 userData，见 resolveLogBaseDir）。
        console.log('[config] user data dir switched to: ' + dir);
      }
      return;
    } catch (e) {
      console.warn('[config] dir not writable, trying next: ' + dir + ' (' + e.message + ')');
    }
  }
  console.error('[config] no writable user-data dir; settings may not persist.');
})();

// 日志落盘（<程序同级目录>/logs/app.log）——出问题时用户把这个文件发回来即可定位。
// 放在 userData 定好之后；任何失败都不影响启动。
try {
  logger.init(resolveLogBaseDir());
} catch (_) {
  /* ignore */
}

let win = null;
let tray = null;
let ariaProc = null;
let ariaPort = 0;
let ariaRestarts = 0;
let config = null;
let bili = null;
let douyin = null;
let downloader = null;
let quitting = false;
let clipTimer = null;
let lastClip = '';
let shutdownTimer = null;

// ================================================================ 工具

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

// ================================================================ aria2

function startAria2(port) {
  const exe = getBin('aria2c.exe');
  const conf = getBin('aria2c.conf');
  if (!fs.existsSync(exe)) {
    throw new Error('aria2c.exe not found: ' + exe);
  }

  ariaProc = spawn(
    exe,
    [`--rpc-listen-port=${port}`, `--conf-path=${conf}`, `--rpc-secret=${ARIA_SECRET}`],
    // aria2 的日志走 RPC 读取，stdio 置为 ignore：既不污染控制台，也避免管道写满导致下载卡死
    { cwd: getBinDir(), windowsHide: true, stdio: 'ignore' }
  );

  ariaProc.on('error', (e) => {
    console.error('[aria2] failed to start: ' + e.message);
    send('aria2-status', { ok: false, message: e.message });
  });

  ariaProc.on('exit', (code) => {
    ariaProc = null;
    if (quitting) return;
    if (ariaRestarts < 3) {
      ariaRestarts++;
      console.warn('[aria2] exited unexpectedly (code=' + code + '), restarting #' + ariaRestarts + ' ...');
      setTimeout(() => {
        try {
          startAria2(ariaPort);
          waitAriaReady(ariaPort).then(() => {
            downloader.attachAria(ariaPort, ARIA_SECRET);
            send('aria2-status', { ok: true, message: '下载进程已重启' });
          });
        } catch (e) {
          send('aria2-status', { ok: false, message: '重启失败：' + e.message });
        }
      }, 800);
    } else {
      send('aria2-status', { ok: false, message: '下载进程反复退出，请重启软件' });
    }
  });
}

async function waitAriaReady(port, timeoutMs = 15000) {
  const aria = new Aria2(port, ARIA_SECRET);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await aria.getVersion();
      return true;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('aria2 RPC not ready within timeout');
}

// ================================================================ 窗口

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 1020,
    minHeight: 640,
    frame: false,
    show: false,
    // 自动化模式（截图自检）下：截屏前会把窗口挪到屏幕外显示一下，
    // 这两项保证它既不进任务栏也不抢焦点。
    skipTaskbar: AUTOMATION,
    focusable: !AUTOMATION,
    backgroundColor: '#f4f6fb',
    title: APP_NAME,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (AUTOMATION) {
    // 自动化模式：窗口保持隐藏。capturePage() 对隐藏窗口同样有效
    //（依赖 paintWhenInitiallyHidden，Electron 默认开启）。
    // 但隐藏窗口的渲染进程会被降频，可能截到半成品，所以显式关掉节流。
    try {
      win.webContents.setBackgroundThrottling(false);
    } catch (e) {
      /* ignore */
    }
  } else {
    win.once('ready-to-show', () => win.show());
  }

  // 调试用：设置 BD_SCREENSHOT=<路径> 启动，界面渲染完成后截图并退出
  //        可配合 BD_SHOT_JS 在执行截图前注入一段脚本（用于切换页面等）
  if (process.env.BD_SCREENSHOT) {
    // 调试：把渲染进程的控制台输出转发到主进程控制台，便于定位前端报错
    win.webContents.on('console-message', (...a) => {
      const d = a[0] && a[0].message !== undefined ? a[0] : { message: a[2], lineNumber: a[3], sourceId: a[4] };
      console.log('[renderer] ' + (d.sourceId || '') + ':' + (d.lineNumber || 0) + ' ' + d.message);
    });
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          // ★ 截图前把窗口「显示」出来，但要挪到屏幕外 —— 不能只靠 show:false。
          //   原因：隐藏窗口不出新帧，`capturePage()` 拿到的可能是入场那一刻的旧帧，
          //   于是"注入脚本明明切换成功、截出来却是空白/旧页面"（2026-10-09 踩过）。
          //   挪到 (-4000,-4000) 后 Chromium 正常产帧，而人眼完全看不到：
          //   该窗口在自动化模式下还设了 skipTaskbar + focusable:false，
          //   连任务栏都不会出现，也不会抢焦点。
          const b = win.getBounds();
          win.setBounds({ x: -4000, y: -4000, width: b.width, height: b.height });
          win.showInactive();
          await new Promise((r) => setTimeout(r, 600));

          if (process.env.BD_SHOT_JS) {
            try {
              // 注入脚本可以直接写在环境变量里；脚本较长（或含引号）时，
              // 用 BD_SHOT_JS=@脚本文件路径 从文件读取，省得跟 bat 的转义较劲。
              let code = process.env.BD_SHOT_JS;
              if (code.startsWith('@')) {
                code = fs.readFileSync(code.slice(1), 'utf8');
                console.log('[screenshot] inject script loaded from file: ' + process.env.BD_SHOT_JS.slice(1));
              }
              const injected = await win.webContents.executeJavaScript(code);
              if (injected !== undefined) console.log('[screenshot] inject result: ' + injected);
            } catch (e) {
              console.error('[screenshot] inject script failed: ' + e.message);
            }
            await new Promise((r) => setTimeout(r, 900));
          }
          // ★ 截断 CSS 动画/过渡。隐藏窗口不出帧，入场动画会僵在**第一帧**上；
          //   `.tab-panel` 的 fade 恰好是 opacity:0 起步，于是出现
          //   "面板明明是 active、截出来却整片空白"（2026-10-09 踩过）。
          //   注意要用 executeJavaScript 插 <style>：webContents.insertCSS 在
          //   隐藏窗口下实测不生效（不报错，但样式没进去）。
          try {
            const r = await win.webContents.executeJavaScript(
              '(function(){var s=document.createElement("style");' +
                's.textContent=".tab-panel{animation:none !important}"+' +
                '"*{animation:none !important;transition:none !important}";' +
                'document.head.appendChild(s);return "anim-off";})()'
            );
            console.log('[screenshot] ' + r);
          } catch (e) {
            console.error('[screenshot] kill-animation failed: ' + e.message);
          }
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.BD_SCREENSHOT, img.toPNG());
          console.log('[screenshot] saved: ' + process.env.BD_SCREENSHOT);
        } catch (e) {
          console.error('[screenshot] failed: ' + e.message);
        }
        quitting = true;
        app.quit();
      }, 2500);
    });
  }

  win.on('close', (e) => {
    if (!quitting && config && config.get('minToTray')) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

function createTray() {
  let img = nativeImage.createEmpty();
  try {
    if (fs.existsSync(ICON)) img = nativeImage.createFromPath(ICON);
  } catch (e) {
    /* ignore */
  }

  try {
    tray = new Tray(img);
  } catch (e) {
    console.warn('[tray] failed to create tray: ' + e.message);
    return;
  }

  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示主界面',
        click: () => {
          if (win) {
            win.show();
            win.focus();
          }
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('double-click', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
}

// ================================================================ 剪切板

function startClipWatcher() {
  if (clipTimer) clearInterval(clipTimer);
  clipTimer = setInterval(() => {
    try {
      if (!config || !config.get('clipWatch')) return;
      const text = clipboard.readText();
      if (!text || text === lastClip) return;
      // B站：域名 / BV 号；抖音：域名特征或 15 位以上纯数字 ID
      if (
        /bilibili\.com|b23\.tv|bili2233|BV[0-9A-Za-z]{10}/.test(text) ||
        detectPlatform(text) === 'douyin'
      ) {
        lastClip = text;
        send('clipboard-link', text.trim().slice(0, 500));
      }
    } catch (e) {
      /* ignore */
    }
  }, 1200);
}

// ================================================================ 关机

function scheduleShutdown() {
  if (shutdownTimer) clearTimeout(shutdownTimer);
  shutdownTimer = setTimeout(() => {
    shutdownTimer = null;
    exec('shutdown /s /t 0', (err) => {
      if (err) send('shutdown-result', { ok: false, message: err.message });
    });
  }, 30000);
  return 30;
}

function cancelShutdown() {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
    return true;
  }
  return false;
}

// ================================================================ 启动体检

/** 最近一次体检结果（渲染进程可用 app:health 主动拉取，避免错过启动时的推送） */
let healthState = null;

/**
 * 后台跑一次接口体检，只在「接口疑似变更」时打扰用户。
 *
 * 静默的条件（都不提示）：
 *   - 一切正常
 *   - 断网 / 超时 / DNS 失败（用户自己的网络问题，不是软件坏了）
 * 只有「接口有响应但内容不符合预期」才判定为变更并弹提示条。
 */
/**
 * 实际跑一遍体检，并把结果落地（含把「疑似变更」推给界面）。
 * 启动后台任务与界面上的「重新检测」按钮共用这一份逻辑。
 */
async function doHealthCheck() {
  if (!bili) return null;
  // 把失败项拍平成一行文本，用于落盘（控制台只打 ASCII 的 key，避免乱码）
  const dump = (arr) =>
    (arr || []).map((f) => `${f.key}${f.detail ? ' → ' + f.detail : ''}`).join(' ; ') || '-';
  try {
    const timeout = new Promise((r) => setTimeout(() => r({ kind: 'timeout', failed: [], netFailed: [] }), 30000));
    const res = await Promise.race([bili.healthCheck(), timeout]);
    res.logFile = logger.getLogFile(); // 让界面上能告诉用户「详情写进了哪个文件」
    res.build = BUILD_INFO;
    healthState = res;
    // ★ 无论结论如何都落盘：这样下次用户说「又弹条了」，直接看日志就能定位到具体环节与错误
    logger.log('health', `kind=${res.kind} failed=[${dump(res.failed)}] netFailed=[${dump(res.netFailed)}]`);
    if (res.kind === 'changed') {
      console.log('[health] interface mismatch: ' + (res.failed || []).map((f) => f.key).join(' | '));
      send('health', res);
    } else {
      console.log('[health] ' + res.kind);
    }
    return res;
  } catch (e) {
    logger.log('health', 'probe error: ' + (e && e.message));
    console.error('[health] probe error: ' + e.message);
    return null;
  }
}

function runHealthCheck() {
  if (process.env.BD_NO_HEALTH) {
    console.log('[health] disabled by BD_NO_HEALTH');
    return;
  }
  const DELAY = 6000; // 错开启动高峰，别和界面首屏抢资源
  setTimeout(() => {
    doHealthCheck();
  }, DELAY);
}

// ================================================================ IPC

function registerIpc() {
  // ---- 状态 ----
  ipcMain.handle('app:getState', async () => {
    let user = { isLogin: false };
    try {
      user = await bili.userInfo();
    } catch (e) {
      /* 离线时静默 */
    }
    return {
      version: app.getVersion(),
      build: BUILD_INFO,
      logFile: logger.getLogFile(),
      platform: process.platform,
      config: config.all(),
      user,
      tasks: downloader.snapshot(),
      nameVars: NAME_VARS,
      ariaPort,
      packages: { electron: process.versions.electron, node: process.versions.node },
    };
  });

  // ---- 解析 ----
  // 按平台分流：抖音走浏览器抓取（见 douyin.js 顶部注释），B站 走签名 API。
  // 两条路都归一到同样的 media 结构，下游下载逻辑不必关心来源。
  ipcMain.handle('app:resolve', async (_e, input) => {
    const platform = detectPlatform(input);
    if (platform === 'douyin') {
      if (!douyin) throw new Error('抖音解析模块未初始化');
      console.log('[resolve] douyin input=' + String(input).slice(0, 60));
      return douyin.resolve(input);
    }
    return resolveLink(bili, input);
  });

  ipcMain.handle('app:preview', async (_e, { bvid, cid }) => {
    const playData = await bili.playurl(bvid, cid, 127);
    const { videos, audios } = extractStreams(playData);
    return {
      videos,
      audios,
      timelength: playData.timelength || 0,
      acceptQuality: playData.accept_quality || [],
      acceptDesc: playData.accept_description || [],
      durationText: humanSize(0),
    };
  });

  // ---- 账号 ----
  ipcMain.handle('app:qrGenerate', async () => {
    const r = await bili.loginQrGenerate();
    let qrDataUrl = '';
    try {
      const QRCode = require('qrcode');
      qrDataUrl = await QRCode.toDataURL(r.url, {
        width: 400,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#1f2430', light: '#ffffff' },
      });
    } catch (e) {
      console.error('[qr] failed to render QR image: ' + e.message);
    }
    return { url: r.url, qrcodeKey: r.qrcodeKey, qrDataUrl };
  });

  ipcMain.handle('app:qrPoll', async (_e, key) => {
    const r = await bili.loginQrPoll(key);
    if (r.state === 'success') {
      try {
        const u = await bili.userInfo();
        send('user-changed', u);
      } catch (e) {
        /* ignore */
      }
    }
    return r;
  });

  ipcMain.handle('app:userInfo', async () => bili.userInfo());

  ipcMain.handle('app:logout', async () => {
    await bili.logout();
    send('user-changed', { isLogin: false });
    return { ok: true };
  });

  // ---- 任务 ----
  ipcMain.handle('app:addTasks', async (_e, { media, sel }) => {
    const tasks = buildTasks(media, config.all(), sel);
    downloader.addTasks(tasks);
    return { ok: true, count: tasks.length, ids: tasks.map((t) => t.id) };
  });

  ipcMain.handle('app:tasks', async () => downloader.snapshot());

  ipcMain.handle('app:taskAction', async (_e, { action, id }) => {
    switch (action) {
      case 'pause':
        await downloader.pauseTask(id);
        break;
      case 'resume':
        await downloader.resumeTask(id);
        break;
      case 'cancel':
        await downloader.cancelTask(id);
        break;
      case 'remove':
        return { ok: downloader.removeTask(id) };
      case 'openFolder': {
        const t = downloader.find(id);
        if (t && t.dir) shell.openPath(t.dir);
        else if (t) shell.openPath(t.root);
        break;
      }
      case 'openFile': {
        const t = downloader.find(id);
        if (t && t.outFile && fs.existsSync(t.outFile)) shell.openPath(t.outFile);
        break;
      }
      case 'copyLink': {
        const t = downloader.find(id);
        if (t) {
          clipboard.writeText(
            t.platform === 'douyin'
              ? t.sourceUrl || api.douyin.urls.videoPage + t.awemeId
              : api.urls.videoPage + t.bvid
          );
        }
        break;
      }
      default:
        return { ok: false, message: '未知操作' };
    }
    return { ok: true };
  });

  ipcMain.handle('app:allAction', async (_e, action) => {
    switch (action) {
      case 'pauseAll':
        await downloader.pauseAll();
        break;
      case 'resumeAll':
        await downloader.resumeAll();
        break;
      case 'clearFinished':
        await downloader.clearFinished();
        break;
      default:
        return { ok: false };
    }
    return { ok: true };
  });

  // ---- 配置 ----
  ipcMain.handle('app:getConfig', async () => config.all());
  ipcMain.handle('app:setConfig', async (_e, patch) => {
    config.patch(patch || {});
    return config.all();
  });
  // 恢复默认设置（保留下载记录），返回重置后的完整配置供渲染层重绘
  ipcMain.handle('app:resetConfig', async () => config.reset());
  ipcMain.handle('app:nameVars', async () => NAME_VARS);

  // ---- 记录 ----
  ipcMain.handle('app:history', async () => config.get('history') || []);
  ipcMain.handle('app:clearHistory', async () => {
    config.clearHistory();
    return { ok: true };
  });

  // ---- 系统 ----
  ipcMain.handle('app:selectDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('app:selectFile', async (_e, opts = {}) => {
    const filters = opts.filters || [{ name: '所有文件', extensions: ['*'] }];
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('app:openFolder', async (_e, p) => {
    if (!p) return { ok: false };
    if (fs.existsSync(p)) {
      shell.openPath(p);
      return { ok: true };
    }
    return { ok: false, message: '路径不存在' };
  });

  ipcMain.handle('app:openPath', async (_e, p) => {
    if (p && fs.existsSync(p)) shell.openPath(p);
    return { ok: true };
  });

  ipcMain.handle('app:openExternal', async (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('app:copyText', async (_e, text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return true;
  });

  // 右键菜单里的「剪切/复制/粘贴/全选」——作用于当前聚焦的可编辑元素。
  // Electron 默认不弹系统右键菜单，必须由渲染进程发起、主进程执行。
  ipcMain.handle('app:editAction', async (e, action) => {
    const wc = e.sender;
    try {
      if (action === 'cut') wc.cut();
      else if (action === 'copy') wc.copy();
      else if (action === 'paste') wc.paste();
      else if (action === 'selectAll') wc.selectAll();
      else if (action === 'undo') wc.undo();
      else if (action === 'redo') wc.redo();
      else return { ok: false, message: 'unknown action: ' + action };
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  ipcMain.handle('app:health', async () => healthState);
  // 界面上的「重新检测」：忽略启动延迟与 BD_NO_HEALTH，当场重跑一次
  ipcMain.handle('app:healthCheck', async () => (await doHealthCheck()) || healthState);

  ipcMain.handle('app:restartAria2', async () => {
    try {
      if (ariaProc) ariaProc.kill();
      ariaRestarts = 0;
      ariaPort = await getFreePort();
      startAria2(ariaPort);
      await waitAriaReady(ariaPort);
      downloader.attachAria(ariaPort, ARIA_SECRET);
      return { ok: true, port: ariaPort };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('app:ariaStatus', async () => {
    if (!downloader.aria) return { ok: false };
    try {
      const v = await downloader.aria.getVersion();
      return { ok: true, version: v.version, port: ariaPort };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('app:cancelShutdown', async () => {
    const ok = cancelShutdown();
    send('shutdown-canceled', { ok });
    return { ok };
  });

  // ---- 工具箱 ----
  ipcMain.handle('app:toolConvertMp3', async (_e, file) => {
    try {
      const out = await downloader.convertToMp3(file, (p) => send('tool-progress', { type: 'mp3', ...p }));
      return { ok: true, out };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('app:toolMerge', async (_e, { video, audio, outDir }) => {
    try {
      const out = await downloader.manualMerge(video, audio, outDir, (p) =>
        send('tool-progress', { type: 'merge', ...p })
      );
      return { ok: true, out };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  // ---- 窗口 ----
  ipcMain.handle('win:min', () => win && win.minimize());
  ipcMain.handle('win:max', () => {
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('win:close', () => {
    if (!win) return;
    if (config.get('minToTray')) win.hide();
    else {
      quitting = true;
      app.quit();
    }
  });
  ipcMain.handle('win:isMax', () => (win ? win.isMaximized() : false));
}

// ================================================================ 启动

async function bootstrap() {
  config = new Config();
  // 日志第一行：包身份 + 运行环境（排查「到底跑的哪个包」全靠它）
  logger.log(
    'app',
    `start version=${app.getVersion()} build=${BUILD_INFO.stamp || 'dev'}` +
      (BUILD_INFO.builtAt ? ` builtAt=${BUILD_INFO.builtAt}` : '') +
      ` electron=${process.versions.electron} node=${process.versions.node}` +
      ` platform=${process.platform} portable=${process.env.PORTABLE_EXECUTABLE_DIR ? 'yes' : 'no'}`
  );
  bili = new BiliClient(session.defaultSession);
  douyin = new DouyinClient();
  downloader = new Downloader({ bili, douyin, config });

  // 下载器事件 → 渲染进程
  downloader.on('update', (tasks) => send('tasks-update', tasks));
  downloader.on('task-done', (d) => send('task-done', d));
  downloader.on('task-error', (d) => {
    // 任务级失败也落盘：界面上只显示一句概括，事后靠日志才查得出真因
    logger.log(
      'task',
      `error platform=${(d && d.platform) || ''} title=${(d && d.title) || ''} err=${(d && d.error) || ''}`
    );
    // 抖音失败时丢掉详情缓存 —— 直链带时效签名，失败多半就是它过期了，
    // 下次重新解析必须拿到新签名，否则会一直复用同一条死链（"重试也没用"）。
    if (douyin && d && d.awemeId) douyin.invalidate(d.awemeId);
    send('task-error', d);
  });
  downloader.on('extras-warn', (d) => send('extras-warn', d));
  downloader.on('all-finished', (d) => {
    send('all-finished', d);
    if (config.get('autoShutdown') && d.total > 0) {
      const sec = scheduleShutdown();
      send('auto-shutdown', { seconds: sec });
    }
  });

  // 启动 aria2
  try {
    ariaPort = await getFreePort();
    startAria2(ariaPort);
    await waitAriaReady(ariaPort);
    downloader.attachAria(ariaPort, ARIA_SECRET);
    console.log(`[aria2] RPC ready on 127.0.0.1:${ariaPort}`);
  } catch (e) {
    console.error('[aria2] init failed: ' + e.message);
  }

  registerIpc();
  createWindow();
  // 自动化模式下不建托盘：自检应该在托盘区也悄无声息
  if (!AUTOMATION) createTray();
  startClipWatcher();
  runHealthCheck();
}

// 单实例
// 自动化模式直接跳过单实例锁：否则用户正开着程序时，自检进程会因抢锁失败而退出，
// 并把用户那扇窗 show/focus 到最前 —— 那正是"测试时乱弹窗"的观感来源之一。
const gotLock = AUTOMATION ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 自动化模式下永远不显示窗口（理论上也不会走到这里，兜底而已）
    if (win && !AUTOMATION) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(bootstrap);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    if (!config || !config.get('minToTray')) {
      quitting = true;
      app.quit();
    }
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('will-quit', () => {
    quitting = true;
    if (clipTimer) clearInterval(clipTimer);
    // 抖音解析用的隐藏窗口必须显式销毁，否则它会让 window-all-closed 永不触发
    if (douyin) {
      try {
        douyin.destroy();
      } catch (e) {
        /* ignore */
      }
    }
    if (ariaProc) {
      try {
        ariaProc.kill();
      } catch (e) {
        /* ignore */
      }
    }
  });
}
