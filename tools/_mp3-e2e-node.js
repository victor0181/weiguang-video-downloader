'use strict';

/**
 * _mp3-e2e-node.js —— 「只下载音频（M4A / MP3）」端到端自检 · 纯 Node 版
 *
 * ★ 为什么有这一版：本会话里 GUI 模式的 electron.exe 会被环境静默拦掉
 *   （退出码 0、脚本根本没跑），tools/_audio-e2e.js 起不来。这里用
 *   Module._load 钩子把 `electron` 换成一个最小桩（只有 app.getPath 与
 *   session.fetch），其余链路——B站接口、aria2 真实下载、ffmpeg 落地——
 *   全都是线上真跑，不是模拟。
 *
 * 重点验证本次新增的「MP3 直提 / 转码」分流：
 *   - 源音轨是 AAC（B站 的常态）→ 必须转码，且界面上要收到「需要一点时间」的提示；
 *   - 产物必须是合法 MP3，且只有 1 条音轨、0 条视频轨。
 *
 * 跑法：node tools/_mp3-e2e-node.js
 * 环境变量：BD_TEST_OUT / BD_TEST_TIMEOUT / BD_TEST_BVID（同 _audio-e2e.js）
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Module = require('module');

// ---------------------------------------------------------------- electron 桩
const PROFILE = path.join(__dirname, '_mp3e2e_prof');
fs.mkdirSync(PROFILE, { recursive: true });

const ELEC_STUB = {
  app: {
    getPath: (n) => (n === 'userData' ? PROFILE : path.join(PROFILE, n)),
    setPath: () => {},
    isPackaged: false,
    getVersion: () => '0.0.0-stub',
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
  },
  session: { defaultSession: null },
  BrowserWindow: class {},
  net: {},
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return ELEC_STUB;
  return origLoad.apply(this, arguments);
};

const SRC = path.join(__dirname, '..', 'src', 'main');
const { BiliClient } = require(path.join(SRC, 'bili'));
const { Config, getBin, getBinDir } = require(path.join(SRC, 'config'));
const { Downloader, buildTasks } = require(path.join(SRC, 'downloader'));
const { resolve: resolveLink } = require(path.join(SRC, 'resolver'));
const { Aria2 } = require(path.join(SRC, 'aria2'));
const { probeAudioCodec } = require(path.join(SRC, 'ffmpeg'));

const ARIA_SECRET = 'video-downloader';
const OUT_DIR = process.env.BD_TEST_OUT || path.join(__dirname, '_mp3e2e_out');
const TIMEOUT = Number(process.env.BD_TEST_TIMEOUT || 300) * 1000;

let pass = 0;
let fail = 0;
const check = (label, cond, detail) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`);
};

/**
 * 用 Node 原生 fetch 假冒 Electron 的 session：
 * 只需要 fetch() 与 cookies.set()（bili.js 会用到的全部）。
 */
function fakeSession() {
  return {
    fetch: (url, opts) => fetch(url, opts),
    cookies: { set: async () => {}, get: async () => [], flushStore: async () => {} },
  };
}

/** 用 ffmpeg 读一遍产物（异步 spawn：本机 spawnSync 拿不到子进程输出） */
function probe(file) {
  return new Promise((resolve) => {
    const p = spawn(getBin('ffmpeg.exe'), ['-hide_banner', '-i', file, '-f', 'null', '-'], {
      windowsHide: true,
    });
    let text = '';
    const grab = (d) => {
      text += d.toString();
    };
    p.stdout.on('data', grab);
    p.stderr.on('data', grab);
    p.on('error', (e) => resolve({ code: -1, text: 'spawn error: ' + e.message }));
    p.on('close', (code) => resolve({ code, text }));
  });
}

