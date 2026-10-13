'use strict';

/**
 * _ui-clear-btn.js —— 自检「解析输入框的清空小叉」。
 *
 * 跑法：
 *   NODE_PATH=C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules
 *   node tools/_ui-clear-btn.js
 *
 * 验证点：
 *   1. 输入框为空 → 小叉隐藏
 *   2. 输入内容 → 小叉出现
 *   3. 点击小叉 → 输入框清空、小叉隐藏、焦点回到输入框
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const HTML = 'file:///' + path.join(ROOT, 'src', 'renderer', 'index.html').replace(/\\/g, '/');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const CONFIG = {
  savePath: 'D:/下载', videoQn: 80, audioQn: 30280, concurrency: 3,
  audioFormat: 'mp3', nameVars: [], saveCover: true, saveDanmaku: false,
  saveSubtitle: false, saveNfo: false, autoShutdown: false, shutdownDelay: 60,
  theme: 'light', userAgent: '', cookie: '', downloadProxy: '', ariaRpc: '',
  split: 8, maxConnection: 8, minSplitSize: '15M', retry: 3, timeout: 30,
  fontSize: 14, accent: '', maxConcurrentTasks: 3,
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
    defaultViewport: { width: 1120, height: 940, deviceScaleFactor: 2 },
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
  const check = (name, ok) => results.push((ok ? 'PASS' : 'FAIL') + '  ' + name);

  // 1) 初始为空 → 小叉隐藏
  let st = await page.evaluate(() => ({
    hidden: document.getElementById('btnClearInput').classList.contains('hidden'),
  }));
  check('初始为空时小叉隐藏', st.hidden === true);

  // 2) 输入内容 → 小叉出现
  await page.click('#parseInput');
  await page.type('#parseInput', 'https://www.bilibili.com/video/BV1xx411c7mD');
  st = await page.evaluate(() => ({
    hidden: document.getElementById('btnClearInput').classList.contains('hidden'),
    val: document.getElementById('parseInput').value.length,
  }));
  check('输入内容后小叉显示', st.hidden === false && st.val > 0);

  fs.mkdirSync(path.join(ROOT, 'tools'), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, 'tools', '_ui-clear-btn.png') });

  // 3) 点击小叉 → 清空 + 隐藏 + 焦点在输入框
  await page.click('#btnClearInput');
  st = await page.evaluate(() => ({
    val: document.getElementById('parseInput').value,
    hidden: document.getElementById('btnClearInput').classList.contains('hidden'),
    focused: document.activeElement === document.getElementById('parseInput'),
  }));
  check('点击小叉后输入框被清空', st.val === '');
  check('清空后小叉重新隐藏', st.hidden === true);
  check('清空后焦点回到输入框', st.focused === true);

  await browser.close();

  console.log('== 清空小叉自检 ==');
  results.forEach((l) => console.log('  ' + l));
  console.log('== 页面 JS 报错 ==');
  console.log(errors.length ? '  ' + errors.join('\n  ') : '  无');
  process.exitCode = results.some((l) => l.startsWith('FAIL')) ? 1 : 0;
})();
