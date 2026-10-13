'use strict';

/**
 * converters.js —— 弹幕 / 字幕 / 元数据 的格式转换
 *
 *  · danmakuXmlToAss  B站 XML 弹幕  → ASS 字幕
 *  · danmakuXmlToXml  标准化输出 XML
 *  · subtitleToSrt    B站 JSON 字幕 → SRT
 *  · buildNfo         Kodi 风格刮削文件
 */

const fs = require('fs');

// ---------------------------------------------------------------- 通用

function xmlDecode(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function xmlEncode(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** ASS 时间：H:MM:SS.cc */
function assTime(sec) {
  const t = Math.max(0, sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t - Math.floor(t)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** SRT 时间：HH:MM:SS,mmm */
function srtTime(sec) {
  const t = Math.max(0, sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(
    ms
  ).padStart(3, '0')}`;
}

/** B站十进制颜色 → ASS &HAABBGGRR */
function assColor(dec) {
  const c = (Number(dec) || 0) >>> 0;
  const r = (c >> 16) & 0xff;
  const g = (c >> 8) & 0xff;
  const b = c & 0xff;
  const h = (n) => n.toString(16).toUpperCase().padStart(2, '0');
  return `&H00${h(b)}${h(g)}${h(r)}`;
}

/** 估算文本显示宽度（全角按 1 倍字号，半角按 0.55 倍） */
function estimateWidth(text, fontSize) {
  let units = 0;
  for (const ch of String(text)) {
    units += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1 : 0.55;
  }
  return units * fontSize;
}

// ---------------------------------------------------------------- 弹幕解析

/**
 * 解析 XML 弹幕为结构化数组
 * p 属性顺序：time, mode, fontsize, color, timestamp, pool, uidHash, dmid
 */
function parseDanmakuXml(xml) {
  const out = [];
  const re = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const p = m[1].split(',');
    const text = xmlDecode(m[2]).trim();
    if (!text) continue;
    out.push({
      time: parseFloat(p[0]) || 0,
      mode: parseInt(p[1], 10) || 1,
      fontSize: parseInt(p[2], 10) || 25,
      color: parseInt(p[3], 10) || 0xffffff,
      pool: parseInt(p[5], 10) || 0,
      text,
    });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * XML 弹幕 → ASS
 * @param {string} xml
 * @param {object} [opt] { playResX, playResY, fontSize, alpha, durationSec }
 */
function danmakuXmlToAss(xml, opt = {}) {
  const W = opt.playResX || 1920;
  const H = opt.playResY || 1080;
  const baseFont = opt.fontSize || 42;
  const alpha = opt.alpha == null ? 0.15 : opt.alpha; // 0 不透明, 1 全透明
  const defaultDuration = opt.durationSec || 10; // 滚动弹幕默认停留时长
  const items = parseDanmakuXml(xml);

  const dialogue = [];
  // 轨道占用表：每条轨道记录最后释放时间（秒）
  const trackFree = [];
  const trackH = baseFont + 6;

  const allocTrack = (time, needTracks, occupied) => {
    // 返回可用轨道起始索引
    for (let i = 0; i < 400; i++) {
      let ok = true;
      for (let k = 0; k < needTracks; k++) {
        const idx = i + k;
        if (occupied[idx] && occupied[idx] > time) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
    return 0;
  };

  const maxTracks = Math.max(1, Math.floor((H * 0.85) / trackH));
  const rolling = new Array(400).fill(0);
  const top = new Array(400).fill(0);
  const bottom = new Array(400).fill(0);

  for (const d of items) {
    const color = assColor(d.color);
    const fs = Math.round(baseFont * (d.fontSize / 25));
    const text = d.text.replace(/\r?\n/g, ' ').replace(/[{}]/g, '');
    const textW = estimateWidth(text, fs);
    const style = `{\\c${color}\\fs${fs}\\alpha&H${Math.round(alpha * 255)
      .toString(16)
      .toUpperCase()
      .padStart(2, '0')}}`;

    const isBottom = d.mode === 4;
    const isTop = d.mode === 5;
    const isRolling = d.mode === 1 || d.mode === 2 || d.mode === 3 || d.mode === 6;

    if (isRolling) {
      const dur = defaultDuration;
      const track = allocTrack(d.time, 1, rolling);
      const tIdx = Math.min(track, maxTracks - 1);
      const y = trackH * tIdx + trackH;
      rolling[tIdx] = d.time + dur;
      const x1 = W + 10;
      const x2 = -textW - 10;
      dialogue.push(
        `Dialogue: 0,${assTime(d.time)},${assTime(d.time + dur)},Danmaku,,0,0,0,,` +
          `{\\move(${x1.toFixed(0)},${y.toFixed(0)},${x2.toFixed(0)},${y.toFixed(0)})}${style}${text}`
      );
    } else if (isTop) {
      const dur = 5;
      const track = allocTrack(d.time, 1, top);
      const tIdx = Math.min(track, maxTracks - 1);
      const y = trackH * tIdx + trackH;
      top[tIdx] = d.time + dur;
      const x = Math.max(0, (W - textW) / 2);
      dialogue.push(
        `Dialogue: 0,${assTime(d.time)},${assTime(d.time + dur)},Danmaku,,0,0,0,,` +
          `{\\pos(${x.toFixed(0)},${y.toFixed(0)})}${style}${text}`
      );
    } else if (isBottom) {
      const dur = 5;
      const track = allocTrack(d.time, 1, bottom);
      const tIdx = Math.min(track, maxTracks - 1);
      const y = H - trackH * tIdx - trackH * 0.2;
      bottom[tIdx] = d.time + dur;
      const x = Math.max(0, (W - textW) / 2);
      dialogue.push(
        `Dialogue: 0,${assTime(d.time)},${assTime(d.time + dur)},Danmaku,,0,0,0,,` +
          `{\\pos(${x.toFixed(0)},${y.toFixed(0)})}${style}${text}`
      );
    }
    // mode 7/8/9（高级/代码/BAS 弹幕）暂不转换
  }

  const header = [
    '[Script Info]',
    'Title: 视频下载器 弹幕',
    'ScriptType: v4.00+',
    'Collisions: Normal',
    'PlayResX: ' + W,
    'PlayResY: ' + H,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Danmaku,微软雅黑,42,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,7,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  return header.join('\n') + '\n' + dialogue.join('\n') + '\n';
}

/** 弹幕条数（用于展示） */
function danmakuCount(xml) {
  return (xml.match(/<d\s+p="/g) || []).length;
}

// ---------------------------------------------------------------- 字幕

/**
 * B站 JSON 字幕 → SRT
 * @param {object|string} json { body: [{from,to,content}] }
 */
function subtitleToSrt(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const body = (data && data.body) || [];
  const lines = [];
  body.forEach((it, i) => {
    const from = Number(it.from) || 0;
    const to = Number(it.to) || from + 2;
    const content = String(it.content == null ? '' : it.content).trim();
    if (!content) return;
    lines.push(`${i + 1}`);
    lines.push(`${srtTime(from)} --> ${srtTime(to)}`);
    lines.push(content);
    lines.push('');
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------- NFO

function buildNfo(info = {}) {
  const out = [];
  const add = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    out.push(`  <${k}>${xmlEncode(v)}</${k}>`);
  };
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push('<movie>');
  add('title', info.title);
  add('originaltitle', info.title);
  add('sorttitle', info.title);
  add('plot', info.desc);
  if (info.tagline) add('tagline', info.tagline);
  if (info.duration) add('runtime', String(Math.round(info.duration / 60)));
  if (info.cover) add('thumb', info.cover);
  if (info.premiered) add('premiered', info.premiered);
  add('studio', info.studio || 'bilibili');
  if (info.up) {
    out.push('  <actor>');
    out.push(`    <name>${xmlEncode(info.up)}</name>`);
    out.push(`    <role>${xmlEncode(info.upRole || 'UP主')}</role>`);
    out.push('  </actor>');
  }
  // uniqueId 是「作品的平台内唯一标识」：B站 是 BV 号，抖音是 aweme_id
  const uid = info.uniqueId || info.bvid;
  if (uid) out.push(`  <uniqueid type="${xmlEncode(info.studio || 'bilibili')}" default="true">${xmlEncode(uid)}</uniqueid>`);
  add('genre', info.type || 'B站视频');
  if (info.cid) add('bilibili_cid', String(info.cid));
  if (info.tname) add('genre', info.tname);
  out.push('</movie>');
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- 落盘

function writeText(file, content) {
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

module.exports = {
  danmakuXmlToAss,
  danmakuCount,
  parseDanmakuXml,
  subtitleToSrt,
  buildNfo,
  writeText,
  xmlEncode,
  xmlDecode,
  assTime,
  srtTime,
  assColor,
};