/** 跑一轮：按指定格式建音频任务，全程记录界面收到的提示，等它结束 */
function runRound(downloader, media, cfg, format) {
  const tasks = buildTasks(media, cfg, {
    parts: media.parts.map((p) => p.index),
    videoQn: 32,
    audioQn: 30232,
    mode: 'audio',
    audioFormat: format,
  });
  check(`[${format}] 只生成 1 个任务`, tasks.length === 1, tasks.length + ' 个');
  check(`[${format}] 任务标记为音频`, tasks[0].kind === 'audio', String(tasks[0].kind));

  const hints = []; // 界面实际看到的 mergeHint 序列
  let sawTranscoding = false;
  const onUpdate = (snap) => {
    const t = snap[0];
    if (!t) return;
    if (t.mergeHint && hints[hints.length - 1] !== t.mergeHint) hints.push(t.mergeHint);
    if (t.mergeTranscoding) sawTranscoding = true;
  };
  downloader.on('update', onUpdate);

  return new Promise((resolve) => {
    const iv = setInterval(() => {
      const t = downloader.tasks[0];
      if (t && t.status === 'error') {
        clearInterval(iv);
        downloader.removeListener('update', onUpdate);
        resolve({ ok: false, error: t.error });
      }
    }, 400);
    downloader.once('all-finished', () => {
      clearInterval(iv);
      downloader.removeListener('update', onUpdate);
      const t = downloader.tasks[0];
      resolve({ ok: t.status === 'done', error: t.error, task: t, hints, sawTranscoding });
    });
    downloader.addTasks(tasks);
  });
}

