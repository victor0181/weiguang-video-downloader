'use strict';

/**
 * douyin-browser-probe.js —— 用 Electron 内置 Chromium 抓抖音视频数据（验证/排障用）
 *
 * 背景：抖音 2026 起给 /aweme/v1/web/aweme/detail/ 加了 Argus 风控
 *   （纯 HTTP 请求返回 403 "Uifid Not Found"），只有页面自己发的请求才带
 *   合法 a_bogus / msToken / verifyFp。所以这里用隐藏窗口 + CDP 截响应体。
 *
 * 两种模式：
 *   node ... -> cmd //c run-probe.bat                 # auto：从推荐流取一个有效 id 再抓详情
 *   set DY_ID=7xxxxxxxx  -> cmd //c run-probe.bat     # 指定 id
 *
 * 必须经 cmd.exe 拉起（bash 直拉 electron 会静默退出）。
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ID = process.env.DY_ID || 'auto';
const OUT = path.join(__dirname, 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

const captured = []; // { kind, body }

function pickFeedIds(json) {
  const ids = [];
  const walk = (o, depth) => {
    if (!o || depth > 6 || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1));
    if (o.aweme_id && o.video) ids.push({ id: o.aweme_id, desc: String(o.desc || '').slice(0, 30) });
    for (const k of Object.keys(o)) walk(o[k], depth + 1);
  };
  walk(json, 0);
  return ids;
}

(async () => {
  await app.whenReady();
  console.log('[probe] electron ready, mode=' + (ID === 'auto' ? 'auto' : 'id:' + ID));
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });

  // ★ 排障脚本同样不允许弹窗：抖音页面会调 window.open（登录引导/外链等），
  //   不拦的话会真在屏幕上弹出可见小窗口。这里和 src/main/douyin.js 保持一致。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('show', () => {
    try {
      win.hide();
    } catch (e) {
      /* ignore */
    }
  });

  // ★ Electron 渲染进程是懒创建的：不先加载一次页面，debugger.sendCommand / executeJavaScript
  //   会永远挂起（不是报错，是无声卡住）。先跑一个空页把它激活。
  await win.loadURL('about:blank');

  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Network.enable');
  console.log('[probe] debugger attached');

  win.webContents.on('did-navigate', (_e, url) => console.log('[probe] navigate: ' + url.slice(0, 130)));

  let saw404 = false;
  dbg.on('message', async (_e, method, params) => {
    if (method !== 'Network.responseReceived') return;
    const url = (params.response && params.response.url) || '';
    if (!/douyin\.com\/aweme\/.*(detail|feed)/.test(url) && !/module\/feed/.test(url)) return;
    const kind = /detail/.test(url) ? 'detail' : 'feed';
    try {
      const r = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
      const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
      let j = null;
      try {
        j = JSON.parse(body);
      } catch (e) {
        return;
      }
      if (kind === 'detail') {
        if (j.aweme_detail) {
          console.log('[probe] ✅ detail payload ok (' + body.length + 'B)');
          captured.push({ kind, body });
        } else {
          console.log('[probe] detail payload EMPTY (status_code=' + j.status_code + ')');
        }
      } else {
        const ids = pickFeedIds(j);
        if (ids.length) {
          console.log('[probe] feed ids: ' + ids.slice(0, 4).map((x) => x.id).join(', '));
          captured.push({ kind: 'feed', body, ids });
        }
      }
    } catch (e) {
      /* ignore */
    }
  });

  const nav = (u) => win.loadURL(u).catch((e) => console.error('[probe] loadURL: ' + e.message));

  if (ID === 'auto') {
    console.log('[probe] step1: 打开首页取推荐流里的有效 aweme_id');
    nav('https://www.douyin.com/');
    for (let i = 0; i < 25 && !captured.some((c) => c.kind === 'feed'); i++) await sleep(1000);
  } else {
    nav('https://www.douyin.com/video/' + ID);
    for (let i = 0; i < 25 && !captured.some((c) => c.kind === 'detail'); i++) await sleep(1000);
  }

  let feed = captured.find((c) => c.kind === 'feed');

  if (ID === 'auto' && feed) {
    const target = feed.ids[0].id;
    console.log('[probe] step2: 用该 id 打开视频页 -> ' + target);
    captured.length = 0;
    nav('https://www.douyin.com/video/' + target);
    for (let i = 0; i < 25 && !captured.some((c) => c.kind === 'detail'); i++) await sleep(1000);
    if (!captured.some((c) => c.kind === 'detail')) saw404 = true;
  }

  const detail = captured.find((c) => c.kind === 'detail');
  const finalUrl = win.webContents.getURL();
  console.log('[probe] final url: ' + finalUrl.slice(0, 160));
  if (/404|jingxuan/.test(finalUrl)) console.log('[probe] ⚠ 被判定为视频不存在，跳到推荐页');

  if (detail) {
    fs.writeFileSync(path.join(OUT, 'douyin-detail.json'), detail.body);
    const j = JSON.parse(detail.body);
    const d = j.aweme_detail;
    const v = d.video || {};
    console.log('[probe] ===== 详情 =====');
    console.log('[probe] aweme_id: ' + d.aweme_id);
    console.log('[probe] desc: ' + String(d.desc || '').slice(0, 60));
    console.log('[probe] author: ' + (d.author && d.author.nickname) + ' uid=' + (d.author && d.author.uid));
    console.log('[probe] duration(ms): ' + v.duration + '  images: ' + ((d.images && d.images.length) || 0));
    console.log('[probe] cover: ' + (((v.cover || {}).url_list || [])[0] || '-'));
    console.log('[probe] music: ' + (d.music && d.music.title));
    console.log('[probe] play_addr.urls(' + (((v.play_addr || {}).url_list || []).length) + '):');
    (((v.play_addr || {}).url_list) || []).forEach((u) => console.log('    ' + u.slice(0, 150)));
    const br = v.bit_rate || [];
    console.log('[probe] bit_rate(' + br.length + '):');
    br.forEach((b) => {
      const pa = b.play_addr || {};
      console.log(
        `    gear=${b.gear_name} q=${b.quality_type} ${pa.width}x${pa.height} ${pa.encoded_type} ` +
          `${((pa.data_size || 0) / 1048576).toFixed(1)}MB fps=${pa.fps} ${((pa.bit_rate || 0) / 1000) | 0}kbps urls=${(pa.url_list || []).length}`
      );
    });
  } else {
    console.log('[probe] ❌ 没抓到详情 payload' + (saw404 ? '（视频被判 404）' : ''));
    const probe = await win.webContents.executeJavaScript('document.title').catch((e) => 'err:' + e.message);
    console.log('[probe] page title: ' + String(probe).slice(0, 90));
  }

  app.exit(0);
})();

app.on('window-all-closed', () => {});
