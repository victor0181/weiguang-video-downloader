// Windows 控制台默认 GBK(936)，Node/Electron 输出的是 UTF-8 字节，中文会显示成乱码。
if (process.platform === 'win32' && process.stdout && process.stdout.isTTY) {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore', windowsHide: true });
  } catch (e) {
    /* ignore */
  }
}

/**
 * _dy-4k-probe.js —— 定位「抖音 4K 档下载失败」的探测脚本（在 Electron 环境下跑）
 *
 * 用法：
 *   electron.exe tools/_dy-4k-probe.js "分享链接/URL"
 *   BD_DY_QN=<档位id> electron.exe tools/_dy-4k-probe.js        （默认取最高档）
 *
 * 流程：解析 → 打印各档 URL 特征 → 对目标档：
 *   [A] 用 node 原生 https 对每条 url 发 Range 请求（0-1023），看状态码/跳转；
 *   [B] 用与 _runDirect 完全相同的参数提交 aria2，观察 20s 内的状态与错误信息；
 * 最后清理，不落完整文件。
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const { app } = require('electron');

const SRC = path.join(__dirname, '..', 'src', 'main');
const { DouyinClient } = require(path.join(SRC, 'douyin'));
const { Config, getBin, getBinDir } = require(path.join(SRC, 'config'));
const { buildTasks } = require(path.join(SRC, 'downloader'));
const { buildQualities, pickQuality } = require(path.join(SRC, 'douyin'));
const { Aria2 } = require(path.join(SRC, 'aria2'));
const { api } = require(path.join(SRC, 'api'));

const ARIA_SECRET = 'video-downloader';
const OUT_DIR = path.join(__dirname, '_dy4k_out');
const USERDATA = path.join(__dirname, '_dy4kprof');

try {
  fs.rmSync(USERDATA, { recursive: true, force: true });
} catch (e) { /* ignore */ }
try {
  fs.mkdirSync(USERDATA, { recursive: true });
  app.setPath('userData', USERDATA);
  app.setPath('cache', path.join(USERDATA, 'Cache'));
} catch (e) { /* ignore */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      return aria;
    } catch (e) {
      await sleep(300);
    }
  }
  throw new Error('aria2 未就绪');
}

