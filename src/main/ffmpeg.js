'use strict';

/**
 * ffmpeg.js —— 调用内置 ffmpeg 完成混流与转码
 */

const fs = require('fs');
const { spawn } = require('child_process');
const { getBin } = require('./config');

/**
 * 执行 ffmpeg
 *
 * ★ 2026-10-12 加固：以前这里既没有超时、也不响应取消。
 *   一旦 ffmpeg 卡住（大文件 + HEVC、输入损坏、等 I/O），任务会永远停在
 *   「混流中 / 处理音频」，而且用户在界面上点「取消」也杀不掉这个子进程
 *   （它继续吃 CPU，还占着输出文件）。现在：
 *     ① 支持 AbortSignal —— downloader 取消任务时 abort，子进程立即终止；
 *     ② 加「无输出看门狗」（默认 180 秒，可用 BD_FFMPEG_IDLE_MS 覆盖）。
 *        刻意用「无输出」而不是「总时长」：一条正常但很慢的长视频转码不能被误杀，
 *        而真卡死时 ffmpeg 会停止刷进度行，看门狗才该动手。
 *
 * @param {string[]} args
 * @param {(line:string)=>void} [onLine] 实时输出回调（用于解析进度）
 * @param {{idleMs?:number, signal?:AbortSignal}} [opts]
 * @returns {Promise<void>}
 */
