// Windows 控制台默认 GBK(936)，Node/Electron 输出的是 UTF-8 字节，中文会显示成乱码。
// 先把当前控制台切成 UTF-8，保证中文标题/提示能正常显示。
if (process.platform === 'win32' && process.stdout && process.stdout.isTTY) {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore', windowsHide: true });
  } catch (e) {
    /* ignore */
  }
}

/**
 * probe.js —— 从热门列表中探测一个「多P / 合集」视频，用于多集解析测试
 * 用法：node tools/probe.js
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];
const crypto = require('crypto');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

let COOKIE = '';

async function j(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      ...(COOKIE ? { Cookie: COOKIE } : {}),
    },
  });
  return r.json();
}

/** 带 WBI 签名的搜索 */
async function search(keyword, page = 1) {
  const nav = await j('https://api.bilibili.com/x/web-interface/nav');
  const img = nav?.data?.wbi_img;
  if (!img) return [];
  const pick = (u) => u.split('/').pop().split('.')[0];
  const orig = pick(img.img_url) + pick(img.sub_url);
  const mixinKey = MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join('').slice(0, 32);

  const params = { search_type: 'video', keyword, page };
  const wts = Math.round(Date.now() / 1000);
  const all = { ...params, wts };
  const qs = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const w_rid = md5(qs + mixinKey);

  const r = await j(`https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}&w_rid=${w_rid}`);
  if (r.code !== 0) {
    console.log('  搜索返回：', r.code, r.message);
    return [];
  }
  return (r.data && r.data.result) || [];
}

(async () => {
  const spi = await j('https://api.bilibili.com/x/frontend/finger/spi');
  if (spi && spi.data && spi.data.b_3) COOKIE = `buvid3=${spi.data.b_3}`;

  // 候选池：热门 + 搜索
  const pool = new Map();
  const pop = await j('https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1');
  for (const v of (pop.data && pop.data.list) || []) pool.set(v.bvid, v);

  for (const kw of ['合集', '全集', '系列课程', '纪录片 全集', '押题班']) {
    let res = await search(kw, 1);
    if (res.length < 15 && kw === '合集') res = await search(kw, 2);
    console.log(`  搜索「${kw}」→ ${res.length} 条`);
    for (const v of res) {
      if (v.bvid) pool.set(v.bvid, v);
    }
  }

  console.log(`\n候选 ${pool.size} 条，逐个探测多P/合集…\n`);

  let foundMulti = null;
  let foundSeason = null;

  for (const [bvid] of pool) {
    const d = await j(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
    const data = d && d.data;
    if (!data) continue;

    const pages = data.pages || [];
    if (!foundMulti && pages.length > 1) {
      foundMulti = { bvid, title: data.title, n: pages.length, cid: pages[0].cid };
      console.log(`【多P】${bvid}  ${pages.length} 个分P  ${String(data.title).slice(0, 34)}`);
    }
    if (!foundSeason && data.ugc_season && data.ugc_season.sections) {
      const total = data.ugc_season.sections.reduce((a, s) => a + (s.archives || []).length, 0);
      if (total > 1) {
        foundSeason = { bvid, title: data.ugc_season.title, n: total };
        console.log(`【合集】${bvid}  ${total} 集  ${String(data.ugc_season.title).slice(0, 34)}`);
      }
    }
    if (foundMulti && foundSeason) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log('\n探测结果：');
  console.log('  多P 样本：', foundMulti ? JSON.stringify(foundMulti) : '未找到');
  console.log('  合集样本：', foundSeason ? JSON.stringify(foundSeason) : '未找到');

  // ---------- 反向验证：从 UP 主空间找真实的合集，再看 view 是否返回 ugc_season ----------
  console.log('\n【合集链路反向验证】');
  const first = [...pool.values()].find((v) => v.owner && v.owner.mid);
  const mid = first ? first.owner.mid : null;
  console.log('  取样 UP mid =', mid, first ? `(${first.owner.name})` : '');
  if (!mid) return;

  const sList = await j(
    `https://api.bilibili.com/x/polymer/web-space/seasons_series_list?mid=${mid}&page_num=1&page_size=20`
  );
  const seasons = sList?.data?.items_lists?.seasons_list || [];
  console.log('  该 UP 的合集数：', seasons.length);
  if (!seasons.length) {
    console.log('  ⚠ 该 UP 无合集，换个 UP 再试');
    return;
  }

  const meta = seasons[0].meta || {};
  const sid = meta.season_id;
  console.log(`  取用合集「${meta.name}」 sid=${sid} 共 ${meta.total} 集`);

  const arcs = await j(
    `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?season_id=${sid}&sort_reverse=false&page_num=1&page_size=30&mid=${mid}`
  );
  const archives = arcs?.data?.archives || [];
  console.log('  seasons_archives_list 返回条目：', archives.length);

  if (archives[0]) {
    const bv = archives[0].bvid;
    const vd = await j(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`);
    const view = vd?.data;
    const season = view?.ugc_season;
    // 兼容新旧字段：新版合集条目在 sections[].episodes，旧版在 sections[].archives
    const listOf = (s) => s.episodes || s.archives || [];
    const total = season ? (season.sections || []).reduce((a, s) => a + listOf(s).length, 0) : 0;
    console.log(`  验证 ${bv}（${String(view?.title || '').slice(0, 22)}）`);
    console.log(`  → view 接口返回 ugc_season：${season ? '是' : '否'}`);
    if (season) {
      console.log(`  → sections=${season.sections.length}  总集数=${total}`);
      const first = listOf(season.sections[0] || {})[0];
      if (first) {
        const arc = first.arc || {};
        console.log(`  → 首条条目字段: bvid=${first.bvid || arc.bvid} cid=${first.cid || arc.cid}`);
      } else {
        console.log('  → sections[0] 内无 episodes/archives 条目（需走 seasons_archives_list 兜底）');
      }
    } else {
      console.log('  ⚠ 未登录状态下 view 不返回 ugc_season，合集需走 seasons_archives_list 兜底');
    }
  }
})();
