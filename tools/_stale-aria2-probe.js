'use strict';

/**
 * _stale-aria2-probe.js —— 验证「旧 .aria2 控制文件 + 残留分片」会不会毒化续传
 *
 * 背景（与抖音 4K 那次同类的隐患）：
 *   downloader._run()（B站 视频通路）第 218 行注释写着「清理旧分片，避免续传污染」，
 *   但代码里**没有任何 cleanup() 调用** —— 提交 aria2 前既不删残留的 .m4s，
 *   也不删 .aria2 控制文件。而 B站 任务的文件名不含画质（如 {title}.mp4），
 *   同一个视频换画质重下会落到同一个 .video.m4s 路径上。
 *
 *   本探针用**真实 B站 流**在 aria2 上做两组对照：
 *     A) 留着上一档的残留（.m4s + .aria2），换高一档再提交 → 看 aria2 是否「接着下」
 *     B) 先清掉残留，再提交同一档 → 应当从头开始（completedLength 从 0 起）
 *
 * 运行：node tools/_node-shim.js _stale-aria2-probe.js
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const SRC = path.join(__dirname, '..', 'src', 'main');
const OUT = path.join(__dirname, '_stale_probe_out');

// 复用项目里真实的 API 客户端与 aria2 RPC 客户端
const { BiliClient } = require(path.join(SRC, 'bili'));
const { Aria2 } = require(path.join(SRC, 'aria2'));
const { extractStreams } = require(path.join(SRC, 'resolver'));
const { api } = require(path.join(SRC, 'api'));
const { getBin, getBinDir } = require(path.join(SRC, 'config'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function startAria(port) {
  const proc = spawn(
    getBin('aria2c.exe'),
    [`--rpc-listen-port=${port}`, `--conf-path=${getBin('aria2c.conf')}`, '--rpc-secret=probe'],
    { cwd: getBinDir(), windowsHide: true, stdio: 'ignore' }
  );
  const aria = new Aria2(port, 'probe');
  for (let i = 0; i < 50; i++) {
    try {
      await aria.getVersion();
      return { proc, aria };
    } catch (e) {
      await sleep(200);
    }
  }
  throw new Error('aria2 未就绪');
}

const HEADERS = Object.keys(api.headers).map((k) => `${k}: ${api.headers[k]}`);

function common(dir, extra) {
  return Object.assign(
    {
      dir,
      split: '4',
      'max-connection-per-server': '4',
      'min-split-size': '1M',
      continue: 'true',
      'auto-file-renaming': 'false',
      'allow-overwrite': 'true',
      header: HEADERS,
    },
    extra || {}
  );
}

async function main() {
  const session = require('electron').session.defaultSession;
  const bili = new BiliClient(session);

  // ---- 取一个真实视频的多档流 ----
  const pop = await bili._json(`${api.urls.popular}?ps=1&pn=1`);
  const bvid = pop.data.list[0].bvid;
  const info = await bili.videoInfo(bvid);
  const play = await bili.playurl(bvid, info.cid, 127);
  const { videos } = extractStreams(play);
  console.log(`样本：${bvid} 《${info.title}》`);
  console.log('可用视频轨：' + videos.map((v) => `${v.id}(${v.height}P/${(v.sizeBytes / 1048576).toFixed(1)}MB)`).join('  '));
  if (videos.length < 2) {
    console.log('⚠ 这个视频只有一档流，换不了档，无法做对照 —— 跳过。');
    return;
  }
  const big = videos[0]; // 最高档
  const small = videos[videos.length - 1]; // 最低档
  console.log(`A/B 对照用：小档 ${small.id}(${small.height}P) → 大档 ${big.id}(${big.height}P)\n`);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const port = await freePort();
  const { proc, aria } = await startAria(port);

  const NAME = 'X.video.m4s';
  const target = path.join(OUT, NAME);
  const ctl = target + '.aria2';

  try {
    // ================= A) 留残留 → 换档提交 =================
    console.log('===== A) 保留上一档残留，换到更高档提交 =====');
    const gA1 = await aria.addUri(
      small.urls,
      common(OUT, { out: NAME, 'max-download-limit': '400K' })
    );
    // 等它下出一点数据
    for (let i = 0; i < 40; i++) {
      const s = await aria.tellStatus(gA1, ['completedLength', 'status']).catch(() => null);
      if (s && Number(s.completedLength) > 400000) break;
      await sleep(250);
    }
    const sA1 = await aria.tellStatus(gA1, ['completedLength', 'totalLength']);
    console.log(`  ① 小档下了一半就被打断：已下 ${sA1.completedLength} / 共 ${sA1.totalLength} 字节`);
    await aria.forceRemove(gA1).catch(() => {});
    await sleep(500);
    console.log(`  ② 残留文件：${fs.existsSync(target) ? fs.statSync(target).size + ' 字节' : '无'}` +
      `；控制文件：${fs.existsSync(ctl) ? '存在' : '不存在'}`);

    // 换成大档，同名同路径提交（同样限速，便于和 B 组对比「起步时的已完成字节」）
    const gA2 = await aria.addUri(big.urls, common(OUT, { out: NAME, 'max-download-limit': '400K' }));
    await sleep(1500);
    const sA2 = await aria.tellStatus(gA2, ['completedLength', 'totalLength', 'status', 'errorMessage']);
    console.log(
      `  ③ 换大档提交后：completedLength=${sA2.completedLength} / totalLength=${sA2.totalLength}（status=${sA2.status}）`
    );
    if (sA2.status === 'error') {
      console.log(`     errorMessage = ${sA2.errorMessage}`);
      console.log('  ⇒ ★★ 残留控制文件让「换档重下」直接报错 —— 这正是「第一次失败之后怎么重试都失败」的同类症状');
    } else if (Number(sA2.completedLength) > 0) {
      console.log(`  ⇒ ★ 被当成断点续传：拿小档的 ${sA2.completedLength} 字节接着写大档文件（静默损坏）`);
    } else {
      console.log('  ⇒ 从 0 开始');
    }
    await aria.forceRemove(gA2).catch(() => {});
    await aria.removeDownloadResult(gA2).catch(() => {});
    await sleep(400);

    // ================= B) 清掉残留 → 再提交 =================
    console.log('\n===== B) 提交前先清掉残留（= 修复后的行为）=====');
    fs.rmSync(target, { force: true });
    fs.rmSync(ctl, { force: true });
    console.log(`  ① 清理后：分片${fs.existsSync(target) ? '仍存在' : '已删除'}；控制文件${fs.existsSync(ctl) ? '仍存在' : '已删除'}`);

    const gB = await aria.addUri(big.urls, common(OUT, { out: NAME, 'max-download-limit': '400K' }));
    await sleep(1500);
    const sB = await aria.tellStatus(gB, ['completedLength', 'totalLength', 'status']);
    console.log(
      `  ② 提交后：completedLength=${sB.completedLength} / totalLength=${sB.totalLength}（status=${sB.status}）`
    );
    console.log(
      sB.status === 'error'
        ? '  ⇒ 报错'
        : Number(sB.completedLength) < 400000
        ? '  ⇒ ★ 正常：从 0 起步（限速 400K 下 1.5s 只可能到 ~600KB 以内）'
        : '  ⇒ 起步就带着残留字节'
    );
    await aria.forceRemove(gB).catch(() => {});
  } finally {
    try {
      proc.kill();
    } catch (e) {
      /* ignore */
    }
    fs.rmSync(OUT, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('探针失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