function runFFmpeg(args, onLine, opts = {}) {
  return new Promise((resolve, reject) => {
    const exe = getBin('ffmpeg.exe');
    let proc;
    try {
      proc = spawn(exe, args, { windowsHide: true });
    } catch (e) {
      return reject(new Error('无法启动 ffmpeg：' + e.message));
    }

    const idleMs = Number(opts.idleMs || process.env.BD_FFMPEG_IDLE_MS || 180000);
    const signal = opts.signal || null;
    let settled = false;
    let idleTimer = null;
    let tail = '';

    const teardown = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const kill = (err) => {
      if (settled) return;
      settled = true;
      teardown();
      try {
        proc.kill('SIGKILL');
      } catch (_) {
        /* ignore */
      }
      reject(err);
    };
    const onAbort = () => kill(new Error('已取消（ffmpeg 子进程已终止）'));
    if (signal) {
      if (signal.aborted) return kill(new Error('已取消（ffmpeg 子进程已终止）'));
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        kill(
          new Error(
            `ffmpeg 已连续 ${Math.round(idleMs / 1000)} 秒没有任何输出，判定为卡死并已终止`
          )
        );
      }, idleMs);
      if (idleTimer.unref) idleTimer.unref();
    };

    const onData = (buf) => {
      const s = buf.toString();
      tail = (tail + s).slice(-4000);
      armIdle();
      if (onLine) {
        for (const line of s.split(/\r?\n/)) if (line) onLine(line);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    armIdle();

    proc.on('error', (e) => kill(new Error('ffmpeg 启动失败：' + e.message)));
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      teardown();
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}\n${tail.slice(-1200)}`));
    });
  });
}

/**
 * 从 ffmpeg 输出行解析总时长（秒）
 */
function parseDuration(line) {
  const m = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(line);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
}

/**
 * 从 ffmpeg 输出行解析当前进度（秒）
 */
function parseTime(line) {
  const m = /time=\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(line);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
}

/**
 * 混流 DASH 视频 + 音频 → MP4
 * 先尝试直接流拷贝（无损、秒级完成）；若容器/编码不兼容则回退重编码音频。
 *
 * @param {string} videoPath
 * @param {string} audioPath
 * @param {string} outPath
 * @param {(p:{percent:number,line:string})=>void} [onProgress]
 * @param {{idleMs?:number, signal?:AbortSignal}} [opts] 透传给 runFFmpeg（超时/取消）
 */
async function mergeDash(videoPath, audioPath, outPath, onProgress, opts = {}) {
  let duration = null;
  let lastEmit = 0;

  const report = (line) => {
    if (!duration) duration = parseDuration(line);
    const t = parseTime(line);
    if (duration && t != null) {
      const percent = Math.max(0, Math.min(100, (t / duration) * 100));
      const now = Date.now();
      if (now - lastEmit > 300 || percent >= 100) {
        lastEmit = now;
        if (onProgress) onProgress({ percent: Math.round(percent * 10) / 10, line });
      }
    }
  };

  const copyArgs = [
    '-y',
    '-i', videoPath,
    '-i', audioPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-strict', '-2',
    '-f', 'mp4',
    outPath,
  ];

  try {
    await runFFmpeg(copyArgs, report, opts);
    return { mode: 'copy' };
  } catch (e) {
    // 回退：音频重编码为 AAC（常见于 flac / dolby 音轨放入 mp4 失败）
    if (onProgress) onProgress({ percent: 0, line: '流拷贝失败，改用音频转码…' });
    const encodeArgs = [
      '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '320k',
      '-f', 'mp4',
      outPath,
    ];
    await runFFmpeg(encodeArgs, report, opts);
    return { mode: 'transcode', reason: e.message };
  }
}

/**
 * 音频转 MP3
 * @param {{idleMs?:number, signal?:AbortSignal}} [opts]
 */
async function aacToMp3(inPath, outPath, onProgress, opts = {}) {
  let duration = null;
  let lastEmit = 0;
  const report = (line) => {
    if (!duration) duration = parseDuration(line);
    const t = parseTime(line);
    if (duration && t != null) {
      const percent = Math.max(0, Math.min(100, (t / duration) * 100));
      const now = Date.now();
      if (now - lastEmit > 300 || percent >= 100) {
        lastEmit = now;
        if (onProgress) onProgress({ percent: Math.round(percent * 10) / 10 });
      }
    }
  };
  await runFFmpeg(['-y', '-i', inPath, '-q:a', '0', '-map', 'a', outPath], report, opts);
}

/**
 * 单纯转封装（用于手动混流工具）
 * @param {{idleMs?:number, signal?:AbortSignal}} [opts]
 */
async function remux(videoPath, audioPath, outPath, onProgress, opts = {}) {
  return mergeDash(videoPath, audioPath, outPath, onProgress, opts);
}

/** 生成进度上报器：从 ffmpeg 的 stderr 里读 Duration / time= 估算百分比 */
function makeReporter(onProgress) {
  let duration = null;
  let lastEmit = 0;
  return (line) => {
    if (!duration) duration = parseDuration(line);
    const t = parseTime(line);
    if (duration && t != null) {
      const percent = Math.max(0, Math.min(100, (t / duration) * 100));
      const now = Date.now();
      if (now - lastEmit > 300 || percent >= 100) {
        lastEmit = now;
        if (onProgress) onProgress({ percent: Math.round(percent * 10) / 10, line });
      }
    }
  };
}

/**
 * 探测源文件里的音轨编码，返回小写编码名（'aac' / 'mp3' / 'flac' / 'opus' …）。
 *
 * 随包只带了 ffmpeg.exe、没有 ffprobe.exe，所以用 ffmpeg 本身来探：
 * 「只给输入、不给输出文件」时 ffmpeg 会打印流信息并以退出码 1 结束，
 * 这属于正常流程，不能当失败处理。
 *
 * @param {string} filePath
 * @param {{timeoutMs?:number, signal?:AbortSignal}} [opts] 上限/取消（探测正常是毫秒级）
 * @returns {Promise<string>} 探测不到时返回空串
 */
function probeAudioCodec(filePath, opts = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(getBin('ffmpeg.exe'), ['-hide_banner', '-i', filePath], { windowsHide: true });
    } catch (_) {
      return resolve('');
    }

    let buf = '';
    let done = false;
    const signal = opts.signal || null;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(v);
    };
    const harder = () => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {
        /* ignore */
      }
    };
    const onAbort = () => {
      harder();
      finish('');
    };
    // 探测只是读文件头，正常是毫秒级；给个上限，卡住就别拖着整个任务不走
    const timer = setTimeout(
      () => {
        harder();
        finish('');
      },
      Number(opts.timeoutMs || process.env.BD_FFPROBE_TIMEOUT_MS || 60000)
    );
    if (timer.unref) timer.unref();
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const onData = (d) => {
      buf = (buf + d.toString()).slice(-8000);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', () => finish(''));
    proc.on('close', () => {
      // 形如：Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, ...
      const m = /Stream #\d+:\d+.*?:\s*Audio:\s*([A-Za-z0-9_]+)/.exec(buf);
      finish(m ? m[1].toLowerCase() : '');
    });
  });
}

/** 把编码名说成人话，用于提示文案 */
function codecLabel(codec) {
  const map = {
    aac: 'AAC',
    mp3: 'MP3',
    flac: 'FLAC 无损',
    opus: 'Opus',
    vorbis: 'Vorbis',
    'ec-3': '杜比数字+',
    ac3: '杜比 AC-3',
    alac: 'ALAC 无损',
    pcm_s16le: 'PCM',
    pcm_s24le: 'PCM',
  };
  return map[codec] || (codec ? codec.toUpperCase() : '未知编码');
}

/**
 * 只抽取音轨（「只下载音频」用的落地步骤）。
 *
 * ★ 与 bilidown 的差别，也正是它「只下载音频」经常失败、得改用自定义下载的原因：
 *   1. 不假定音轨一定是 AAC —— 无损(FLAC)/杜比(EC-3) 塞不进 mp4 容器，
 *      这里先试「无损拷贝」，失败自动回退成 AAC 重编码，而不是直接报错；
 *   2. 源既可以是 DASH 音频分片(.m4s)，也可以是整段 MP4 —— 两种都能处理。
 *
 * ★ 目标 MP3 时先探源音轨编码：
 *   - 源本身已是 MP3 → 直接流拷贝封装（秒级，音质零损失，不算转码）；
 *   - 源是 AAC / FLAC / … → 必须重编码，这一步比较吃 CPU，通过 onNotice
 *     告诉界面「需要一点时间」，让用户知道进度条为什么会停一会儿。
 *
 * 每个候选参数都保留「最小必要」：-vn 保证不会把视频轨带出来。
 *
 * @param {string} inPath   源（.m4s / .mp4 / .m4a …）
 * @param {string} outPath  目标文件，扩展名决定输出格式（.m4a / .mp3）
 * @param {{format?:'m4a'|'mp3', onProgress?:Function, onNotice?:Function, signal?:AbortSignal}} [opts]
 * @returns {Promise<{mode:'copy'|'transcode', sourceCodec:string}>}
 */
async function extractAudio(inPath, outPath, opts = {}) {
  const format = String(opts.format || 'm4a').toLowerCase() === 'mp3' ? 'mp3' : 'm4a';
  const report = makeReporter(opts.onProgress);
  // 第二个参数明确告诉界面「这一步要不要转码」——不要让界面去猜文案里有没有「转码」二字，
  // 「源音轨已是 MP3，直接提取（无需转码）」这种句子同样含「转码」，一猜就错。
  const notice = (text, transcoding) => {
    if (opts.onNotice) opts.onNotice(text, !!transcoding);
  };
  const head = ['-y', '-i', inPath, '-vn'];

  // 先认一下源音轨到底是什么编码，决定走「原样提取」还是「转码」
  let srcCodec = '';
  try {
    srcCodec = await probeAudioCodec(inPath, { signal: opts.signal });
  } catch (_) {
    /* 探测失败不致命，后面会按转码处理 */
  }

  let attempts;
  if (format === 'mp3') {
    attempts = [];

    // 源已经是 MP3 → 直接提取封装，无需转码
    if (srcCodec === 'mp3') {
      attempts.push({
        args: head.concat(['-c:a', 'copy', '-f', 'mp3', outPath]),
        mode: 'copy',
        text: '源音轨已是 MP3，直接提取（无需转码）…',
      });
    }

    attempts.push({
      args: head.concat(['-c:a', 'libmp3lame', '-q:a', '0', outPath]),
      mode: 'transcode',
      text: `源音轨为 ${codecLabel(srcCodec)}，正在转码为 MP3，需要一点时间…`,
    });
    // 少数精简版 ffmpeg 不带 libmp3lame：退回默认编码器，由扩展名决定
    attempts.push({
      args: head.concat(['-q:a', '0', outPath]),
      mode: 'transcode',
      text: '正在转码为 MP3，需要一点时间…',
    });
  } else {
    attempts = [];

    // 1) 能直接塞进 mp4 的编码才值得试无损封装；FLAC / 杜比这些注定失败，别白跑一趟
    const mp4Friendly = !srcCodec || /^(aac|alac|mp3|ac3|eac3|ec-3)$/.test(srcCodec);
    if (mp4Friendly) {
      // -strict -2 只为放行 mp3 这类「非 mp4 嫡系」编码，失败了还有下面兜底
      attempts.push({
        args: head.concat(['-c:a', 'copy', '-strict', '-2', '-f', 'mp4', outPath]),
        mode: 'copy',
        text: '正在提取音轨（无损封装）…',
      });
    }

    // 2) 回退：FLAC / 杜比 / 非常规音轨 → 重编码 AAC
    attempts.push({
      args: head.concat(['-c:a', 'aac', '-b:a', '256k', '-f', 'mp4', outPath]),
      mode: 'transcode',
      text: `源音轨为 ${codecLabel(srcCodec)}，需重编码为 AAC，正在处理…`,
    });
  }

  let lastErr = null;
  for (const at of attempts) {
    try {
      notice(at.text, at.mode === 'transcode');
      await runFFmpeg(at.args, report, { signal: opts.signal });
      return { mode: at.mode, sourceCodec: srcCodec };
    } catch (e) {
      lastErr = e;
      // 被取消就没必要再试下一组参数了，直接把取消抛出去
      if (e && /已取消/.test(e.message)) throw e;
      // 半途失败会留下残缺文件；下一轮 -y 会覆盖，这里顺手清掉避免误用
      try {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      } catch (_) {
        /* ignore */
      }
    }
  }
  throw lastErr || new Error('音轨抽取失败');
}

module.exports = {
  runFFmpeg,
  mergeDash,
  aacToMp3,
  remux,
  extractAudio,
  probeAudioCodec,
  codecLabel,
  parseDuration,
  parseTime,
};
