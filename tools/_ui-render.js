'use strict';

/**
 * _ui-render.js —— 用无头浏览器（本机 Edge）真实渲染渲染层页面做界面自检。
 *
 * ★ 为什么不用 Electron 自带的截图自检：本会话里 GUI 模式的 electron.exe
 *   会被环境静默拦掉（退出码 0、脚本根本没执行）。这个脚本走 puppeteer-core +
 *   本机 Edge 无头模式，同样跑的是真实的 index.html / app.css / app.js，
 *   并且能看到页面里的 JS 报错。
 *
 * 依赖（已在隔离工作区里）：jsdom / puppeteer-core
 *   NODE_PATH=C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules
 * 跑法：
 *   node tools/_ui-render.js
 * 产物：tools/_ui-queue-transcode.png、tools/_ui-home-audio.png
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

/** 在页面脚本执行前注入 window.bd 桩（模拟 preload 桥） */
function injectStub() {
  // 默认返回 {} 而不是 undefined：渲染层里不少地方会读 `r.ok`，返回 undefined 会报假错
  const f = () => Promise.resolve({});
  const state = {
    config: __CONFIG__,
    user: { isLogin: false, name: '', vip: '' },
    nameVars: [],
    tasks: [],
    version: '1.0.0',
    platform: 'win32',
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
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
  });

  // 直接把配置内联成一段源码字符串：用 new Function + bind 传参会被 puppeteer 序列化成
  // "[native code]"，页面里会报 "Unexpected identifier 'code'"。
  const stubSrc = ('(' + injectStub.toString() + ')();').replace(
    '__CONFIG__',
    JSON.stringify(CONFIG)
  );
  await page.evaluateOnNewDocument(stubSrc);

  await page.goto(HTML, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 600));

  // ---------------- 场景一：队列里的「直提 / 转码」文案 ----------------
  const queueText = await page.evaluate(() => {
    function mk(o) {
      const base = {
        platform: 'bilibili', kind: 'audio', bvid: 'BV1xx411c7mD', cid: 2,
        title: '', part: '', upName: '测试UP主', type: '单视频', index: 1,
        duration: 245, cover: '', qnName: '音频 192K', audioName: '192K',
        folder: '', fileName: '', status: 'merging', progress: 100,
        speedText: '', totalText: '', sizeText: '', error: '',
        mergeHint: '', mergeTranscoding: false, audioNote: '', createdAt: Date.now(),
      };
      return Object.assign(base, o);
    }
    const tasks = [
      mk({ id: 'a1', title: '源音轨是 AAC → 自动转码 MP3', status: 'merging', mergeTranscoding: true,
           mergeHint: '源音轨为 AAC，正在转码为 MP3，需要一点时间…' }),
      mk({ id: 'a2', title: '源音轨本身就是 MP3 → 直接提取', status: 'merging', mergeTranscoding: false,
           mergeHint: '源音轨已是 MP3，直接提取（无需转码）…' }),
      mk({ id: 'a3', title: '已完成（这次做过转码）', status: 'done', sizeText: '4.2 MB',
           audioNote: '已转码' }),
      mk({ id: 'a4', title: '视频任务混流（对照）', kind: 'video',
           qnName: '1080P 高清', audioName: '192K', status: 'merging' }),
    ];
    switchTab('queue');
    document.getElementById('queueEmpty').classList.add('hidden');
    renderQueue(tasks);

    const out = [];
    document.querySelectorAll('#queueList .qcard').forEach((c) => {
      out.push(c.querySelector('.js-status').textContent + ' | ' + c.querySelector('.js-info').textContent);
    });
    return out;
  });

  fs.mkdirSync(path.join(ROOT, 'tools'), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, 'tools', '_ui-queue-transcode.png') });

  // ---------------- 场景二：解析成功后的操作行（音频格式下拉） ----------------
  const homeText = await page.evaluate(() => {
    switchTab('home');
    const m = {
      platform: 'bilibili', bvid: 'BV1xx411c7mD', aid: 1, cid: 2,
      title: '【示例】解析成功后可以直接「只下载音频」',
      cover: '', type: '单视频', desc: '用于界面自检的假简介。',
      pubdate: 1700000000, duration: 245, tname: '生活',
      up: { mid: 9, name: '测试UP主' },
      stat: { view: 12345, danmaku: 67, like: 890, coin: 12, favorite: 34 },
      parts: [{ index: 1, sectionTitle: '', bvid: 'BV1xx411c7mD', aid: 1, cid: 2, title: '正片', part: '', duration: 245, cover: '', pubdate: 1700000000 }],
    };
    state.media = m;
    state.parts = new Set([1]);
    state.preview = {
      platform: 'bilibili',
      videos: [{ id: 80, desc: '1080P 高清', codecLabel: 'AVC/H.264', sizeBytes: 0 }],
      audios: [{ id: 30280, desc: '192K', codecLabel: 'aac' }, { id: 30251, desc: 'Hi-Res 无损', codecLabel: 'fLaC' }],
    };
    state.selVideoQn = 80;
    state.selAudioQn = 30280;
    renderMedia(m);
    renderChips();
    const ps = document.getElementById('parseStatus');
    ps.className = 'parse-status ok';
    ps.textContent = '解析成功：共 1 个可下载视频';
    ps.classList.remove('hidden');
    document.getElementById('audioFmt').value = 'mp3';

    const sel = document.getElementById('audioFmt');
    return document.getElementById('btnDownloadAudio').textContent.trim().replace(/\s+/g, ' ') +
      '  ||  下拉当前值=' + sel.value + ' 选项=' +
      Array.from(sel.options).map((o) => o.textContent).join(' / ') +
      '  ||  按钮禁用=' + document.getElementById('btnDownloadAudio').disabled;
  });

  await page.screenshot({ path: path.join(ROOT, 'tools', '_ui-home-audio.png') });

  await browser.close();

  console.log('== 队列卡片文案 ==');
  queueText.forEach((l, i) => console.log('  ' + (i + 1) + '. ' + l));
  console.log('== 操作行 ==');
  console.log('  ' + homeText);
  console.log('== 页面 JS 报错 ==');
  console.log(errors.length ? '  ' + errors.join('\n  ') : '  无');
})();
