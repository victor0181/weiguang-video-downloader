'use strict';

/**
 * _health-sample-probe.js —— 验证「体检样本视频」是否脆弱
 *
 * 背景：healthCheck 原先只用 `popular?ps=1&pn=1` 的第一条做样本。
 * 如果那条恰好是番剧 / 付费 / 需登录 / 互动视频，view 或 playurl 会拿不到 dash，
 * 两轮都一样 → 稳定误报「接口可能已变更」。
 *
 * 本探针把热门前 N 条逐个跑一遍 view → playurl，如实打印每条的成败与原因，
 * 用来判断「单样本」是否真的会踩到坏样本。
 *
 * 用法：
 *   node tools/_node-shim.js _health-sample-probe.js [页号]
 *   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe tools/_health-sample-probe.js
 */

const path = require('path');
const { BiliClient } = require(path.join(__dirname, '..', 'src', 'main', 'bili'));
const { api } = require(path.join(__dirname, '..', 'src', 'main', 'api'));

const PAGE = Number(process.argv[2] || 1);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function brief(e) {
  return String((e && e.message) || e).slice(0, 140);
}

async function main() {
  let session;
  try {
    const elec = require('electron');
    if (elec.app && elec.app.whenReady) await elec.app.whenReady();
    session = elec.session.defaultSession;
  } catch (e) {
    console.error('拿不到 electron session：' + e.message);
    process.exit(2);
  }

  const c = new BiliClient(session);

  const r = await c._json(`${api.urls.popular}?ps=10&pn=${PAGE}`);
  const list = (r && r.data && r.data.list) || [];
  console.log(`popular pn=${PAGE} 取回 ${list.length} 条（code=${r && r.code}）\n`);

  let okCount = 0;
  let badCount = 0;
  const badReasons = [];

  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const bvid = it && it.bvid;
    const title = String((it && it.title) || '').slice(0, 26);
    if (!bvid) {
      console.log(`${String(i + 1).padStart(2)}. (无 bvid) ${title}`);
      continue;
    }

    // ---- view ----
    let cid = 0;
    let stage = '';
    let reason = '';
    try {
      const v = await c.videoInfo(bvid);
      if (v && v.cid) cid = v.cid;
      else {
        stage = 'view';
        reason = '返回中缺少 cid 字段';
      }
    } catch (e) {
      stage = 'view';
      reason = brief(e);
    }

    // ---- playurl ----
    if (cid) {
      try {
        const d = await c.playurl(bvid, cid, 32);
        const tracks = !!(d && d.dash && d.dash.video && d.dash.video.length && d.dash.audio && d.dash.audio.length);
        if (!tracks) {
          stage = 'playurl';
          reason = '未返回 dash 音视频轨';
        }
      } catch (e) {
        stage = 'playurl';
        reason = brief(e);
      }
    }

    if (!stage) {
      okCount++;
      console.log(`${String(i + 1).padStart(2)}. ✅ ${bvid}  ${title}`);
    } else {
      badCount++;
      badReasons.push(`${stage}: ${reason}`);
      console.log(`${String(i + 1).padStart(2)}. ❌ ${bvid}  ${title}`);
      console.log(`     └─ 失败于 ${stage}：${reason}`);
    }

    await sleep(350); // 别把接口打太快
  }

  console.log(`\n===== 小结 =====`);
  console.log(`可用样本 ${okCount} 条 / 坏样本 ${badCount} 条`);
  if (badCount) {
    console.log('★ 结论：popular 列表里确实存在「view/playurl 拿不到 dash」的条目。');
    console.log('  只要体检恰好抽中它，就会两轮都失败 → 稳定误报「接口已变更」。');
    console.log('  典型原因：' + Array.from(new Set(badReasons)).join(' | '));
  } else {
    console.log('本次这 10 条全部可用（但不代表下一个小时的第一条也可用）。');
  }
  console.log('================\n');
  process.exit(0);
}

main().catch((e) => {
  console.error('probe error: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