/** 对单条 URL 发 Range 探测，返回 { status, location, server, len, err } */
function probeUrl(url, headers) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return resolve({ err: '非法 URL: ' + e.message });
    }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(
      u,
      { headers: Object.assign({}, headers, { Range: 'bytes=0-1023' }), timeout: 15000 },
      (res) => {
        res.resume();
        resolve({
          status: res.statusCode,
          location: res.headers.location || '',
          server: res.headers.server || '',
          range: res.headers['content-range'] || '',
          len: res.headers['content-length'] || '',
          ctype: res.headers['content-type'] || '',
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', (e) => resolve({ err: e.message }));
  });
}

app.whenReady().then(async () => {
  let ariaProc = null;
  let douyin = null;
  try {
    console.log('\n============ 抖音 4K 下载失败探测 ============\n');

    const input = process.env.BD_DY_URL || process.argv[2] || '';
    if (!input) throw new Error('请传入抖音链接');

    douyin = new DouyinClient();
    const media = await douyin.resolve(input);
    console.log('解析成功：' + String(media.title).slice(0, 40));

    console.log('\n各档位 URL 首条特征：');
    for (const q of media.qualities) {
      const u = q.urls[0] || '';
      let host = '';
      try {
        host = new URL(u).host;
      } catch (e) {
        host = '(parse-fail)';
      }
      console.log(
        `  id=${String(q.id).padEnd(4)} ${q.label.padEnd(6)} ${q.codec}  size=${(q.sizeBytes / 1048576).toFixed(0).padStart(5)}MB  urls=${q.urls.length}  host=${host}`
      );
      console.log(`      url[0]=${u.slice(0, 150)}`);
    }

    const qn = process.env.BD_DY_QN || media.qualities[0].id;
    const q = pickQuality(media.qualities, qn);
    if (!q) throw new Error('找不到档位 ' + qn);
    console.log(`\n目标档位：id=${q.id} ${q.label} ${q.codec} ${(q.sizeBytes / 1048576).toFixed(0)}MB`);

    // ---------- [A] node 原生 Range 探测每条 url ----------
    console.log('\n[A] 逐条 URL Range 探测（带 douyin headers）:');
    for (let i = 0; i < q.urls.length; i++) {
      const r = await probeUrl(q.urls[i], api.douyin.headers);
      console.log(`  url[${i}] → ${JSON.stringify(r).slice(0, 220)}`);
    }

    // ---------- [B] aria2 按真实参数提交 ----------
    console.log('\n[B] aria2 按下载器参数提交（观察 25s）:');
    const port = await getFreePort();
    ariaProc = spawn(
      getBin('aria2c.exe'),
      [`--rpc-listen-port=${port}`, `--conf-path=${getBin('aria2c.conf')}`, `--rpc-secret=${ARIA_SECRET}`],
      { cwd: getBinDir(), windowsHide: true }
    );
    const aria = await waitAria(port);
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

    const config = new Config();
    config.patch({ savePath: OUT_DIR, concurrency: 1, fileRule: '{title}', folderRule: '', saveCover: false, saveNfo: false });
    const tasks = buildTasks(media, config.all(), { parts: [1], videoQn: q.id, audioQn: 0 });
    const t = tasks[0];

    // 复刻 _runDirect 的取流与提交过程（不走 Downloader，避免整段下载）
    const detail = await douyin.detail(media.awemeId);
    const q2 = pickQuality(buildQualities(detail), t.videoQn);
    if (!q2) throw new Error('下载期重解析丢失档位 ' + t.videoQn);
    console.log(`  下载期重解析得到档位：id=${q2.id} ${q2.label} ${q2.codec}`);
    console.log(`  URL 与解析期一致：${JSON.stringify(q2.urls) === JSON.stringify(q.urls)}`);
    t.stream = q2;

    const dir = OUT_DIR;
    const common = {
      dir,
      split: '8',
      'max-connection-per-server': '8',
      'min-split-size': '15M',
      continue: 'true',
      'auto-file-renaming': 'false',
      'allow-overwrite': 'true',
      header: Object.keys(api.douyin.headers).map((k) => `${k}: ${api.douyin.headers[k]}`),
    };
    const gid = await aria.addUri(t.stream.urls, Object.assign({}, common, { out: path.basename(t.fileName + '.mp4') }));
    console.log('  gid=' + gid);

    let last = '';
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      const s = await aria.tellStatus(gid, [
        'status', 'completedLength', 'totalLength', 'downloadSpeed', 'errorCode', 'errorMessage',
      ]).catch(() => null);
      if (!s) continue;
      const line = `${s.status} ${(Number(s.completedLength) / 1048576).toFixed(1)}MB / ${(
        Number(s.totalLength) / 1048576
      ).toFixed(0)}MB  speed=${(Number(s.downloadSpeed) / 1048576).toFixed(1)}MB/s  err=${s.errorCode || ''} ${s.errorMessage || ''}`;
      if (line !== last) {
        last = line;
        console.log('  [' + (i + 1) + 's] ' + line);
      }
      if (s.status === 'error' || s.status === 'complete') break;
    }
    await aria.forceRemove(gid).catch(() => {});
    console.log('\n（已取消 aria2 任务并清理）');
  } catch (e) {
    console.log('\n❌ 探测异常：' + e.message);
    console.log(e.stack);
  } finally {
    if (douyin) {
      try {
        douyin.destroy();
      } catch (e) { /* ignore */ }
    }
    if (ariaProc) {
      try {
        ariaProc.kill();
      } catch (e) { /* ignore */ }
    }
    setTimeout(() => process.exit(0), 800);
  }
});

app.on('window-all-closed', () => {});
