'use strict';

/**
 * _health-probe.js —— 复现/验证「B站接口可能已变更」预警条
 *
 * 直接调用 bili.BiliClient#healthCheck()，打印每个环节的真实结果，用来判断
 * 预警是真·接口变更还是误报。
 *
 * 用法（走 _node-shim，用 Node 原生 fetch 假冒 Electron session）：
 *   node tools/_node-shim.js _health-probe.js               # 真实网络，应得 kind=ok
 *   node tools/_node-shim.js _health-probe.js --inject-fail  # 注入业务失败 → 应得 kind=changed
 *   node tools/_node-shim.js _health-probe.js --inject-env   # 注入环境类失败 → 应得 kind=offline
 *
 * 后两个模式用于验证 2026-10-12 的加固逻辑（单轮失败要重试一轮、环境类错误静默）。
 */

const path = require('path');
const { BiliClient } = require(path.join(__dirname, '..', 'src', 'main', 'bili'));
const { api } = require(path.join(__dirname, '..', 'src', 'main', 'api'));

const MODE = process.argv[2] || '';

function inject() {
  if (MODE === '--inject-fail') {
    // 业务失败：接口回了，但没有 b_3 字段（code -400），两轮都会失败
    api.urls.spi = 'https://api.bilibili.com/x/web-interface/view?bvid=BVnonexistent000';
    console.log('[inject] spi -> 业务失败（缺少 b_3）');
  } else if (MODE === '--inject-env') {
    // 环境类失败：返回 HTML 而非 JSON（模拟运营商劫持 / Portal / 拦截页）
    api.urls.spi = 'https://www.bilibili.com/';
    console.log('[inject] spi -> 非 JSON（环境类，应静默）');
  }
}

/**
 * 抽样注入：验证 2026-10-12 新增的「多候选抽样」逻辑。
 *
 *   --inject-bad-sample      只有第一条候选稿件的 view 失败 → 应自动跳到下一条 → kind=ok
 *   --inject-all-bad-sample  全部候选的 view 都失败         → 两轮都失败 → kind=changed
 *
 * 这两个用例对应「热门列表里混进番剧/付费稿件」这一类误报：单条踩雷不该弹条，
 * 全部踩雷才说明 view 接口本身出问题了。
 */
async function injectSample(c) {
  if (MODE !== '--inject-bad-sample' && MODE !== '--inject-all-bad-sample') return;

  const r = await c._json(`${api.urls.popular}?ps=3&pn=1`);
  const list = (r && r.data && r.data.list) || [];
  const first = list[0] && list[0].bvid;
  const orig = c.videoInfo.bind(c);

  c.videoInfo = async (bv) => {
    if (MODE === '--inject-all-bad-sample' || bv === first) {
      const e = new Error('啥都木有（-404）'); // 模拟 B站 对 PGC/受限稿件返回的业务错误
      e.code = -404;
      throw e;
    }
    return orig(bv);
  };
  console.log(`[inject] ${MODE}：让 ${MODE === '--inject-all-bad-sample' ? '全部' : '第一条 ' + first} 候选 view 失败`);
}

async function main() {
  let session;
  try {
    const elec = require('electron');
    if (elec.app && elec.app.whenReady) await elec.app.whenReady(); // 真 Electron 下要等 ready
    session = elec.session.defaultSession;
  } catch (e) {
    console.error('拿不到 electron session：' + e.message);
    process.exit(2);
  }

  inject();

  const c = new BiliClient(session);
  await injectSample(c);

  const t0 = Date.now();
  const res = await c.healthCheck();
  const ms = Date.now() - t0;

  console.log('\n===== healthCheck 结果（' + ms + ' ms） =====');
  console.log('ok      :', res.ok);
  console.log('kind    :', res.kind);
  console.log('failed  :', res.failed.length);
  for (const f of res.failed) {
    console.log('  - ' + f.name + '  [' + f.key + ']');
    console.log('      detail: ' + f.detail);
  }
  console.log('netFailed:', res.netFailed.length);
  for (const f of res.netFailed) {
    console.log('  - ' + f.name + '  [' + f.key + ']');
    console.log('      detail: ' + f.detail);
  }
  console.log('=================================\n');
  process.exit(0);
}

main().catch((e) => {
  console.error('probe error: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