async function main() {
  const hardExit = setTimeout(() => {
    console.log('\n超时，强制结束。');
    process.exit(9);
  }, TIMEOUT);

  let ariaProc = null;
  try {
    console.log('\n===== 「只下载音频」端到端自检（纯 Node 版）=====\n');

    console.log('[1] 启动 aria2');
    const port = await new Promise((res, rej) => {
      const s = require('net').createServer();
      s.on('error', rej);
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => res(p));
      });
    });
    ariaProc = spawn(
      getBin('aria2c.exe'),
      ['--rpc-listen-port=' + port, '--conf-path=' + getBin('aria2c.conf'), '--rpc-secret=' + ARIA_SECRET],
      { cwd: getBinDir(), windowsHide: true }
    );
    const aria = new Aria2(port, ARIA_SECRET);
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      try {
        await aria.getVersion();
        ready = true;
      } catch (e) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    check('aria2 RPC 就绪', ready, 'port=' + port);
    if (!ready) throw new Error('aria2 未就绪');

    console.log('\n[2] 准备环境');
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const config = new Config();
    config.patch({
      savePath: OUT_DIR,
      videoQn: 32,
      audioQn: 30232,
      audioFormat: 'm4a',
      concurrency: 1,
      fileRule: '{title}',
      folderRule: '',
      saveCover: false,
      saveDanmaku: false,
      saveAss: false,
      saveSubtitle: false,
      saveNfo: false,
      keepVideo: false,
      keepAudio: false,
      autoShutdown: false,
    });

    console.log('\n[3] 选测试视频');
    const bili = new BiliClient(fakeSession());
    let bvid = process.env.BD_TEST_BVID || '';
    if (!bvid) {
      const pop = await bili._json('https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1');
      const list = (pop.data && pop.data.list) || [];
      check('热门列表可达', list.length > 0, list.length + ' 条');
      const cand = list
        .filter((v) => v.duration > 20 && v.duration < 600 && (!v.pages || v.pages.length === 1))
        .sort((a, b) => a.duration - b.duration)[0];
      if (!cand) throw new Error('找不到合适的测试视频');
      bvid = cand.bvid;
    }
    const media = await resolveLink(bili, bvid);
    check('解析成功', !!media && media.parts.length > 0, `${media.type} / ${media.parts.length} 集`);
    console.log(`      选用：${bvid}  ${media.duration}s  ${String(media.title).slice(0, 34)}`);

    console.log('\n[4] 音轨可用性探查');
    const d0 = new Downloader({ bili, config });
    const probeTask = { bvid: media.bvid, cid: media.parts[0].cid, audioQn: 30232 };
    await d0._resolveAudioStream(probeTask);
    check('取到音轨地址', !!(probeTask.aStream && probeTask.aStream.urls.length), probeTask.aStream.desc);
    console.log(`      实际音轨：${probeTask.audioName}（codecs=${probeTask.aStream.codecs || '未知'}）`);

    const summary = {};
    for (const format of ['m4a', 'mp3']) {
      console.log(`\n[5] 真实下载（${format}）`);
      const dl = new Downloader({ bili, config });
      dl.attachAria(port, ARIA_SECRET);
      const r = await runRound(dl, media, config.all(), format);
      check(`[${format}] 任务完成`, r.ok, r.ok ? 'done' : String(r.error || '').slice(0, 140));
      check(`[${format}] 界面收到过程提示`, r.hints.length > 0, JSON.stringify(r.hints));
      summary[format] = r;

      const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.' + format));
      check(`[${format}] 生成产物`, files.length === 1, files.join(', ') || '(无)');
      if (!files.length) continue;

      const full = path.join(OUT_DIR, files[0]);
      summary[format].filePath = full;
      const size = fs.statSync(full).size;
      check(`[${format}] 体积合理（>20KB）`, size > 20 * 1024, (size / 1024).toFixed(0) + ' KB');

      const pr = await probe(full);
      check(`[${format}] ffmpeg 可解析`, pr.code === 0, pr.code === 0 ? 'exit 0' : 'exit ' + pr.code);
      const inputPart = pr.text.split('Stream mapping:')[0];
      const audioCount = (inputPart.match(/Stream #\d+:\d+.*Audio:/g) || []).length;
      const videoCount = (inputPart.match(/Stream #\d+:\d+.*Video:/g) || []).length;
      check(`[${format}] 含 1 条音轨`, audioCount === 1, '音频轨 ' + audioCount + ' 条');
      check(`[${format}] 不含视频轨`, videoCount === 0, '视频轨 ' + videoCount + ' 条');
      const codec = (inputPart.match(/Audio:\s*([A-Za-z0-9_]+)/) || [, '?'])[1];
      // 注意：.m4a 容器里装的是 aac，不是「m4a」这个容器名，别拿扩展名去比
      const wantCodec = format === 'mp3' ? 'mp3' : 'aac';
      check(`[${format}] 产物编码正确`, codec === wantCodec, 'probe=' + codec);
    }

    // ---------- 本次新增行为的判定 ----------
    console.log('\n[6] MP3 直提 / 转码 分流判定');
    const mp3 = summary.mp3 || {};
    check('mp3 全程只给过一条提示', (mp3.hints || []).length === 1, JSON.stringify(mp3.hints));
    if (mp3.task) {
      check(
        'mp3 走的是转码（B站音轨是 AAC）',
        mp3.sawTranscoding === true,
        'mergeTranscoding=' + mp3.sawTranscoding + ' audioNote=' + (mp3.task.audioNote || '(空)')
      );
      check(
        '完成后已转码标记落到任务上',
        mp3.task.audioNote === '已转码',
        JSON.stringify(mp3.task.audioNote)
      );
      check('完成后提示已清空', !mp3.task.mergeHint, JSON.stringify(mp3.task.mergeHint || ''));
    }
    const m4a0 = summary.m4a || {};
    if (m4a0.filePath && fs.existsSync(m4a0.filePath)) {
      // m4a 产物是「无损拷贝」出来的，也就是源音轨本身 —— 直接探它最实在
      const srcCodec = await probeAudioCodec(m4a0.filePath);
      check(
        '源音轨确实不是 MP3（所以必须转码）',
        !!srcCodec && srcCodec !== 'mp3',
        'm4a 产物探得编码=' + srcCodec + '，接口自报 codecs=' + (probeTask.aStream.codecs || '未知')
      );
    }
    const m4a = summary.m4a || {};
    if (m4a.task) {
      check('m4a 未标记为转码', !m4a.sawTranscoding, 'mergeTranscoding=' + m4a.sawTranscoding);
    }

    console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
  } catch (e) {
    console.error('\n自检异常：' + (e && e.stack ? e.stack : e));
    fail++;
  } finally {
    clearTimeout(hardExit);
    if (ariaProc) {
      try {
        ariaProc.kill();
      } catch (e) {
        /* ignore */
      }
    }
    process.exit(fail === 0 ? 0 : 1);
  }
}

main();
