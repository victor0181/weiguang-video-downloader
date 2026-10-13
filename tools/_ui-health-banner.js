'use strict';

/**
 * _ui-health-banner.js —— 自检「B站接口可能已变更」预警条。
 *
 * 跑法：
 *   NODE_PATH=C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules
 *   node tools/_ui-health-banner.js
 *
 * 背景（2026-10-12）：用户反馈最新版一启动就看到「B站接口可能已变更」横幅，
 *   实测接口全部正常 —— 是体检判定过于敏感导致的误报。加固后：
 *   ① 环境类错误（风控 / 非 JSON / 5xx）静默；② 失败环节要连续两轮失败才算数。
 *   同时给横幅加了「重新检测」按钮，用户可当场复检。
 *
 * 验证点：
 *   1. 启动态：横幅默认隐藏
 *   2. 收到 kind='changed' 推送 → 横幅显示，且写明失败环节
 *   3. 「查看修复指引」可展开/收起
 *   4. 「重新检测」点击 → 调用 healthCheck，返回 ok 时横幅自动收起
 *   5. 「关闭」按钮可隐藏
 *   6. 全程无 JS 报错
 */

const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const HTML = 'file:///' + path.join(ROOT, 'src', 'renderer', 'index.html').replace(/\\/g, '/');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const CONFIG = {
  savePath: 'D:/下载', videoQn: 80, audioQn: 30280, concurrency: 3, audioFormat: 'm4a',
};

function injectStub() {
  const f = () => Promise.resolve({});
  const state = {
    config: __CONFIG__,
    user: { isLogin: false, name: '', vip: '' },
    nameVars: [], tasks: [], version: '1.0.0', platform: 'win32',
    packages: { electron: '33.0.0', node: '20.0.0' },
  };
  const explicit = {
    getState: () => Promise.resolve(state),
    health: () => Promise.resolve(null),
    // 「重新检测」按钮打到的主进程接口：这里固定回「一切正常」
    healthCheck: () =>
      Promise.resolve({ ok: true, kind: 'ok', failed: [], netFailed: [], checkedAt: Date.now() }),
    on: () => () => {},
    win: { min: f, max: f, close: f, isMax: () => Promise.resolve(false) },
  };
  window.bd = new Proxy(explicit, {
    get(t, k) {
      if (k === 'then' || k === 'toJSON' || typeof k === 'symbol') return undefined;
      if (k in t) return t[k];
      return f;
    },
  });
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--font-render-hinting=none'],
    defaultViewport: { width: 1120, height: 700, deviceScaleFactor: 2 },
  });

  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

  const stubSrc = ('(' + injectStub.toString() + ')();').replace('__CONFIG__', JSON.stringify(CONFIG));
  await page.evaluateOnNewDocument(stubSrc);

  await page.goto(HTML, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 600));

  const results = [];
  const check = (name, ok, detail) =>
    results.push((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  → ' + detail : ''));
  const isHidden = () => page.evaluate(() => document.getElementById('healthBanner').classList.contains('hidden'));

  // 1) 启动态默认隐藏
  check('启动态横幅默认隐藏', (await isHidden()) === true);

  // 2) 收到变更推送 → 显示 + 写明环节 + 带出具体错误 / 日志路径
  await page.evaluate(() => {
    renderHealthBanner({
      ok: false,
      kind: 'changed',
      checkedAt: Date.now(),
      failed: [{ name: '播放地址 playurl', key: 'urls.playurl / playurlParams', detail: '未返回 dash 音视频轨' }],
      netFailed: [],
      logFile: 'C:\\Users\\x\\AppData\\Roaming\\video-downloader\\logs\\app.log',
      build: { version: '1.1.1', builtAt: '2026-10-12 20:40', stamp: 'v1.1.1-20261012-2040' },
    });
  });
  const shown = await page.evaluate(() => {
    const el = document.getElementById('healthBanner');
    return {
      hidden: el.classList.contains('hidden'),
      sub: (document.querySelector('.js-health-detail') || {}).textContent || '',
      detail: (document.getElementById('healthGuideDetail') || {}).textContent || '',
      logpath: (document.getElementById('healthLogPath') || {}).textContent || '',
    };
  });
  check('kind=changed 时横幅显示', shown.hidden === false);
  check('横幅写明失败环节', shown.sub.indexOf('播放地址 playurl') >= 0, shown.sub);
  check('横幅带出具体错误', shown.sub.indexOf('未返回 dash 音视频轨') >= 0, shown.sub);
  check('指引里列出失败明细', shown.detail.indexOf('urls.playurl') >= 0 && shown.detail.indexOf('dash') >= 0);
  check('指引里给出日志路径', shown.logpath.indexOf('app.log') >= 0, shown.logpath);

  await page.screenshot({ path: path.join(ROOT, 'tools', '_ui-health-banner.png') });

  // 2.5) 复制诊断信息（stub 剪贴板，检查打包出来的文本内容）
  await page.evaluate(() => {
    window.__copied = '';
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (t) => {
            window.__copied = t;
          },
        },
      });
    } catch (_) {
      /* 下面的断言会体现失败 */
    }
  });
  await page.click('#healthCopy');
  await new Promise((r) => setTimeout(r, 300));
  const copied = await page.evaluate(() => window.__copied || '');
  check('「复制诊断信息」按钮存在', (await page.evaluate(() => !!document.getElementById('healthCopy'))) === true);
  check('复制内容含结论与失败环节', copied.indexOf('接口体检诊断') >= 0 && copied.indexOf('urls.playurl') >= 0, copied.slice(0, 80));

  // 3) 修复指引展开/收起
  await page.click('#healthGuide');
  const guideOpen = await page.evaluate(() => !document.getElementById('healthGuideBody').classList.contains('hidden'));
  await page.click('#healthGuide');
  const guideClosed = await page.evaluate(() => document.getElementById('healthGuideBody').classList.contains('hidden'));
  check('「查看修复指引」可展开/收起', guideOpen && guideClosed);

  // 4) 重新检测（stub 回 ok）→ 横幅自动收起
  const hasBtn = await page.evaluate(() => !!document.getElementById('healthRecheck'));
  check('「重新检测」按钮存在', hasBtn === true);
  if (hasBtn) {
    await page.click('#healthRecheck');
    await new Promise((r) => setTimeout(r, 400));
    check('重新检测通过后横幅收起', (await isHidden()) === true);
    const btnRestored = await page.evaluate(() => {
      const b = document.getElementById('healthRecheck');
      return !b.disabled && b.textContent === '重新检测';
    });
    check('检测后按钮恢复可用', btnRestored === true);
  }

  // 5) 关闭按钮
  await page.evaluate(() => renderHealthBanner({ ok: false, kind: 'changed', failed: [], netFailed: [] }));
  await page.click('#healthClose');
  check('「关闭」按钮可隐藏横幅', (await isHidden()) === true);

  await browser.close();

  console.log('== 接口变更预警条自检 ==');
  results.forEach((l) => console.log('  ' + l));
  console.log('== 页面 JS 报错 ==');
  console.log(errors.length ? '  ' + errors.join('\n  ') : '  无');
  process.exitCode = results.some((l) => l.startsWith('FAIL')) || errors.length ? 1 : 0;
})();
