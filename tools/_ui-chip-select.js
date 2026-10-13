'use strict';

/**
 * _ui-chip-select.js —— 自检「画质/音质框点选后高亮」。
 *
 * 跑法：
 *   NODE_PATH=C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules
 *   node tools/_ui-chip-select.js
 *
 * 背景：曾经点击画质框后选择是成功的（下载用对档位），但视觉上只闪一下、
 *       边线/底色不高亮 —— 因为 dataset.id 是字符串，赋给 state.selVideoQn 后
 *       与 number 型的 v.id 严格比较永远 false，active 类加不上。
 *
 * 验证点：
 *   1. 初始渲染：选中档位带 active
 *   2. 点选数字 id 档位 → 该框带 active、原选中框失去 active
 *   3. 点选 "10#2" 复合 id（抖音同档双编码）→ 同样高亮
 *   4. state 里的类型正确（数字 / 复合字符串）
 *   5. 点击后 DOM 元素原地保留（不整行重建，无闪烁）
 *   6. 音质框同样可用
 */

const fs = require('fs');
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

  // 造一份抖音形态的 preview：数字 id + 一个 "10#2" 复合 id + 空音轨列表
  // （音质框用 B站 形态单独验证）
  await page.evaluate(() => {
    // chips 在 #mediaBox 里，默认 hidden，点选测试前先显示
    document.getElementById('mediaBox').classList.remove('hidden');
    state.preview = {
      platform: 'douyin',
      videos: [
        { id: 72, desc: '4K', codecLabel: 'H.265 · 1.5 GB', sizeBytes: 1606253066 },
        { id: 7, desc: '2K', codecLabel: 'H.265 · 851 MB', sizeBytes: 892337152 },
        { id: 1, desc: '1080P', codecLabel: 'H.264 · 867 MB', sizeBytes: 909115392 },
        { id: '10#2', desc: '1080P', codecLabel: 'H.265 · 358 MB', sizeBytes: 375488512 },
        { id: 10, desc: '720P', codecLabel: 'H.264 · 648 MB', sizeBytes: 679477248 },
      ],
      audios: [],
    };
    state.selVideoQn = 72;
    state.selAudioQn = 0;
    renderChips();
  });
  await new Promise((r) => setTimeout(r, 150));

  const results = [];
  const check = (name, ok, detail) =>
    results.push((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  → ' + detail : ''));

  const activeIds = () =>
    page.evaluate(() => Array.from(document.querySelectorAll('#videoChips .chip.active')).map((c) => c.dataset.id));

  // 1) 初始渲染：4K(id=72) 应高亮
  let act = await activeIds();
  check('初始渲染选中档位带 active', act.length === 1 && act[0] === '72', JSON.stringify(act));

  // 2) 点选 1080P(id=1) → 高亮迁移
  await page.click('#videoChips .chip[data-id="1"]');
  act = await activeIds();
  check('点选 1080P 后只有该框 active', act.length === 1 && act[0] === '1', JSON.stringify(act));

  // 3) state 类型正确（数字 1，不是 "1"）
  let sel = await page.evaluate(() => ({ v: state.selVideoQn, t: typeof state.selVideoQn }));
  check('state.selVideoQn 为 number', sel.v === 1 && sel.t === 'number', JSON.stringify(sel));

  // 4) 点选复合 id "10#2" → 同样高亮
  await page.click('#videoChips .chip[data-id="10#2"]');
  act = await activeIds();
  sel = await page.evaluate(() => ({ v: state.selVideoQn }));
  check('复合 id "10#2" 可点选且高亮', act.length === 1 && act[0] === '10#2' && sel.v === '10#2', JSON.stringify(act) + ' / ' + JSON.stringify(sel));

  // 5) 点选后 DOM 原地保留（同一元素未被重建 → 无闪烁）
  const sameEl = await page.evaluate(() => {
    const el = document.querySelector('#videoChips .chip[data-id="1"]');
    el.__marker = 'keep-me';
    el.click(); // 回到 id=1
    const after = document.querySelector('#videoChips .chip[data-id="1"]');
    return after === el && after.__marker === 'keep-me' && after.classList.contains('active');
  });
  check('点选后按钮元素原地保留（不重建、无闪烁）', sameEl === true);

  await page.screenshot({ path: path.join(ROOT, 'tools', '_ui-chip-select.png') });

  // 6) 音质框（B站 形态）
  await page.evaluate(() => {
    state.preview.audios = [
      { id: 30280, desc: '192K', codecLabel: 'MP4A' },
      { id: 30251, desc: 'Hi-Res 无损', codecLabel: 'FLAC' },
    ];
    state.selAudioQn = 30280;
    renderChips();
  });
  await page.click('#audioChips .chip[data-id="30251"]');
  const audioOk = await page.evaluate(() => {
    const c = document.querySelector('#audioChips .chip[data-id="30251"]');
    return c.classList.contains('active') && state.selAudioQn === 30251 &&
      !document.querySelector('#audioChips .chip[data-id="30280"]').classList.contains('active');
  });
  check('音质框点选后高亮正确', audioOk === true);

  await browser.close();

  console.log('== 画质/音质点选高亮自检 ==');
  results.forEach((l) => console.log('  ' + l));
  console.log('== 页面 JS 报错 ==');
  console.log(errors.length ? '  ' + errors.join('\n  ') : '  无');
  process.exitCode = results.some((l) => l.startsWith('FAIL')) || errors.length ? 1 : 0;
})();
