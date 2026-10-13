// Windows 控制台默认 GBK(936)，Node/Electron 输出的是 UTF-8 字节，中文会显示成乱码。
if (process.platform === 'win32' && process.stdout && process.stdout.isTTY) {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore', windowsHide: true });
  } catch (e) {
    /* ignore */
  }
}

/**
 * _audio-e2e.js —— 「只下载音频」端到端自检（在 Electron 环境下跑真实链路）
 *
 * 用法：
 *   electron.exe tools/_audio-e2e.js
 *
 * 流程：起 aria2 → 选一个较短的热门视频 → 解析 → 分别按 m4a / mp3 建「音频任务」
 *       → 走完整下载通路 → 用 ffmpeg 校验产物「有音轨、无视频轨」。
 *
 * 环境变量：
 *   BD_TEST_OUT     产物输出目录（默认 tools/_audiotest_out）
 *   BD_TEST_TIMEOUT 整体超时秒数（默认 300）
 *   BD_TEST_BVID    指定测试视频（默认自动挑一个热门短视频）
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { app, session } = require('electron');

const SRC = path.join(__dirname, '..', 'src', 'main');
const { BiliClient } = require(path.join(SRC, 'bili'));
const { Config, getBin, getBinDir } = require(path.join(SRC, 'config'));
const { Downloader, buildTasks } = require(path.join(SRC, 'downloader'));
const { resolve: resolveLink } = require(path.join(SRC, 'resolver'));
const { Aria2 } = require(path.join(SRC, 'aria2'));

const ARIA_SECRET = 'video-downloader';
const OUT_DIR = process.env.BD_TEST_OUT || path.join(__dirname, '_audiotest_out');
const TIMEOUT = Number(process.env.BD_TEST_TIMEOUT || 300) * 1000;

// userData 隔离：别污染 %APPDATA%\Electron（那是所有未改名的 Electron 程序共用的目录）
const PROFILE = process.env.BD_USERDATA || path.join(__dirname, '_audiotest_prof');
try {
  fs.mkdirSync(PROFILE, { recursive: true });
  app.setPath('userData', PROFILE);
} catch (e) {
  console.error('  [profile] set userData failed: ' + e.message);
}

let pass = 0;
let fail = 0;
const check = (label, cond, detail) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? '  → ' + detail : ''}`);
};

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitAria(port, ms = 15000) {
  const aria = new Aria2(port, ARIA_SECRET);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      await aria.getVersion();
      return;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('aria2 未就绪');
}

/**
 * 用 ffmpeg 读一遍产物，返回错误输出（用来判断音/视频轨数量）。
 *
 * ★ 必须用异步 spawn 而不是 spawnSync：本机环境下 spawnSync 拿不到子进程输出
 *   （status=null、stderr=undefined），会误判成「无法解析」。
 */
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

/** 跑一轮：按指定格式建音频任务并等它结束 */
function runRound(downloader, media, cfg, format, outDir) {
  const tasks = buildTasks(media, cfg, {
    parts: media.parts.map((p) => p.index),
    videoQn: 32,
    audioQn: 30232,
    mode: 'audio',
    audioFormat: format,
  });
  check(`[${format}] 只生成 1 个任务`, tasks.length === 1, `${tasks.length} 个`);
  check(`[${format}] 任务标记为音频`, tasks[0].kind === 'audio', tasks[0].kind);
  check(`[${format}] 输出格式正确`, tasks[0].audioFormat === format, tasks[0].audioFormat);

  let last = '';
  const onUpdate = (snap) => {
    const t = snap[0];
    if (!t) return;
    const line = `${String(t.status).padEnd(12)} ${String(t.progress).padStart(3)}%  ${t.speedText || ''} ${t.totalText || ''}`;
    if (line !== last) {
      last = line;
      process.stdout.write('\r      ' + line.padEnd(64));
    }
  };
  downloader.on('update', onUpdate);

  return new Promise((resolve) => {
    const done = new Promise((r) => downloader.once('all-finished', r));
    const iv = setInterval(() => {
      const t = downloader.tasks[0];
      if (t && t.status === 'error') {
        clearInterval(iv);
        downloader.removeListener('update', onUpdate);
        resolve({ ok: false, error: t.error, file: null });
      }
    }, 400);
    done.then(() => {
      clearInterval(iv);
      downloader.removeListener('update', onUpdate);
      const t = downloader.tasks[0];
      resolve({ ok: t.status === 'done', error: t.error, file: t.outFile, audioName: t.audioName, qnName: t.qnName });
    });
    downloader.addTasks(tasks);
  });
}

