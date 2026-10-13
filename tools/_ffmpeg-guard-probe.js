'use strict';

/**
 * _ffmpeg-guard-probe.js —— 验证 ffmpeg 封装的「看门狗 + 取消」两处加固
 *
 * 背景：src/main/ffmpeg.js 的 runFFmpeg 以前既没有超时、也不响应取消 ——
 *   ffmpeg 一旦卡住，任务会永远停在「混流中/处理音频」，界面点「取消」也杀不掉它。
 *
 * 本探针跑三组：
 *   ① 正常任务：确认进度行照常解析、且看门狗不会误杀（回归保护）
 *   ② 卡死任务：给一个「只读 stdin、永不产出」的 ffmpeg，看是否在 idleMs 后被终止
 *   ③ 取消任务：跑到一半 abort，看 Promise 是否立刻以「已取消」拒绝、子进程是否真没了
 *
 * 运行：node tools/_node-shim.js _ffmpeg-guard-probe.js
 */

const path = require('path');
const fs = require('fs');
// ★ 注意：本机 spawnSync 拿不到子进程输出（status=null/空），统计进程必须用异步 spawn
const { spawn } = require('child_process');

const SRC = path.join(__dirname, '..', 'src', 'main');
const { runFFmpeg, mergeDash } = require(path.join(SRC, 'ffmpeg'));
const { getBin } = require(path.join(SRC, 'config'));

const OUT = path.join(__dirname, '_ffguard_out');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
function ck(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✅ ' + name);
  } else {
    fail++;
    console.log('  ❌ ' + name + (extra ? '  — ' + extra : ''));
  }
}

/** 数一数当前有几个 ffmpeg.exe 在跑（异步 spawn + tasklist 纯文本解析） */
function ffmpegCount() {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try {
      p = spawn('tasklist', ['/FI', 'IMAGENAME eq ffmpeg.exe', '/NH'], { windowsHide: true });
    } catch (e) {
      return resolve(-1);
    }
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('error', () => resolve(-1));
    p.on('close', () => resolve((out.match(/ffmpeg\.exe/gi) || []).length));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('ffmpeg = ' + getBin('ffmpeg.exe') + '\n');

  // ---------------------------------------------------------------- ① 正常任务
  console.log('① 正常任务（生成 2 秒音频 → m4a）：看门狗不应误杀');
  {
    const out = path.join(OUT, 'ok.m4a');
    let lines = 0;
    const t0 = Date.now();
    await runFFmpeg(
      ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', out],
      () => lines++,
      { idleMs: 60000 }
    );
    ck('任务成功产出文件', fs.existsSync(out) && fs.statSync(out).size > 1000);
    ck('进度行被解析（lines > 0）', lines > 0, 'lines=' + lines);
    console.log(`  · 耗时 ${Date.now() - t0} ms`);
  }

  // ---------------------------------------------------------------- ② 卡死任务
  console.log('\n② 卡死任务（-i pipe:0，只读 stdin、永不产出）：应在 idleMs 后被终止');
  {
    const t0 = Date.now();
    let err = null;
    try {
      // -hide_banner 让它连横幅都不打，确保「完全无输出」
      await runFFmpeg(['-hide_banner', '-i', 'pipe:0', '-f', 'null', '-'], null, { idleMs: 2500 });
    } catch (e) {
      err = e;
    }
    const dt = Date.now() - t0;
    ck('如期被终止（抛错）', !!err, '没有抛错');
    ck('错误信息说明是"卡死"', !!err && /卡死/.test(err.message), err && err.message);
    ck('在 idleMs 附近触发（2.5~8 秒）', dt >= 2400 && dt < 8000, dt + ' ms');
    console.log(`  · ${err ? err.message : '(无)'}`);
  }

  // ---------------------------------------------------------------- ③ 取消
  console.log('\n③ 取消任务（跑一条慢转码，1.5 秒后 abort）：应立即拒绝且子进程消失');
  {
    const before = await ffmpegCount();
    const ctl = new AbortController();
    const out = path.join(OUT, 'cancel.mp4');
    const slowArgs = [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=1200',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1200',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
      out,
    ];
    const t0 = Date.now();
    const p = runFFmpeg(slowArgs, null, { signal: ctl.signal, idleMs: 600000 }).then(
      () => ({ ok: true }),
      (e) => ({ ok: false, err: e })
    );
    await sleep(1500);
    const during = await ffmpegCount();
    ctl.abort();
    const r = await p;
    const dt = Date.now() - t0;
    await sleep(600);
    const after = await ffmpegCount();

    ck('取消后立刻以错误结束', r.ok === false, JSON.stringify(r));
    ck('错误信息是"已取消"', !r.ok && /已取消/.test(r.err.message), !r.ok && r.err.message);
    ck('取消响应及时（< 4 秒）', dt < 4000, dt + ' ms');
    ck(
      'ffmpeg 子进程确实没了（回到基线）',
      after <= before,
      `before=${before} during=${during} after=${after}`
    );
    console.log(`  · 取消到结束 ${dt} ms；子进程数 ${before} → ${during} → ${after}`);
    if (fs.existsSync(out)) fs.rmSync(out, { force: true });
  }

  console.log(`\n合计：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(OUT, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('探针异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
