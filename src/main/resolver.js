'use strict';

/**
 * resolver.js —— 链接解析：把用户粘贴的链接变成统一的可下载结构
 *
 * 无论「单视频 / 分P / 合集」，最终都归一化为 parts 数组，
 * 后续下载逻辑只需遍历 parts，不必再区分类型。
 */

const { safeName, qnDesc, audioDesc, codecLabel } = require('./bili');
const { api } = require('./api');

const BV_RE = /(BV[0-9A-Za-z]{10})/;
const AV_RE = /(?:^|[^a-zA-Z])av(\d+)/i;
const URL_RE = /https?:\/\/[^\s"'<>，。]+/g;

/** 从任意文本中抽出链接 */
function extractUrl(text) {
  const t = String(text || '').trim();
  const all = t.match(URL_RE);
  if (all && all.length) return all[0];
  return t; // 允许用户只粘贴 BV 号
}

function extractId(text) {
  const m1 = BV_RE.exec(text);
  if (m1) return { bvid: m1[1] };
  const m2 = AV_RE.exec(text);
  if (m2) return { aid: Number(m2[1]) };
  return null;
}

/**
 * 合集页面链接 → { mid, sid }
 *
 * 形如 https://space.bilibili.com/<mid>/channel/collectiondetail?sid=<sid>
 * （合集分享出来的短链展开后也是这个形式，所以要在 expandUrl 之后再判定）
 *
 * 用 URL 解析而不是纯正则，是为了容忍参数顺序、`?spm_id_from=…` 之类的附加项与结尾斜杠。
 * 解析不出就返回 null，由调用方走原来的 BV/AV 流程。
 */
function parseCollectionLink(url) {
  try {
    const u = new URL(String(url || ''));
    if (!/(^|\.)bilibili\.com$/i.test(u.hostname)) return null;
    const m = /^\/(\d+)\/channel\/collectiondetail\/?$/i.exec(u.pathname);
    if (!m) return null;
    const sid = u.searchParams.get('sid');
    if (!sid || !/^\d+$/.test(sid)) return null;
    return { mid: Number(m[1]), sid: Number(sid) };
  } catch (e) {
    return null;
  }
}

/** 系列页面链接（x/series/archives 是另一套接口，本期未支持）——只用来给出更明确的提示 */
function isSeriesLink(url) {
  try {
    const u = new URL(String(url || ''));
    if (!/(^|\.)bilibili\.com$/i.test(u.hostname)) return false;
    return /^\/\d+\/channel\/seriesdetail\/?$/i.test(u.pathname);
  } catch (e) {
    return false;
  }
}

function parsePageNum(url) {
  try {
    const u = new URL(url);
    const p = u.searchParams.get('p');
    return p ? Math.max(1, parseInt(p, 10)) : null;
  } catch (e) {
    return null;
  }
}

/**
 * 展开短链（b23.tv），拿到最终 URL
 * Chromium 的 fetch 会自动跟随跳转，响应对象上的 url 即为终点
 */
async function expandUrl(bili, url) {
  if (!new RegExp(api.shortLinkRegex, 'i').test(url)) return url;
  try {
    const res = await bili._fetch(url, { redirect: 'follow' });
    return res.url || url;
  } catch (e) {
    return url;
  }
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`;
}

/**
 * 识别链接来自哪个平台
 *
 * 判定顺序：先看域名特征，再看「纯数字 ID」。
 * B站 的 BV 号 / av 号都不是 15 位以上纯数字，所以纯数字一律判给抖音。
 *
 * @param {string} input 用户粘贴的原始文本
 * @returns {'bilibili'|'douyin'}
 */
function detectPlatform(input) {
  const t = String(input == null ? '' : input);
  try {
    if (new RegExp(api.douyin.shortLinkRegex, 'i').test(t)) return 'douyin';
  } catch (e) {
    /* 覆盖文件把正则改坏时静默退回 B站 */
  }
  if (/^\s*\d{15,}\s*$/.test(t)) return 'douyin';
  return 'bilibili';
}

/**
 * 解析链接 → 统一媒体数据
 * @returns {Promise<object>}
 */
async function resolve(bili, input) {
  let raw = extractUrl(input);
  if (!raw) throw new Error('请输入视频链接或 BV/AV 号');

  const expanded = await expandUrl(bili, raw);

  // --- 合集页面链接 ---
  // 这类链接里只有 mid + sid、没有 BV 号，extractId 认不出来。
  // 把它「翻译」成一个入口 bvid 之后，后面就能完全复用普通视频流程。
  const coll = parseCollectionLink(expanded) || parseCollectionLink(raw);
  if (coll) return resolveCollection(bili, coll);

  if (isSeriesLink(expanded) || isSeriesLink(raw)) {
    throw new Error('暂不支持「系列」链接，请改用合集链接或视频链接');
  }

  const id = extractId(expanded) || extractId(raw);
  if (!id) throw new Error('未能识别 BV/AV 号，请检查链接');

  const detail = await bili.videoDetail(id.bvid || '');
  // videoDetail 只接受 bvid，若是 av 号则先转换
  const View = detail.View || (await bili.videoInfo(id.bvid));
  if (!View) throw new Error('视频不存在或已被删除');

  const owner = View.owner || {};
  const stat = View.stat || {};
  const result = {
    bvid: View.bvid,
    aid: View.aid,
    cid: View.cid,
    title: View.title,
    cover: View.pic,
    desc: View.desc || '',
    pubdate: View.pubdate,
    duration: View.duration,
    tname: View.tname || '',
    up: { mid: owner.mid, name: owner.name, face: owner.face },
    stat: {
      view: stat.view || 0,
      danmaku: stat.danmaku || 0,
      like: stat.like || 0,
      coin: stat.coin || 0,
      favorite: stat.favorite || 0,
      reply: stat.reply || 0,
    },
    type: '单视频',
    parts: [],
    seasonId: null,
    seasonTitle: '',
    requestedPage: parsePageNum(expanded),
  };

  // --- 合集（UGC season）优先 ---
  // 注意：B站新版把合集条目放在 sections[].episodes，
  //       旧版字段是 sections[].archives，这里两者都兼容。
  const season = View.ugc_season;
  if (season && Array.isArray(season.sections) && season.sections.length) {
    const collected = [];
    let idx = 0;
    for (const sec of season.sections) {
      const list = sec.episodes || sec.archives || [];
      for (const a of list) {
        const arc = a.arc || {};
        const page = a.page || {};
        const cid = a.cid || page.cid || arc.cid;
        if (!cid) continue; // 没有 cid 的条目无法下载，直接跳过
        idx++;
        collected.push({
          index: idx,
          sectionTitle: sec.title || '',
          bvid: a.bvid || arc.bvid || View.bvid,
          aid: a.aid || arc.aid || View.aid,
          cid,
          title: arc.title || a.title || `第${idx}集`,
          part: page.part || '',
          duration: arc.duration || page.duration || a.duration || 0,
          cover: arc.pic || a.pic || View.pic,
          pubdate: arc.pubdate || a.pubdate || View.pubdate,
        });
      }
    }
    // 只有真正取到条目才认定为合集，否则退回分P/单视频逻辑
    if (collected.length > 0) {
      result.type = '合集';
      result.seasonId = season.id;
      result.seasonTitle = season.title || View.title;
      result.parts = collected;
      return result;
    }
  }

  // --- 分P ---
  const pages = View.pages || [];
  if (pages.length > 1) {
    result.type = '分集';
    result.parts = pages.map((p) => ({
      index: p.page,
      sectionTitle: '',
      bvid: View.bvid,
      aid: View.aid,
      cid: p.cid,
      title: p.part || `P${p.page}`,
      part: p.part || '',
      duration: p.duration || 0,
      cover: View.pic,
      pubdate: View.pubdate,
    }));
    return result;
  }

  // --- 单视频 ---
  result.parts = [
    {
      index: 1,
      sectionTitle: '',
      bvid: View.bvid,
      aid: View.aid,
      cid: View.cid,
      title: View.title,
      part: '',
      duration: View.duration || 0,
      cover: View.pic,
      pubdate: View.pubdate,
    },
  ];
  return result;
}

/**
 * 合集页面链接的解析。
 *
 * 思路：不新写一套「合集 → 下载任务」的构造逻辑，只把合集「翻译」成入口 bvid，
 * 再交给上面的普通流程（递归一次即可），后续代码一行都不用改。
 *
 * 为什么只要 2 次请求就够（关键）：
 *  - 合集列表接口（seasons_archives_list）返回的条目**没有 cid**（下载必需），
 *    所以不能直接拿它建任务；
 *  - 但合集内**任意一集**的 view 接口都会带回整个合集（且 episodes[] 里带 cid）。
 *  → 所以「借」一集当入口就什么都有了。
 *
 * 首集可能已删除 / 转为私密，故依次尝试前几集。
 *
 * @param {object} bili BiliClient
 * @param {{mid:number, sid:number}} coll
 * @returns {Promise<object>} 与 resolve() 同构的媒体数据
 */
async function resolveCollection(bili, coll) {
  const data = await bili.seasonArchives(coll.sid, coll.mid);
  const list = (data && (data.archives || data.episodes)) || [];
  const candidates = list
    .map((x) => x && x.bvid)
    .filter(Boolean)
    .slice(0, 3);

  if (!candidates.length) {
    throw new Error('该合集为空或不可见（可能需要先登录）');
  }

  let lastErr = null;
  for (const bvid of candidates) {
    try {
      const media = await resolve(bili, bvid);
      // 用合集链接进入时，标题用合集名更贴切（仅此分支，不影响「粘某一集链接」的既有行为）
      if (media.type === '合集') {
        media.title = media.seasonTitle || media.title;
        media.seasonId = coll.sid;
      }
      return media;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('合集解析失败');
}

/**
 * 从 playurl 响应中提取可用的视频/音频轨列表
 * @param {object} playData playurl 的 data
 * @returns {{videos:Array, audios:Array}}
 */
function extractStreams(playData) {
  const videos = [];
  const audios = [];
  const dash = playData && playData.dash;
  if (!dash) return { videos, audios };

  const norm = (it, kind) => ({
    id: it.id,
    codecs: it.codecs || '',
    codecLabel: codecLabel(it.codecs),
    bandwidth: it.bandwidth || 0,
    width: it.width,
    height: it.height,
    frameRate: it.frameRate || it.frame_rate,
    sizeBytes: it.bandwidth && playData.timelength ? Math.round((it.bandwidth * playData.timelength) / 8 / 1000) : 0,
    urls: [it.baseUrl, ...(it.backupUrl || [])].filter(Boolean),
    desc: kind === 'video' ? qnDesc(it.id) : audioDesc(it.id),
    kind,
  });

  for (const v of dash.video || []) videos.push(norm(v, 'video'));

  // 杜比 / FLAC 音轨
  if (dash.flac && dash.flac.audio) audios.push(norm(dash.flac.audio, 'audio'));
  if (dash.dolby && dash.dolby.audio && dash.dolby.audio.length) {
    for (const a of dash.dolby.audio) audios.push(norm(a, 'audio'));
  }
  for (const a of dash.audio || []) audios.push(norm(a, 'audio'));

  // 去重
  const uniq = (arr, keyFn) => {
    const seen = new Set();
    return arr.filter((x) => {
      const k = keyFn(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  return {
    videos: uniq(videos, (v) => `${v.id}|${v.codecs}`).sort((a, b) => b.id - a.id),
    audios: uniq(audios, (a) => `${a.id}|${a.codecs}`).sort((a, b) => b.id - a.id),
  };
}

/** 估算下载体积（字节 → 可读） */
function humanSize(bytes) {
  if (!bytes || bytes <= 0) return '未知';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

module.exports = {
  resolve,
  detectPlatform,
  extractStreams,
  extractUrl,
  extractId,
  parseCollectionLink,
  isSeriesLink,
  fmtDuration,
  humanSize,
  safeName,
};
