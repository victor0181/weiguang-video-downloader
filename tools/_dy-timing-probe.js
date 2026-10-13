'use strict';

/**
 * _dy-timing-probe.js —— 给「抖音解析」做一次带时间线的体检：
 * 记录从切页到拿到 aweme_detail 的每一步耗时，用来判断
 * 「解析偶发超时」到底卡在（a）页面没发详情请求、（b）请求来了但响应体读不到、
 * 还是（c）单纯慢。
 *
 * 直接复用 DouyinClient 的隐藏窗口（_ensureWindow / _resetServiceWorker），
 * 但不走 _detailOnce 的黑盒，而是自己挂 CDP 监听并打时间线。
 *
 * 用法：
 *   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe tools/_dy-timing-probe.js
 *
 * 环境变量：
 *   BD_USERDATA   指定 userData（默认 tools/_dyprof，不自动清空）
 *   BD_DY_URL     解析目标（默认示例短链）
 *   BD_DY_TIMEOUT 观察上限毫秒（默认 50000）
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const SRC = path.join(__dirname, '..', 'src', 'main');
const { DouyinClient } = require(path.join(SRC, 'douyin'));
const { api } = require(path.join(SRC, 'api'));

const USERDATA = process.env.BD_USERDATA || path.join(__dirname, '_dyprof');
try {
  fs.mkdirSync(USERDATA, { recursive: true });
  app.setPath('userData', USERDATA);
  app.setPath('cache', path.join(USERDATA, 'Cache'));
} catch (e) {
  console.error('[probe] setPath failed: ' + e.message);
}

const TARGET = process.env.BD_DY_URL || 'https://v.douyin.com/jRKTRoQL0tc/';
const LIMIT = Number(process.env.BD_DY_TIMEOUT) || 50000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  console.log('[probe] userData = ' + USERDATA);
  console.log('[probe] target   = ' + TARGET);
  console.log('');

  const c = new DouyinClient();
  const t0 = Date.now();
  const at = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(6) + 's';

  // 先解决短链 → awemeId
  let awemeId = null;
  try {
    const https = require('https');
    const hop = (url, depth) =>
      new Promise((resolve, reject) => {
        if (depth > 5) return resolve(url);
        const req = https.get(
          url,
          {
            headers: api.douyin.headers,
            timeout: 12000,
          },
          (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              res.resume();
              const next = new URL(res.headers.location, url).href;
              resolve(hop(next, depth + 1));
            } else {
              res.resume();
              resolve(url);
            }
          }
        );
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
      });
    const finalUrl = await hop(TARGET, 0);
    const m = String(finalUrl).match(/\/(?:video|note)\/(\d{15,})/) || String(finalUrl).match(/(\d{15,})/);
    awemeId = m ? m[1] : null;
    console.log(`[${at()}] 短链展开 → ${String(finalUrl).slice(0, 100)}`);
  } catch (e) {
    console.log(`[${at()}] 短链展开失败：${e.message}`);
  }
  if (!awemeId) {
    console.log('❌ 拿不到 awemeId，终止');
    c.destroy();
    return process.exit(1);
  }
  console.log(`[${at()}] awemeId = ${awemeId}`);

  const win = await c._ensureWindow();
  console.log(`[${at()}] 隐藏窗口就绪`);
  // 默认不做任何清理 —— 现在的主通路（session.fetch 重放）根本不经过 Service Worker。
  // 想复现「清 SW 换来的收益/代价」时设 BD_DY_CLEAR=1 手动清一次。
  if (process.env.BD_DY_CLEAR === '1') {
    await c._resetServiceWorker();
    console.log(`[${at()}] 已清 SW/CacheStorage（BD_DY_CLEAR=1）`);
  } else {
    console.log(`[${at()}] 跳过清理（默认路径）`);
  }

  const dbg = win.webContents.debugger;
  let found = null;
  let notFound = false;
  const hits = [];
  let firstDetailAt = null;
  let bodyFail = 0;
  let bodyFailDetail = [];

  win.webContents.on('did-navigate', (_e, url) => {
    if (/web_video_404_link/.test(url)) notFound = true;
    console.log(`[${at()}] did-navigate ${String(url).slice(0, 90)}${/web_video_404_link/.test(url) ? '  <== 404 标记' : ''}`);
  });
  win.webContents.on('did-finish-load', () => console.log(`[${at()}] did-finish-load`));
  win.webContents.on('dom-ready', () => console.log(`[${at()}] dom-ready`));

  const ses = win.webContents.session;
  let signedUrl = null;

  dbg.on('message', async (_e, method, params) => {
    // 顺手把「页面自己发出的那条已签名详情 URL」记下来，
    // 后面用 session.fetch 原样重放，绕开 SW / CDP 取响应体的坑
    if (method === 'Network.requestWillBeSent') {
      const u = (params.request && params.request.url) || '';
      if (c._re.test(u) && !signedUrl) {
        signedUrl = u;
        console.log(`[${at()}] ☆ 捕获页面发出的详情请求 URL（${u.length} 字符）`);
        // 立即用 session.fetch 自己重放一次
        try {
          const t = Date.now();
          const res = await ses.fetch(u, {
            headers: api.douyin.headers,
            referrer: 'https://www.douyin.com/',
          });
          const txt = await res.text();
          const j = JSON.parse(txt);
          const d = j && j[api.douyin.detailField];
          console.log(
            `[${at()}] >>> ses.fetch 重放：status=${res.status} len=${txt.length} aweme_detail=${d ? '有！耗时 ' + ((Date.now() - t) / 1000).toFixed(2) + 's' : 'null'}`
          );
          if (d && !found) found = d;
        } catch (e) {
          console.log(`[${at()}] >>> ses.fetch 重放失败：${String(e.message).slice(0, 120)}`);
        }
      }
      return;
    }
    if (method !== 'Network.responseReceived') return;
    const url = (params.response && params.response.url) || '';
    if (!c._re.test(url)) return;
    if (firstDetailAt === null) {
      firstDetailAt = Date.now();
      console.log(`[${at()}] ★ 首个详情请求响应到达 (status=${params.response.status})`);
    }
    try {
      const r = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
      const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
      const j = JSON.parse(body);
      const d = j && j[api.douyin.detailField];
      hits.push({ t: at(), has: !!d, len: body.length });
      if (d && !found) {
        found = d;
        console.log(`[${at()}] ✅ 拿到 aweme_detail（第 ${hits.length} 条匹配响应）`);
      }
    } catch (e) {
      bodyFail++;
      bodyFailDetail.push(e.message);
      console.log(`[${at()}] ✖ 响应体读取失败：${String(e.message).slice(0, 90)}`);
    }
  });

  console.log(`[${at()}] 开始切页 about:blank → video/${awemeId}`);
  win.loadURL('about:blank').catch(() => {});
  await sleep(150);
  win.loadURL(api.douyin.urls.videoPage + awemeId).catch(() => {});

  const deadline = Date.now() + LIMIT;
  while (Date.now() < deadline && !found) {
    await sleep(200);
  }

  console.log('');
  console.log('================ 时间线小结 ================');
  console.log(`总耗时          : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`首个详情响应     : ${firstDetailAt ? ((firstDetailAt - t0) / 1000).toFixed(1) + 's' : '（从未到达）'}`);
  console.log(`匹配响应条数     : ${hits.length}`);
  hits.forEach((h, i) => console.log(`   #${i + 1} ${h.t}  aweme_detail=${h.has ? '有' : 'null'}  bodyLen=${h.len}`));
  console.log(`响应体读取失败   : ${bodyFail}${bodyFail ? '  [' + bodyFailDetail.join(' | ').slice(0, 200) + ']' : ''}`);
  console.log(`404 标记         : ${notFound ? '是' : '否'}`);
  console.log(`结论            : ${found ? '✅ 成功' : '❌ 未拿到'}`);

  c.destroy();
  setTimeout(() => process.exit(0), 300);
});
