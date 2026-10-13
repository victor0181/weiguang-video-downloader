'use strict';

/**
 * _dy-detail-probe.js —— 抖音「详情解析」端到端自检（真 Electron、真网络、真用户分区）。
 *
 * 走的是**生产代码路径** `DouyinClient.detail()`，验证 2026-10-12 的修复：
 *   1. 主通路「抓签名 URL → session.fetch 重放」能拿到详情；
 *   2. 不再每次解析前清 Service Worker（首轮就该明显快于老的 ~12.5s）；
 *   3. 详情缓存生效（第二次调用 <300ms 且是同一个对象）；
 *   4. `{ force: true }` 能绕过缓存拿到**新的**直链签名，并回写缓存。
 *
 * 用法：
 *   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe tools/_dy-detail-probe.js
 *
 * 环境变量：
 *   BD_USERDATA   指定 userData（默认 tools/_dyprof，不自动清空）
 *   BD_DY_URL     解析目标（默认示例短链）
 *   BD_DY_ROUNDS  第 2 步重复次数（默认 2，用来验证"不再偶发失败"）
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
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
const ROUNDS = Number(process.env.BD_DY_ROUNDS) || 2;

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  if (ok) {
    pass++;
    console.log(`  ✅ ${label}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${detail ? '  ' + detail : ''}`);
  }
};

/** 从详情里抽一条视频直链，用来比对"是否换了新签名" */
function firstUrl(d) {
  try {
    const v = d.video || {};
    const br = Array.isArray(v.bit_rate) ? v.bit_rate[0] : null;
    const fromBr = br && br.play_addr && (br.play_addr.url_list || [])[0];
    return String(fromBr || (v.play_addr && v.play_addr.url_list[0]) || '');
  } catch (e) {
    return '';
  }
}

/** 把短链展开成 awemeId（探针自己实现，不依赖内部方法） */
async function resolveAwemeId() {
  if (!/^https?:\/\//i.test(TARGET)) return TARGET;
  const hop = (url, depth) =>
    new Promise((resolve, reject) => {
      if (depth > 5) return resolve(url);
      const u = new URL(url);
      const req = https.get(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: api.douyin.headers,
          timeout: 12000,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            resolve(hop(new URL(res.headers.location, url).href, depth + 1));
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
  if (!m) throw new Error('无法从 ' + finalUrl + ' 解析出 awemeId');
  return m[1];
}

app.whenReady().then(async () => {
  console.log('[probe] userData = ' + USERDATA);
  console.log('[probe] target   = ' + TARGET);
  console.log('');

  const c = new DouyinClient();
  const awemeId = await resolveAwemeId();
  console.log('[probe] awemeId  = ' + awemeId);
  console.log('');

  // ---- 1) 首轮解析：真跑一遍（冷启动隐藏窗口） ----
  console.log('第 1 步 · 首次解析（冷启动窗口）');
  let t0 = Date.now();
  let d1 = null;
  try {
    d1 = await c.detail(awemeId);
  } catch (e) {
    check(false, '首次解析不抛错', '[' + (e.code || '-') + '] ' + e.message);
  }
  const t1 = Date.now() - t0;
  if (!d1) {
    console.log(`\n================ 结果：${pass} 通过 / ${fail + 1} 失败 ================`);
    c.destroy();
    return process.exit(1);
  }
  check(true, '拿到 aweme_detail', `${(t1 / 1000).toFixed(1)}s`);
  check(t1 < 20000, '耗时 <20s（不再走「清 SW」那条 12.5s 老路）', `${(t1 / 1000).toFixed(1)}s`);
  check(!!firstUrl(d1), '详情里有可用直链');

  // ---- 2) 重复解析（窗口已热，且强制绕过缓存）：验证不再偶发失败 ----
  console.log(`\n第 2 步 · 连续强制重新解析 ${ROUNDS} 次（窗口已热）`);
  for (let i = 1; i <= ROUNDS; i++) {
    const s = Date.now();
    try {
      const d = await c.detail(awemeId, { force: true });
      check(!!d, `第 ${i} 次强制解析成功`, `${((Date.now() - s) / 1000).toFixed(1)}s`);
    } catch (e) {
      check(false, `第 ${i} 次强制解析成功`, '[' + (e.code || '-') + '] ' + e.message);
    }
  }

  // ---- 3) 缓存命中：应 <300ms 且返回同一个对象 ----
  console.log('\n第 3 步 · 详情缓存（detailCacheMs=' + api.douyin.detailCacheMs + '）');
  const a = await c.detail(awemeId);
  const s3 = Date.now();
  const b = await c.detail(awemeId);
  const t3 = Date.now() - s3;
  check(a === b, '两次调用返回同一对象（确认走了缓存）');
  check(t3 < 300, '缓存命中耗时 <300ms', `${t3}ms`);

  // ---- 4) force 绕过缓存：直链签名应当变化，且结果回写缓存 ----
  console.log('\n第 4 步 · { force: true } 绕过缓存换新签名');
  const before = firstUrl(b);
  const dForce = await c.detail(awemeId, { force: true });
  const after = firstUrl(dForce);
  check(!!after, '强制刷新拿到直链');
  check(dForce !== b, 'force 返回的是新对象（确认未复用缓存）');
  check(before !== after, '新签名与缓存里的不同', before === after ? '（两次完全相同）' : '');
  const dAgain = await c.detail(awemeId);
  check(dAgain === dForce, 'force 的结果已回写缓存');

  console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
  c.destroy();
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
});
