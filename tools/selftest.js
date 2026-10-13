// Windows 控制台默认 GBK(936)，Node/Electron 输出的是 UTF-8 字节，中文会显示成乱码。
// 先把当前控制台切成 UTF-8，保证中文标题/提示能正常显示。
if (process.platform === 'win32' && process.stdout && process.stdout.isTTY) {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore', windowsHide: true });
  } catch (e) {
    /* ignore */
  }
}

/**
 * selftest.js —— 端到端自检（在 Electron 环境下跑完整下载链路）
 *
 * 用法：
 *   electron.exe tools/selftest.js
 *
 * 流程：起 aria2 → 选一个时长较短的视频 → 解析 → 建任务 →
 *       aria2 下载 DASH 音视频 → ffmpeg 混流 → 校验产物
 *
 * 环境变量：
 *   BD_TEST_OUT   产物输出目录（默认 tools/_selftest_out）
 *   BD_TEST_TIMEOUT 整体超时秒数（默认 240）
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { app, session } = require('electron');

const SRC = path.join(__dirname, '..', 'src', 'main');
const { BiliClient } = require(path.join(SRC, 'bili'));
const { Config, getBin, getBinDir } = require(path.join(SRC, 'config'));
const { Downloader, buildTasks } = require(path.join(SRC, 'downloader'));
const { resolve: resolveLink } = require(path.join(SRC, 'resolver'));
const { Aria2 } = require(path.join(SRC, 'aria2'));

const ARIA_SECRET = 'video-downloader';
const OUT_DIR = process.env.BD_TEST_OUT || path.join(__dirname, '_selftest_out');
const TIMEOUT = Number(process.env.BD_TEST_TIMEOUT || 240) * 1000;

// ★ userData 隔离：不指定就跑在项目内的 tools/_bilitest_prof，避免污染
//   %APPDATA%\Electron —— 那是所有「没改过应用名」的 Electron 程序共用的默认目录，
//   混在一起既难排查也会互相顶掉缓存。外部用 BD_USERDATA 指定时以它为准
//   （语义与 main.js 里的同名变量一致，会在 app ready 之前生效）。
//   本测试不需要持久分区，所以不需要像 douyin-test.js 那样每次清空。
const PROFILE = process.env.BD_USERDATA || path.join(__dirname, '_bilitest_prof');
try {
  fs.mkdirSync(PROFILE, { recursive: true });
  app.setPath('userData', PROFILE);
} catch (e) {
  console.error('  [profile] set userData failed: ' + e.message);
}

let pass = 0;
let fail = 0;
const check = (label, cond, detail) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? '  → ' + detail : ''}`);
};

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

function waitAria(port, ms = 15000) {
  return new Promise(async (resolve, reject) => {
    const aria = new Aria2(port, ARIA_SECRET);
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        await aria.getVersion();
        return resolve();
      } catch (e) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    reject(new Error('aria2 未就绪'));
  });
}

app.whenReady().then(async () => {
  const started = Date.now();
  let ariaProc = null;

  const hardExit = setTimeout(() => {
    console.log('\n⏱  超时，强制结束。');
    process.exit(9);
  }, TIMEOUT);

  try {
    console.log('\n============ 视频下载器 端到端自检 ============\n');

    // ---------- 1. 准备环境 ----------
    console.log('[1] 启动 aria2');
    const port = await getFreePort();
    ariaProc = spawn(
      getBin('aria2c.exe'),
      [`--rpc-listen-port=${port}`, `--conf-path=${getBin('aria2c.conf')}`, `--rpc-secret=${ARIA_SECRET}`],
      { cwd: getBinDir(), windowsHide: true }
    );
    ariaProc.on('error', (e) => console.error('  aria2 启动错误：', e.message));
    await waitAria(port);
    check('aria2 RPC 就绪', true, 'port=' + port);

    // ---------- 2. 配置 ----------
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    // 清空上次产物
    for (const f of fs.readdirSync(OUT_DIR)) {
      fs.rmSync(path.join(OUT_DIR, f), { force: true, recursive: true });
    }

    const config = new Config();
    config.patch({
      savePath: OUT_DIR,
      videoQn: 32, // 480P，体积小，未登录即可获取
      audioQn: 30232,
      concurrency: 1,
      fileRule: '{title}',
      folderRule: '',
      saveCover: true,
      saveDanmaku: true,
      saveAss: true,
      saveSubtitle: false,
      saveNfo: true,
      keepVideo: false,
      keepAudio: false,
      autoShutdown: false,
    });
    check('配置写入', config.get('savePath') === OUT_DIR, OUT_DIR);

    // ---------- 3. 解析 ----------
    console.log('\n[2] 解析视频');
    const bili = new BiliClient(session.defaultSession);
    const pop = await (await bili._fetch('https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1')).json();
    const list = (pop.data && pop.data.list) || [];
    check('热门列表可达', list.length > 0, list.length + ' 条');

    // 选一个时长尽量短、非分P 的视频，控制测试耗时
    const cand = list
      .filter((v) => v.duration > 20 && v.duration < 600 && (!v.pages || v.pages.length === 1))
      .sort((a, b) => a.duration - b.duration)[0];
    if (!cand) throw new Error('找不到合适的测试视频');
    console.log(`      选用：${cand.bvid}  ${cand.duration}s  ${String(cand.title).slice(0, 30)}`);

    const media = await resolveLink(bili, cand.bvid);
    check('链接解析成功', !!media && media.parts.length > 0, `${media.type} / ${media.parts.length} 集`);
    console.log(`      标题：${media.title.slice(0, 40)}`);
    console.log(`      UP：${media.up.name}  时长：${media.duration}s`);

    // ---------- 4. 建任务 ----------
    console.log('\n[3] 构造任务');
    const tasks = buildTasks(media, config.all(), {
      parts: media.parts.map((p) => p.index),
      videoQn: 32,
      audioQn: 30232,
    });
    check('任务构造成功', tasks.length === 1, `${tasks.length} 个`);
    console.log(`      文件名：${tasks[0].fileName}.mp4`);

    // ---------- 5. 执行下载 ----------
    console.log('\n[4] 下载 + 混流（这一步最耗时，请稍候）');
    const downloader = new Downloader({ bili, config });
    downloader.attachAria(port, ARIA_SECRET);

    let lastPrint = '';
    downloader.on('update', (snap) => {
      const t = snap[0];
      if (!t) return;
      const line = `${t.status.padEnd(12)} ${String(t.progress).padStart(3)}%  ${t.speedText || ''}  ${t.totalText || ''}`;
      if (line !== lastPrint) {
        lastPrint = line;
        process.stdout.write('\r      ' + line.padEnd(70));
      }
    });
    downloader.on('extras-warn', (d) => console.log(`\n      ⚠ ${d.what}：${d.error}`));

    const finished = new Promise((resolve, reject) => {
      downloader.once('all-finished', resolve);
      const iv = setInterval(() => {
        const t = downloader.tasks[0];
        if (t && t.status === 'error') {
          clearInterval(iv);
          reject(new Error('任务失败：' + t.error));
        }
      }, 500);
    });

    downloader.addTasks(tasks);
    await finished;
    process.stdout.write('\n');

    const t = downloader.tasks[0];
    check('任务状态为已完成', t.status === 'done', t.status);

    // ---------- 6. 校验产物 ----------
    console.log('\n[5] 校验产物');
    const files = fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR) : [];
    console.log('      目录内容：' + (files.join(', ') || '(空)'));

    const mp4 = files.find((f) => f.endsWith('.mp4'));
    check('生成 MP4', !!mp4, mp4);

    if (mp4) {
      const full = path.join(OUT_DIR, mp4);
      const size = fs.statSync(full).size;
      check('MP4 体积合理（>50KB）', size > 50 * 1024, (size / 1024 / 1024).toFixed(2) + ' MB');

      // 用 ffmpeg 验证容器可解析
      await new Promise((resolve) => {
        const p = spawn(getBin('ffmpeg.exe'), ['-v', 'error', '-i', full, '-f', 'null', '-'], {
          windowsHide: true,
        });
        let err = '';
        p.stderr.on('data', (d) => (err += d.toString()));
        p.on('close', (code) => {
          check('ffmpeg 可正常解析该 MP4', code === 0 && !err.trim(), err.trim().slice(0, 120) || '无错误输出');
          resolve();
        });
      });

      // 检查是否同时含视频+音频轨（注意：不能用 -v quiet，否则 stream 信息一并被抑制）
      await new Promise((resolve) => {
        const p = spawn(getBin('ffmpeg.exe'), ['-hide_banner', '-i', full, '-f', 'null', '-'], {
          windowsHide: true,
        });
        let out = '';
        p.stderr.on('data', (d) => (out += d.toString()));
        p.on('close', () => {
          const hasV = /Stream #\d+:\d+.*Video:/.test(out);
          const hasA = /Stream #\d+:\d+.*Audio:/.test(out);
          check('包含视频轨', hasV);
          check('包含音频轨', hasA);
          const vline = (out.match(/Stream #\d+:\d+.*Video:[^\n]*/) || [''])[0].trim();
          const aline = (out.match(/Stream #\d+:\d+.*Audio:[^\n]*/) || [''])[0].trim();
          if (vline) console.log('      ' + vline.slice(0, 100));
          if (aline) console.log('      ' + aline.slice(0, 100));
          resolve();
        });
      });
    }

    // 附加内容
    if (config.get('saveCover')) check('保存封面', files.some((f) => f.endsWith('.jpg')));
    if (config.get('saveDanmaku')) check('保存弹幕 XML', files.some((f) => f.endsWith('.xml')));
    if (config.get('saveNfo')) check('保存 NFO', files.some((f) => f.endsWith('.nfo')));

    if (config.get('saveAss')) {
      const assFile = files.find((f) => f.endsWith('.ass'));
      check('保存弹幕 ASS', !!assFile);
      if (assFile) {
        const txt = fs.readFileSync(path.join(OUT_DIR, assFile), 'utf8');
        const dialogues = (txt.match(/^Dialogue:/gm) || []).length;
        check('ASS 含脚本头', txt.includes('[Script Info]') && txt.includes('[V4+ Styles]'));
        check('ASS 含弹幕事件行', dialogues > 0, dialogues + ' 行 Dialogue');
      }
    }

    if (config.get('saveSubtitle')) {
      const srt = files.find((f) => f.endsWith('.srt'));
      check('保存字幕 SRT', !!srt, srt || '（该视频可能无 CC 字幕）');
    }

    // 分片是否已清理
    check('临时分片已清理', !files.some((f) => f.includes('.m4s')));

    // 下载记录
    const his = config.get('history') || [];
    check('写入下载记录', his.length > 0, his.length + ' 条');

    console.log(`\n============ 结果：通过 ${pass}，失败 ${fail} ============`);
    console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒\n`);
  } catch (e) {
    console.log('\n❌ 自检异常：' + e.message);
    console.log(e.stack);
    fail++;
  } finally {
    clearTimeout(hardExit);
    if (ariaProc) {
      try {
        ariaProc.kill();
      } catch (e) {
        /* ignore */
      }
    }
    setTimeout(() => process.exit(fail > 0 ? 1 : 0), 500);
  }
});
