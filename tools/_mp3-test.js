'use strict';

/**
 * _mp3-test.js —— 「只下载音频」落地环节的自检（纯本地，不联网）
 *
 * 覆盖 extractAudio() 的四条路径：
 *   mp3 源 → mp3 目标：必须走「直接提取」(copy)，绝不能转码
 *   aac 源 → mp3 目标：必须转码，且 onNotice 要给出「需要一点时间」的提示
 *   aac 源 → m4a 目标：无损封装 (copy)
 *   flac 源 → m4a 目标：mp4 装不下 FLAC → 回退重编码 (transcode)
 *
 * 跑法：node tools/_mp3-test.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { extractAudio, probeAudioCodec, codecLabel } = require('../src/main/ffmpeg');
const { getBin } = require('../src/main/config');

const FF = getBin('ffmpeg.exe');
const DIR = path.join(__dirname, '_mp3test');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('  PASS  ' + name + (detail ? '  (' + detail + ')' : ''));
  } else {
    fail++;
    console.log('  FAIL  ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}

/** 造素材：把一段正弦波编成指定编码，写进指定容器 */
function makeFixture(file, codec, container) {
  const args = ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'];
  if (codec === 'libmp3lame') args.push('-c:a', 'libmp3lame', '-b:a', '192k');
  else if (codec === 'aac') args.push('-c:a', 'aac', '-b:a', '128k');
  else args.push('-c:a', codec);
  args.push('-f', container, file);
  execFileSync(FF, args, { stdio: 'ignore' });
}

async function run(label, src, fmt, expectMode, expectCodec, expectNotice) {
  const out = path.join(DIR, 'out_' + label + '.' + fmt);
  const notices = [];
  let res = null;
  let err = null;
  try {
    res = await extractAudio(src, out, {
      format: fmt,
      onNotice: (text, transcoding) => notices.push({ text, transcoding: !!transcoding }),
    });
  } catch (e) {
    err = e;
  }

  if (err) {
    check(label, false, '抛错：' + String(err.message).slice(0, 100));
    return;
  }

  const probe = await probeAudioCodec(out);
  const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
  const info = `mode=${res.mode} src=${res.sourceCodec} out=${probe} ${Math.round(size / 1024)}KB`;

  check(label + ' 落地模式', res.mode === expectMode, info);
  if (expectCodec) check(label + ' 产物编码', probe === expectCodec, 'probe=' + probe);
  const texts = notices.map((n) => n.text);
  check(label + ' 有过程提示', notices.length > 0, JSON.stringify(texts));
  if (expectNotice) {
    const last = notices[notices.length - 1] || { text: '', transcoding: null };
    check(label + ' 提示文案正确', expectNotice.test(last.text), last.text);
    check(label + ' 无多余重试', notices.length === 1, '共 ' + notices.length + ' 条提示');
    // 界面靠这个布尔量决定显示「转码中」还是「处理音频」，必须是准的
    check(
      label + ' 转码标记正确',
      last.transcoding === (res.mode === 'transcode'),
      'flag=' + last.transcoding + ' mode=' + res.mode
    );
  }
}

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  console.log('== 造素材 ==');
  makeFixture(path.join(DIR, 'src.mp3'), 'libmp3lame', 'mp3');
  makeFixture(path.join(DIR, 'src.m4s'), 'aac', 'mp4'); // 模拟 B站 DASH 音轨分片
  makeFixture(path.join(DIR, 'src.flac'), 'flac', 'flac');
  console.log('  ' + fs.readdirSync(DIR).join('  '));

  console.log('== 探测编码 ==');
  for (const f of ['src.mp3', 'src.m4s', 'src.flac']) {
    const c = await probeAudioCodec(path.join(DIR, f));
    console.log(`  ${f.padEnd(10)} -> ${c || '(探测不到)'}  / ${codecLabel(c)}`);
  }

  console.log('== 抽取路径 ==');
  await run('mp3源→mp3', path.join(DIR, 'src.mp3'), 'mp3', 'copy', 'mp3', /直接提取/);
  await run('aac源→mp3', path.join(DIR, 'src.m4s'), 'mp3', 'transcode', 'mp3', /转码为 MP3，需要一点时间/);
  await run('aac源→m4a', path.join(DIR, 'src.m4s'), 'm4a', 'copy', 'aac', /无损封装/);
  await run('flac源→m4a', path.join(DIR, 'src.flac'), 'm4a', 'transcode', 'aac', /FLAC 无损，需重编码/);

  console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
