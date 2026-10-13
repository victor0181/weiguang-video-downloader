'use strict';

/**
 * _ui-reset-settings.js —— 自检设置页「恢复默认设置」按钮。
 *
 * 跑法：
 *   NODE_PATH=C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules
 *   node tools/_ui-reset-settings.js
 *
 * 验证点：
 *   1. 按钮存在
 *   2. 乱调设置后，点击按钮会弹确认框
 *   3. 确认后调用主进程 resetConfig，且**所有控件**刷新为默认值
 *   4. 取消确认时不会调用 resetConfig（防止误触）
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const HTML = 'file:///' + path.join(ROOT, 'src', 'renderer', 'index.html').replace(/\\/g, '/');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

/** 出厂默认（与 src/main/config.js 的 DEFAULT_CONFIG 对齐） */
const DEFAULTS = {
  savePath: 'D:\\默认下载', videoQn: 80, audioQn: 30280, audioFormat: 'm4a',
  concurrency: 3, keepVideo: false, keepAudio: false,
  fileRule: '{title}', folderRule: '', addIndexToFolder: false,
  saveCover: false, saveDanmaku: false, saveAss: false, saveSubtitle: false, saveNfo: false,
  autoShutdown: false, clipWatch: false, minToTray: true, proxy: '',
};

function injectStub() {
  const f = () => Promise.resolve({});
  const cfg = Object.assign({}, __DEFAULTS__);
  let resetCalls = 0;
  const state = {
    config: cfg,
    user: { isLogin: false, name: '', vip: '' },
    nameVars: [], tasks: [], version: '1.0.0', platform: 'win32',
    packages: { electron: '33.0.0', node: '20.0.0' },
  };
  const explicit = {
    getState: () => Promise.resolve(state),
    health: () => Promise.resolve(null),
    on: () => () => {},
    setConfig: (patch) => { Object.assign(cfg, patch); return Promise.resolve(cfg); },
    resetConfig: () => { resetCalls++; Object.assign(cfg, __DEFAULTS__); return Promise.resolve(Object.assign({}, __DEFAULTS__)); },
    ariaStatus: () => Promise.resolve({ ok: false, message: '自检不启动 aria2' }),
    win: { min: f, max: f, close: f, isMax: () => Promise.resolve(false) },
  };
  window.__resetCalls = () => resetCalls;
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

  // 注意用 split/join 做全局替换：String.replace 只替换首个匹配，
  // 而桩里 __DEFAULTS__ 出现了三次（会报 "__DEFAULTS__ is not defined"）。
  const stubSrc = ('(' + injectStub.toString() + ')();')
    .split('__DEFAULTS__').join(JSON.stringify(DEFAULTS));
  await page.evaluateOnNewDocument(stubSrc);

  await page.goto(HTML, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 600));

  const results = [];
  const check = (name, ok, extra) => results.push((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  [' + extra + ']' : ''));

  // 1) 按钮存在
  check('设置页存在「恢复默认设置」按钮',
    await page.evaluate(() => !!document.querySelector('#btnResetSettings')));

  // 2) 乱调设置（走真实 saveSetting 通道）
  await page.evaluate(() => {
    switchTab('settings');
    saveSetting('concurrency', 9);
    saveSetting('videoQn', 120);
    saveSetting('audioQn', 30216);
    saveSetting('audioFormat', 'mp3');
    saveSetting('fileRule', '{up}-{title}');
    saveSetting('folderRule', '{up}');
    saveSetting('addIndexToFolder', true);
    saveSetting('saveCover', true);
    saveSetting('saveNfo', true);
    saveSetting('keepVideo', true);
    saveSetting('autoShutdown', true);
    saveSetting('clipWatch', true);
    saveSetting('minToTray', false);
    saveSetting('savePath', 'D:\\自定义目录');
    renderSettings();
  });
  let before = await page.evaluate(() => ({
    concurrency: document.getElementById('setConcurrency').value,
    cover: document.getElementById('setCover').checked,
  }));
  check('前置：乱调已反映到界面', before.concurrency === '9' && before.cover === true,
    'concurrency=' + before.concurrency);

  // 3) 取消确认 → 不应调用 resetConfig
  await page.evaluate(() => { window.confirm = () => { window.__lastConfirm = 'shown'; return false; }; });
  await page.click('#btnResetSettings');
  await new Promise((r) => setTimeout(r, 200));
  let st = await page.evaluate(() => ({ calls: window.__resetCalls(), c: document.getElementById('setConcurrency').value }));
  check('取消确认时弹出提示框', st.c === '9');
  check('取消确认时不重置', st.calls === 0);

  // 4) 确认 → 重置 + 全部控件刷新
  await page.evaluate(() => { window.confirm = () => true; });
  await page.click('#btnResetSettings');
  await new Promise((r) => setTimeout(r, 400));

  const after = await page.evaluate(() => ({
    calls: window.__resetCalls(),
    savePath: document.getElementById('setSavePath').value,
    concurrency: document.getElementById('setConcurrency').value,
    valConcurrency: document.getElementById('valConcurrency').textContent,
    videoQn: document.getElementById('setVideoQn').value,
    audioQn: document.getElementById('setAudioQn').value,
    audioFormat: document.getElementById('setAudioFormat').value,
    audioFmt: document.getElementById('audioFmt').value,
    fileRule: document.getElementById('setFileRule').value,
    folderRule: document.getElementById('setFolderRule').value,
    addIndex: document.getElementById('setAddIndex').checked,
    cover: document.getElementById('setCover').checked,
    danmaku: document.getElementById('setDanmaku').checked,
    nfo: document.getElementById('setNfo').checked,
    keepV: document.getElementById('setKeepV').checked,
    autoShutdown: document.getElementById('setAutoShutdown').checked,
    clipWatch: document.getElementById('setClipWatch').checked,
    minTray: document.getElementById('setMinTray').checked,
    toast: (document.querySelector('#toasts .toast') || {}).textContent || '',
  }));

  check('确认后调用了 resetConfig', after.calls === 1, 'calls=' + after.calls);
  check('下载目录恢复默认', after.savePath === DEFAULTS.savePath, after.savePath);
  check('并发数恢复 3', after.concurrency === '3' && after.valConcurrency === '3');
  check('画质/音质恢复默认', after.videoQn === '80' && after.audioQn === '30280');
  check('音频格式恢复 m4a（两处下拉同步）',
    after.audioFormat === 'm4a' && after.audioFmt === 'm4a');
  check('命名规则恢复默认', after.fileRule === '{title}' && after.folderRule === '');
  check('文件夹序号开关恢复关闭', after.addIndex === false);
  check('附加内容开关全部恢复关闭', after.cover === false && after.nfo === false && after.keepV === false);
  check('行为开关恢复默认（托盘常开、其余关）',
    after.autoShutdown === false && after.clipWatch === false && after.minTray === true);
  check('提示「已恢复默认设置」', after.toast.indexOf('已恢复默认设置') >= 0, after.toast);

  fs.mkdirSync(path.join(ROOT, 'tools'), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, 'tools', '_ui-reset-settings.png') });

  await browser.close();

  console.log('== 恢复默认设置（界面）自检 ==');
  results.forEach((l) => console.log('  ' + l));
  console.log('== 页面 JS 报错 ==');
  console.log(errors.length ? '  ' + errors.join('\n  ') : '  无');
  process.exitCode = results.some((l) => l.startsWith('FAIL')) ? 1 : 0;
})();