app.whenReady().then(async () => {
  const hardExit = setTimeout(() => {
    console.log('\n⏱  超时，强制结束。');
    process.exit(9);
  }, TIMEOUT);

  let ariaProc = null;
  try {
    console.log('\n============ 「只下载音频」端到端自检 ============\n');

    console.log('[1] 启动 aria2');
    const port = await getFreePort();
    ariaProc = spawn(
      getBin('aria2c.exe'),
      [`--rpc-listen-port=${port}`, `--conf-path=${getBin('aria2c.conf')}`, `--rpc-secret=${ARIA_SECRET}`],
      { cwd: getBinDir(), windowsHide: true }
    );
    ariaProc.on('error', (e) => console.error('  aria2 启动错误：', e.message));
    await waitAria(port);
    check('aria2 RPC 就绪', true, 'port=' + port);

    console.log('\n[2] 准备环境');
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const f of fs.readdirSync(OUT_DIR)) fs.rmSync(path.join(OUT_DIR, f), { force: true, recursive: true });

    const config = new Config();
    config.patch({
      savePath: OUT_DIR,
      videoQn: 32,
      audioQn: 30232,
      audioFormat: 'm4a',
      concurrency: 1,
      fileRule: '{title}',
      folderRule: '',
      // 附加内容全关：这一轮只关心音轨本身
      saveCover: false,
      saveDanmaku: false,
      saveAss: false,
      saveSubtitle: false,
      saveNfo: false,
      keepVideo: false,
      keepAudio: false,
      autoShutdown: false,
    });
    check('配置写入', config.get('savePath') === OUT_DIR, OUT_DIR);

    console.log('\n[3] 选测试视频');
    const bili = new BiliClient(session.defaultSession);
    let bvid = process.env.BD_TEST_BVID || '';
    if (!bvid) {
      const pop = await (await bili._fetch('https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1')).json();
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

    console.log('\n[4] 音轨可用性探查（音频通路的第一步）');
    const d = new Downloader({ bili, config });
    const probeTask = { bvid: media.bvid, cid: media.parts[0].cid, audioQn: 30232 };
    await d._resolveAudioStream(probeTask);
    check('取到音轨地址', !!(probeTask.aStream && probeTask.aStream.urls.length), probeTask.aStream.desc);
    check('标记了是否走渐进流兜底', typeof probeTask.progressive === 'boolean', 'progressive=' + probeTask.progressive);
    console.log(`      实际音轨：${probeTask.audioName}`);

    // ---------- 逐格式跑真实下载 ----------
    let index = 0;
    for (const format of ['m4a', 'mp3']) {
      index++;
      console.log(`\n[5.${index}] 真实下载（${format}）`);
      const dl = new Downloader({ bili, config });
      dl.attachAria(port, ARIA_SECRET);
      const r = await runRound(dl, media, config.all(), format, OUT_DIR);
      process.stdout.write('\n');
      check(`[${format}] 任务完成`, r.ok, r.ok ? 'done' : String(r.error || '').slice(0, 120));

      const listNow = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.' + format));
      check(`[${format}] 生成产物`, listNow.length === 1, listNow.join(', ') || '(无)');
      if (listNow.length) {
        const full = path.join(OUT_DIR, listNow[0]);
        const size = fs.statSync(full).size;
        check(`[${format}] 体积合理（>20KB）`, size > 20 * 1024, (size / 1024).toFixed(0) + ' KB');

        const pr = await probe(full);
        check(`[${format}] ffmpeg 可解析`, pr.code === 0, pr.code === 0 ? 'exit 0' : 'exit ' + pr.code);
        // 只统计「输入」段（Stream mapping 之后是输出段，那里也带 Stream 行，会把数量算重）
        const inputPart = pr.text.split('Stream mapping:')[0];
        const audioCount = (inputPart.match(/Stream #\d+:\d+.*Audio:/g) || []).length;
        const videoCount = (inputPart.match(/Stream #\d+:\d+.*Video:/g) || []).length;
        check(`[${format}] 含 1 条音轨`, audioCount === 1, '音频轨 ' + audioCount + ' 条');
        check(`[${format}] 不含视频轨`, videoCount === 0, '视频轨 ' + videoCount + ' 条');
        const dur = (inputPart.match(/Duration: ([0-9:.]+)/) || [, '?'])[1];
        check(`[${format}] 时长与源一致`, !!dur && dur !== '?', dur);
      }
    }

    console.log(`\n============ 结果：${pass} 通过 / ${fail} 失败 ============\n`);
  } catch (e) {
    console.error('\n💥 自检异常：' + (e && e.stack ? e.stack : e));
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
});
