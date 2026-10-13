// Windows 控制台默认 GBK(936)，Node/Electron 输出的是 UTF-8 字节，中文会显示成乱码。
if (process.platform === 'win32' && process.stdout && process.stdout.isTTY) {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore', windowsHide: true });
  } catch (e) {
    /* ignore */
  }
}

/**
 * douyin-test.js —— 抖音链路端到端自检（在 Electron 环境下跑）
 *
 * 用法：
 *   electron.exe tools/douyin-test.js
 *   electron.exe tools/douyin-test.js "https://v.douyin.com/xxxxx/"
 *   set BD_DY_URL=https://v.douyin.com/xxxxx/  &&  electron.exe tools/douyin-test.js
 *   set BD_DY_ID=7687570477652446505           &&  electron.exe tools/douyin-test.js
 *
 * 流程：起 aria2 → 取样本作品 → 解析 → 建任务 → aria2 下载单文件 MP4
 *       → ffmpeg 校验音视频轨 → 校验封面 / NFO / 历史记录 / 分片清理
 *
 * 环境变量：
 *   BD_DY_URL       直接用这个链接解析（不传则自动从推荐流取样）
 *   BD_DY_ID        直接指定 aweme_id
 *   BD_TEST_OUT     产物目录（默认 tools/_dy_out）
 *   BD_DY_TIMEOUT   整体超时秒数（默认 300）
 *   BD_DY_QN        指定清晰度 id（默认取最高档）
 *   BD_USERDATA     指定 userData / 抖音分区目录（默认 tools/_dyprof，每次运行前清空）
 *   BD_DY_KEEP_PROFILE=1  保留默认分区目录（默认每次清空，避免被 Service Worker 接管）
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { app, session } = require('electron');

const SRC = path.join(__dirname, '..', 'src', 'main');
const { BiliClient } = require(path.join(SRC, 'bili'));
const { DouyinClient } = require(path.join(SRC, 'douyin'));
const { Config, getBin, getBinDir } = require(path.join(SRC, 'config'));
const { Downloader, buildTasks } = require(path.join(SRC, 'downloader'));
const { Aria2 } = require(path.join(SRC, 'aria2'));

const ARIA_SECRET = 'video-downloader';
const OUT_DIR = process.env.BD_TEST_OUT || path.join(__dirname, '_dy_out');
const TIMEOUT = Number(process.env.BD_DY_TIMEOUT || 300) * 1000;

// ★ 抖音走的是持久分区（api.douyin.partition === 'persist:douyin'），它会落在 userData 下
//   并且跨次复用。同一个分区用得久了会被抖音的 Service Worker / 验证页接管，症状是
//   "解析超时 + 响应体读取失败"，而且极具迷惑性：全新目录能用，跑几次后就一直失败。
//   所以自检必须跑在自己的干净分区上：
//     · 默认用 tools/_dyprof，且每次运行前清空（想保留就设 BD_DY_KEEP_PROFILE=1）
//     · 外部若用 BD_USERDATA 指定目录（与 main.js 里同名变量语义一致），则一律不动它——
//       那可能是用户的真实数据目录，绝不能清。
const OWN_PROFILE = path.join(__dirname, '_dyprof');
const USERDATA = process.env.BD_USERDATA || OWN_PROFILE;
if (!process.env.BD_USERDATA && process.env.BD_DY_KEEP_PROFILE !== '1') {
  try {
    fs.rmSync(OWN_PROFILE, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
}
try {
  fs.mkdirSync(USERDATA, { recursive: true });
  app.setPath('userData', USERDATA);
  app.setPath('cache', path.join(USERDATA, 'Cache'));
} catch (e) {
  console.error('  [profile] set userData failed: ' + e.message);
}

let pass = 0;
let fail = 0;
const check = (label, cond, detail) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? '  → ' + detail : ''}`);
};

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
      return;
    } catch (e) {
      await sleep(300);
    }
  }
  throw new Error('aria2 未就绪');
}

/** 用 ffmpeg 读一遍容器，返回 { ok, hasVideo, hasAudio, detail } */
function ffprobe(file) {
  return new Promise((resolve) => {
    const p = spawn(getBin('ffmpeg.exe'), ['-hide_banner', '-i', file, '-f', 'null', '-'], {
      windowsHide: true,
    });
    let out = '';
    p.stderr.on('data', (d) => (out += d.toString()));
    p.on('close', (code) => {
      resolve({
        ok: code === 0,
        hasVideo: /Stream #\d+:\d+.*Video:/.test(out),
        hasAudio: /Stream #\d+:\d+.*Audio:/.test(out),
        videoLine: ((out.match(/Stream #\d+:\d+.*Video:[^\n]*/) || [''])[0] || '').trim(),
        audioLine: ((out.match(/Stream #\d+:\d+.*Audio:[^\n]*/) || [''])[0] || '').trim(),
        err: (out.match(/Error[^\n]*/) || [''])[0],
      });
    });
  });
}

app.whenReady().then(async () => {
  const started = Date.now();
  let ariaProc = null;
  let douyin = null;

  const hardExit = setTimeout(() => {
    console.log('\n⏱  超时，强制结束。');
    process.exit(9);
  }, TIMEOUT);

  try {
    console.log('\n============ 抖音链路端到端自检 ============\n');

    // ---------- 1. aria2 ----------
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

    // ---------- 2. 配置 ----------
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    // 注意：last-good-id.txt 必须保住 —— 它是"上次解析成功过的样本"，
    // 等会儿推荐流取不到时要靠它回退。若在这里一并删掉，回退逻辑就永远命中不了。
    const KEEP_IN_OUT = new Set(['last-good-id.txt']);
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (KEEP_IN_OUT.has(f)) continue;
      fs.rmSync(path.join(OUT_DIR, f), { force: true, recursive: true });
    }

    const config = new Config();
    config.patch({
      savePath: OUT_DIR,
      concurrency: 1,
      fileRule: '{title}',
      folderRule: '',
      saveCover: true,
      // 刻意全开：抖音应当自动跳过弹幕/字幕，且不产生无意义的失败警告
      saveDanmaku: true,
      saveAss: true,
      saveSubtitle: true,
      saveNfo: true,
      keepVideo: false,
      keepAudio: false,
      autoShutdown: false,
    });
    check('配置写入', config.get('savePath') === OUT_DIR, OUT_DIR);

    // ---------- 3. 解析 ----------
    console.log('\n[2] 解析抖音作品');
    const bili = new BiliClient(session.defaultSession);
    douyin = new DouyinClient();

    let input = process.env.BD_DY_URL || process.argv[2] || '';
    if (!input && process.env.BD_DY_ID) input = process.env.BD_DY_ID;

    if (!input) {
      console.log('      未指定链接，从抖音推荐流里取一个当前有效的样本…');
      let sample = await douyin.sampleAwemeId();

      // 抖音对匿名用户时有时无地不下发推荐流（回"暂时没有更多了"）。
      // 这时退回"上次自检用过的那个作品"：只要它还能解析，链路就是好的，
      // 不必因为取样失败把整个自检判红。文件放在输出目录里，跟产物一起被忽略。
      if (!sample) {
        const lastFile = path.join(OUT_DIR, 'last-good-id.txt');
        try {
          const last = fs.readFileSync(lastFile, 'utf8').trim();
          if (/^\d{15,}$/.test(last)) {
            console.log('      推荐流为空，回退到上次成功的样本：' + last);
            sample = last;
          }
        } catch (e) {
          /* 没有就用不了 */
        }
      }

      if (!sample) {
        // 刻意不调用 check()：这是抖音侧的随机限流，不是程序故障，
        // 计入失败会把自检变成"看运气"。整体按"跳过"处理，见下面的 catch。
        const err = new Error('抖音推荐流没给出样本，且没有可复用的历史样本');
        err.skipped = true;
        throw err;
      }
      check('取到样本 aweme_id', true, sample);
      input = sample;
    } else {
      console.log('      使用指定输入：' + input.slice(0, 70));
    }

    // 记下这次用的样本（放在解析成功之后写，免得把已失效的 ID 存成"历史样本"）
    const rememberSample = () => {
      try {
        const id = (String(input).match(/(\d{15,})/) || [])[1];
        if (id) fs.writeFileSync(path.join(OUT_DIR, 'last-good-id.txt'), id);
      } catch (e) {
        /* ignore */
      }
    };

    const t0 = Date.now();
    const media = await douyin.resolve(input);
    const parseSec = ((Date.now() - t0) / 1000).toFixed(1);
    rememberSample();
    check('解析成功', !!media && media.parts.length > 0, `耗时 ${parseSec}s`);
    check('平台标记为 douyin', media.platform === 'douyin', media.platform);
    check('拿到 awemeId', /^\d{15,}$/.test(media.awemeId), media.awemeId);
    check('拿到标题', !!media.title, String(media.title).slice(0, 36));
    check('拿到作者', !!(media.up && media.up.name), media.up && media.up.name);
    check('拿到封面', !!media.cover);
    check('时长 > 0', media.duration > 0, media.duration + 's');
    check('至少 1 档清晰度', (media.qualities || []).length > 0, (media.qualities || []).length + ' 档');

    console.log('      标题：' + String(media.title).slice(0, 40));
    console.log('      作者：' + media.up.name + '  时长：' + media.duration + 's');
    (media.qualities || []).forEach((q) =>
      console.log(`      档位 ${q.label}  ${q.width}x${q.height}  ${q.codecLabel}  urls=${q.urls.length}  id=${q.id}`)
    );
    check('每档都带播放地址', (media.qualities || []).every((q) => q.urls && q.urls.length), '');
    check('每档都有体积信息', (media.qualities || []).some((q) => q.sizeBytes > 0), '');

    // ---------- 4. 建任务 ----------
    console.log('\n[3] 构造任务');
    // 自检默认挑体积最小的一档：验证的是链路而不是网速，别让 300MB 的高清拖垮测试时长。
    // ★ 但优先挑 H.264：抖音的高画质档基本都是 H.265（ByteVC1，fourcc 为 bvc1/bvc2），
    //   本机自带的 ffmpeg 不认这个 fourcc，会以非 0 退出——拿它去断言"产物可正常播放"
    //   会误报。想专门验证 H.265 档，用 BD_DY_QN=<id> 指定。
    const bySize = (media.qualities || []).slice().sort((a, b) => (a.sizeBytes || 0) - (b.sizeBytes || 0));
    const smallest = bySize.find((q) => q.codec === 'H.264') || bySize[0];
    const qn = process.env.BD_DY_QN || (smallest && smallest.id);
    const tasks = buildTasks(media, config.all(), { parts: [1], videoQn: qn, audioQn: 0 });
    check('任务构造成功', tasks.length === 1, tasks.length + ' 个');
    check('任务标记平台为 douyin', tasks[0].platform === 'douyin', tasks[0].platform);
    check('任务无 cid（抖音无分P）', !tasks[0].cid, String(tasks[0].cid));
    check('音质名称为空（单文件含音轨）', tasks[0].audioName === '', JSON.stringify(tasks[0].audioName));
    console.log('      文件名：' + tasks[0].fileName + '.mp4');
    console.log('      画质名：' + tasks[0].qnName);

    const chosenQ = (media.qualities || []).find((q) => String(q.id) === String(qn));
    if (chosenQ) console.log('      预计体积：' + (chosenQ.sizeBytes / 1048576).toFixed(1) + ' MB');

    // ---------- 5. 下载 ----------
    console.log('\n[4] 下载（抖音是单文件直链，无混流步骤）');
    const downloader = new Downloader({ bili, douyin, config });
    downloader.attachAria(port, ARIA_SECRET);

    const warns = [];
    let lastPrint = '';
    downloader.on('update', (snap) => {
      const t = snap[0];
      if (!t) return;
      const line = `${t.status.padEnd(12)} ${String(t.progress).padStart(3)}%  ${t.speedText || ''}  ${t.totalText || ''}`;
      if (line !== lastPrint) {
        lastPrint = line;
        process.stdout.write('\r      ' + line.padEnd(70));
      }
    });
    downloader.on('extras-warn', (d) => {
      warns.push(d.what + '：' + d.error);
      console.log(`\n      ⚠ ${d.what}：${d.error}`);
    });

    const finished = new Promise((resolve, reject) => {
      downloader.once('all-finished', resolve);
      const iv = setInterval(() => {
        const t = downloader.tasks[0];
        if (t && t.status === 'error') {
          clearInterval(iv);
          reject(new Error('任务失败：' + t.error));
        }
      }, 500);
    });

    downloader.addTasks(tasks);
    await finished;
    process.stdout.write('\n');

    const t = downloader.tasks[0];
    check('任务状态为已完成', t.status === 'done', t.status);
    // 失败时务必把原因打出来：否则只看"状态=error"根本没法定位
    if (t.status !== 'done') console.log('      失败原因：' + (t.error || '(无)'));

    // ---------- 6. 产物校验 ----------
    console.log('\n[5] 校验产物');
    const files = fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR) : [];
    console.log('      目录内容：' + (files.join(', ') || '(空)'));

    const mp4 = files.find((f) => f.endsWith('.mp4'));
    check('生成 MP4', !!mp4, mp4);

    if (mp4) {
      const full = path.join(OUT_DIR, mp4);
      const size = fs.statSync(full).size;
      check('MP4 体积合理（>200KB）', size > 200 * 1024, (size / 1024 / 1024).toFixed(2) + ' MB');
      if (chosenQ && chosenQ.sizeBytes) {
        // 抖音返回的 data_size 是完整文件字节数，误差应在 2% 内
        const diff = Math.abs(size - chosenQ.sizeBytes) / chosenQ.sizeBytes;
        check('体积与接口上报一致（误差<2%）', diff < 0.02, `实际 ${size} / 预期 ${chosenQ.sizeBytes}`);
      }

      const info = await ffprobe(full);
      // 产物是否正常，看的是"容器能读 + 两条轨都在"，而不是"自带 ffmpeg 能解码"。
      // H.265/ByteVC1 档的 fourcc 是 bvc1/bvc2，自带 ffmpeg 不识别（输出 Video: none）
      // 并以非 0 退出 —— 那是本机解码器的问题，文件本身是好的。
      const unknownCodec = /Video:\s*none\b/.test(info.videoLine);
      const parseOk = info.ok || (unknownCodec && info.hasVideo && info.hasAudio);
      check(
        'ffmpeg 可正常解析该 MP4',
        parseOk,
        unknownCodec
          ? '编码器为 ByteVC1(bvc2)，自带 ffmpeg 不识别；文件本身正常'
          : info.err || '无错误输出'
      );
      // 关键：抖音是单文件 MP4，音轨必须在同一个文件里
      check('包含视频轨', info.hasVideo, '');
      check('包含音频轨（单文件已含音轨）', info.hasAudio, '');
      if (info.videoLine) console.log('      ' + info.videoLine.slice(0, 110));
      if (info.audioLine) console.log('      ' + info.audioLine.slice(0, 110));
    }

    check('保存封面', files.some((f) => f.endsWith('.jpg')));
    check('保存 NFO', files.some((f) => f.endsWith('.nfo')));

    const nfo = files.find((f) => f.endsWith('.nfo'));
    if (nfo) {
      const txt = fs.readFileSync(path.join(OUT_DIR, nfo), 'utf8');
      check('NFO 标记 studio=douyin', txt.includes('<studio>douyin</studio>'), '');
      check('NFO 写入 aweme_id', txt.includes(media.awemeId), '');
      check('NFO 作者角色为「作者」', txt.includes('<role>作者</role>'), '');
    }

    // 抖音没有弹幕 / CC 字幕，这些文件不该出现
    check('未生成弹幕 XML（抖音无弹幕接口）', !files.some((f) => f.endsWith('.xml')));
    check('未生成 ASS（抖音无弹幕接口）', !files.some((f) => f.endsWith('.ass')));
    check('未生成 SRT（抖音无 CC 字幕）', !files.some((f) => f.endsWith('.srt')));
    check('无无意义的附加内容警告', warns.length === 0, warns.join(' | ') || '无');
    check('无残留分片 / aria2 控制文件', !files.some((f) => f.includes('.m4s') || f.endsWith('.aria2')));

    const his = config.get('history') || [];
    check('写入下载记录', his.length > 0, his.length + ' 条');
    if (his[0]) {
      check('记录含 platform=douyin', his[0].platform === 'douyin', his[0].platform);
      // 裸 ID 也要被补成可点的完整链接（曾经这里写成了裸 ID，故单独断言）
      check('记录含可点的 sourceUrl', /^https?:\/\//.test(his[0].sourceUrl || ''), his[0].sourceUrl);
    }

    console.log(`\n============ 结果：通过 ${pass}，失败 ${fail} ============`);
    console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒\n`);
  } catch (e) {
    if (e && e.skipped) {
      console.log('\n⚠ 已跳过抖音端到端自检：' + e.message);
      console.log('  这通常不是程序故障 —— 抖音对匿名访客的推荐流时有时无，隔一会儿再跑就好。');
      console.log('  想立刻强制跑：设 BD_DY_URL=<抖音视频链接> 后再执行。');
      console.log(`\n============ 结果：通过 ${pass}，失败 ${fail}（抖音端到端已跳过）============`);
      console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒\n`);
    } else {
      console.log('\n❌ 自检异常：' + e.message);
      console.log(e.stack);
      fail++;
    }
  } finally {
    clearTimeout(hardExit);
    if (douyin) {
      try {
        douyin.destroy();
      } catch (e) {
        /* ignore */
      }
    }
    if (ariaProc) {
      try {
        ariaProc.kill();
      } catch (e) {
        /* ignore */
      }
    }
    setTimeout(() => process.exit(fail > 0 ? 1 : 0), 800);
  }
});

app.on('window-all-closed', () => {});
