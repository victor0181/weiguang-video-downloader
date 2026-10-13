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
 * api-test.js —— B站接口「体检报告」（不依赖 Electron，普通 node 即可运行）
 *
 * 用法：
 *   node tools/api-test.js                    跑完整体检
 *   node tools/api-test.js --report           体检 + 生成一份「问题报告」文件（便于整份贴出反馈）
 *   node tools/api-test.js --report=路径.md   同上，并指定报告输出位置
 *   node tools/api-test.js --where            只打印覆盖文件路径
 *   node tools/api-test.js --init-override    生成覆盖文件模板（不会覆盖已存在的文件）
 *
 * 设计要点（为什么这份脚本有意义）：
 *   所有接口地址、请求头、WBI 混淆表、playurl 参数都从 src/main/api.js 读取，
 *   与程序本体**用的是同一份常量**。所以这里测通了，程序就一定能通；
 *   这里报错，也一定能对应到 api.js 的某个键去改。
 *
 * 注意：本脚本没有登录态，画质只会到 480P，且不测试合集/字幕的实际内容 —— 那部分
 *       属于解析层，用 electron tools/parse-test.js 与 tools/selftest.js 验证。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const API_MOD = require('../src/main/api.js');
const { api, DEFAULT, status: cfgStatus, overridePath, overridePathSource } = API_MOD;

const UA = api.headers['User-Agent'];
const REFERER = api.headers.Referer;

let COOKIE = '';

/** 先取设备指纹（buvid3/buvid4），否则很多接口会返回 -352 风控 */
async function initCookie() {
  try {
    const r = await fetch(api.urls.spi, { headers: { 'User-Agent': UA, Referer: REFERER } });
    const j = await r.json();
    if (j && j.data && j.data.b_3) {
      COOKIE = `buvid3=${j.data.b_3}` + (j.data.b_4 ? `; buvid4=${j.data.b_4}` : '');
      return j.data;
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

async function get(url, extra) {
  try {
    const res = await fetch(url, {
      headers: Object.assign(
        { 'User-Agent': UA, Referer: REFERER, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        COOKIE ? { Cookie: COOKIE } : {},
        extra || {}
      ),
    });
    const text = await res.text();
    try {
      return { status: res.status, json: JSON.parse(text) };
    } catch (e) {
      return { status: res.status, text: text.slice(0, 300), raw: true };
    }
  } catch (e) {
    // ★ 网络层直接抛错（DNS 失败 / 端口不通 / TLS 失败…）时绝不能让异常冒泡：
    //   接口一挂，恰恰是最需要出报告的时候，不能让整个体检中断。
    //   这里包成「伪信封」（code = -1），调用方的 `code === 0` 判断会自然判为失败，
    //   detail 里也能顺带显示出原因。
    const msg = String((e && e.message) || e);
    return { status: 0, netError: msg, json: { code: -1, message: '网络错误：' + msg } };
  }
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// ---------------------------------------------------------------- 打分器

const MARK = { ok: '✅', warn: '⚠️ ', fail: '❌' };
const tally = { ok: 0, warn: 0, fail: 0 };
const hints = []; // 需要人工处理的问题
const records = []; // 全部检查项存档（供 --report 生成报告）
let curGroup = '';

function group(name) {
  curGroup = name;
  console.log(`\n[${name}]`);
}

/** 除控制台输出外，另存一份结构化记录，供 --report 生成报告 */
function record(state, label, detail, fix) {
  records.push({
    group: curGroup || '(未分组)',
    label,
    state,
    detail: detail || '',
    fix: fix || '',
  });
}

/**
 * @param {string} label 检查项
 * @param {boolean} cond 是否通过
 * @param {string} [detail] 附加信息
 * @param {string} [fix] 失败时给出的修复指引（务必写成「改哪个文件的哪个键」）
 * @param {boolean} [asWarn] 不达标也不算失败（仅提示）
 */
function check(label, cond, detail, fix, asWarn) {
  const state = cond ? 'ok' : asWarn ? 'warn' : 'fail';
  tally[state]++;
  record(state, label, detail, cond ? '' : fix);
  console.log(`  ${MARK[state]} ${label}${detail ? '  → ' + detail : ''}`);
  if (!cond && fix) {
    console.log(`       ↳ 修复：${fix}`);
    if (!asWarn) hints.push({ group: curGroup, label, fix });
  }
  return cond;
}

// ---------------------------------------------------------------- 命令行

const argv = process.argv.slice(2);

/**
 * --report[=路径]：体检跑完后额外写一份 Markdown 报告。
 * 报告只放「检查项 / 结果 / 该改哪个文件的哪个键」，不含 Cookie、设备指纹与下载地址，
 * 目的是让人能整份贴出来求助，而不必手工整理控制台输出。
 */
const reportArg = argv.find((a) => a === '--report' || a.startsWith('--report='));
const reportWanted = !!reportArg;
let reportFile = reportArg && reportArg.includes('=') ? reportArg.split('=').slice(1).join('=') : '';

function buildTemplate() {
  return (
    JSON.stringify(
      {
        _comment:
          '视频下载器 接口覆盖文件。只写你要改的字段即可，未列出的字段会自动沿用程序内置默认值（将来升级程序时也会跟着更新）。改完重启程序生效。',
        urls: Object.assign({}, DEFAULT.urls),
        headers: Object.assign({}, DEFAULT.headers),
        shortLinkRegex: DEFAULT.shortLinkRegex,
      },
      null,
      2
    ) + '\n'
  );
}

function printWhere() {
  const p = overridePath();
  const exists = fs.existsSync(p);
  console.log('\n覆盖文件路径：' + p);
  console.log('当前状态：' + (exists ? '存在' : '不存在（使用内置默认值）'));
  if (overridePathSource() === 'projectFallback') {
    console.log('注：当前是纯 Node 环境，这里显示的是项目内的 data 目录；');
    console.log('    程序本体（Electron）读的是用户数据目录下的同名文件。');
  }
  console.log('');
}

function initOverride() {
  const p = overridePath();
  if (fs.existsSync(p)) {
    console.log('\n覆盖文件已存在，未做修改：' + p);
    console.log('如需重置，请先自行删除或改名。\n');
    return;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buildTemplate(), 'utf8');
  console.log('\n已生成覆盖文件模板：' + p);
  console.log('按需修改其中的字段，然后重启程序（或重跑本脚本）即可生效。\n');
}

// ---------------------------------------------------------------- 问题报告

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 报告是给外人看的，抹掉设备指纹一类的无关敏感值 */
function sanitize(s) {
  if (!s) return '';
  return String(s)
    .replace(/buvid3=[^\s;]+/gi, 'buvid3=<已隐去>')
    .replace(/buvid4=[^\s;]+/gi, 'buvid4=<已隐去>')
    .replace(/cookie:\s*\S+/gi, 'Cookie:<已隐去>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 表格单元格：先脱敏，再转义竖线（否则会把表格撑坏）。
 *  注意必须用 function 声明：本区块位于 `return summary()` 之后，
 *  const/let 的初始化语句执行不到，会落进 TDZ 报 "Cannot access before initialization"。 */
function cell(s) {
  return sanitize(s).replace(/\|/g, '\\|') || '—';
}

function buildReport(total) {
  let ver = '(未知)';
  try {
    ver = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch (e) {
    /* 忽略 */
  }

  const L = [];
  L.push('# 视频下载器 · 接口体检报告');
  L.push('');
  L.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`);
  L.push(`- 程序版本：${ver}`);
  L.push(`- 运行环境：${process.platform} ${process.arch} · Node ${process.version}`);
  L.push('');

  // ---- 结论 ----
  L.push('## 结论');
  L.push('');
  L.push(`通过 ${tally.ok} · 警告 ${tally.warn} · 失败 ${tally.fail}    （共 ${total} 项）`);
  L.push('');
  if (tally.fail === 0) {
    L.push('✅ 未发现失效项：当前程序与 B站 的接口约定一致，解析与下载应当正常。');
    if (tally.warn > 0) {
      L.push('');
      L.push('⚠️ 存在警告项，不影响使用，可留意。');
    }
  } else {
    L.push(`❌ 有 **${tally.fail}** 项失败。按下方「失败项」逐条修改后，重跑 \`node tools/api-test.js\` 即可。`);
  }
  L.push('');

  // ---- 问题分布（按分组汇总，条长 = 失败 + 警告）----
  const byGroup = new Map();
  for (const r of records) {
    const g = byGroup.get(r.group) || { ok: 0, warn: 0, fail: 0 };
    g[r.state]++;
    byGroup.set(r.group, g);
  }
  const troubled = [...byGroup.entries()]
    .filter(([, g]) => g.warn + g.fail > 0)
    .sort((a, b) => b[1].fail * 10 + b[1].warn - (a[1].fail * 10 + a[1].warn));
  if (troubled.length) {
    const max = Math.max(...troubled.map(([, g]) => g.fail + g.warn));
    L.push('## 问题分布');
    L.push('');
    L.push('| 分组 | 失败 | 警告 | 分布 |');
    L.push('|---|---|---|---|');
    for (const [name, g] of troubled) {
      const bar = '█'.repeat(Math.max(1, Math.round(((g.fail + g.warn) / max) * 16)));
      L.push(`| ${cell(name)} | ${g.fail} | ${g.warn} | ${bar} |`);
    }
    L.push('');
  }

  // ---- 失败项（重点）----
  const fails = records.filter((r) => r.state === 'fail');
  L.push(`## ❌ 失败项（${fails.length}）`);
  L.push('');
  if (!fails.length) {
    L.push('无。');
    L.push('');
  } else {
    for (const r of fails) {
      L.push(`### [${r.group}] ${r.label}`);
      if (r.detail) L.push(`- 实际表现：${sanitize(r.detail)}`);
      L.push(`- 修复指引：${sanitize(r.fix) || '（脚本未给出，请结合上方检查项判断）'}`);
      L.push('');
    }
  }

  // ---- 警告项 ----
  const warns = records.filter((r) => r.state === 'warn');
  L.push(`## ⚠️ 警告项（${warns.length}）`);
  L.push('');
  if (!warns.length) {
    L.push('无。');
    L.push('');
  } else {
    L.push('| 分组 | 检查项 | 说明 |');
    L.push('|---|---|---|');
    for (const r of warns) L.push(`| ${cell(r.group)} | ${cell(r.label)} | ${cell(r.detail)} |`);
    L.push('');
  }

  // ---- 全量明细 ----
  L.push('## 全部检查项');
  L.push('');
  L.push('| 结果 | 分组 | 检查项 | 说明 |');
  L.push('|---|---|---|---|');
  for (const r of records) {
    L.push(`| ${MARK[r.state].trim()} | ${cell(r.group)} | ${cell(r.label)} | ${cell(r.detail)} |`);
  }
  L.push('');

  // ---- 配置信息 ----
  L.push('## 配置信息');
  L.push('');
  L.push(`- 配置来源：内置默认值${cfgStatus.overrideUsed ? ' + 覆盖文件' : ''}`);
  L.push(`- 覆盖文件：\`${overridePath()}\`（${fs.existsSync(overridePath()) ? '已生效' : '不存在'}）`);
  L.push(`- 接口地址：${Object.keys(api.urls).length} 个`);
  L.push(`- WBI 混淆表：${api.mixinKeyEncTab.length} 个元素`);
  L.push('');

  // ---- 反馈说明 ----
  L.push('## 如何反馈');
  L.push('');
  L.push('把本文件整份发送给开发者即可 —— 失败项里已经写明「改哪个文件的哪个键」。');
  L.push('');
  L.push('> 报告只包含检查项与结果，不含 Cookie、设备指纹和下载地址。');
  L.push('> 若仍在意隐私，可删除「配置信息」里的完整路径后再发送，不影响定位。');
  L.push('');

  return L.join('\n');
}

function writeReport(total) {
  const target = reportFile
    ? path.resolve(reportFile)
    : path.resolve(process.cwd(), `接口体检报告-${stamp()}.md`);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 产物是给人看的，统一 CRLF，免得个别 Windows 编辑器把整篇显示成一行
    fs.writeFileSync(target, buildReport(total).replace(/\n/g, '\r\n'), 'utf8');
    reportFile = target;
    console.log('\n📄 问题报告已生成：' + target);
    console.log('   整份发给开发者即可定位到要改的文件与字段。');
  } catch (e) {
    console.error('\n⚠️  报告写入失败：' + e.message);
  }
}

// ---------------------------------------------------------------- 主流程

(async () => {
  if (argv.includes('--where')) return printWhere();
  if (argv.includes('--init-override')) return initOverride();

  console.log('\n=========== 视频下载器 接口体检 ===========');
  console.log('时间：' + new Date().toLocaleString('zh-CN'));
  if (reportWanted) console.log('模式：体检 + 生成问题报告');

  // ---------- 0. 配置层（离线，纯本地判断） ----------
  group('配置层');
  const ovPath = overridePath();
  const ovExists = fs.existsSync(ovPath);
  console.log(`      配置来源：内置默认值${cfgStatus.overrideUsed ? ' + 覆盖文件' : ''}`);
  console.log(`      覆盖文件：${ovPath}${ovExists ? '（已生效）' : '（不存在）'}`);
  if (overridePathSource() === 'projectFallback' && ovExists === false) {
    console.log('      （纯 Node 环境，路径回退到项目 data 目录；程序本体读用户数据目录）');
  }

  check(
    '配置可正常加载',
    !!(api && api.urls && api.headers),
    `${Object.keys(api.urls).length} 个接口地址 / ${Object.keys(api.headers).length} 个请求头`,
    'src/main/api.js 结构损坏，检查文件是否被改坏'
  );
  check(
    'WBI 混淆表结构合法',
    API_MOD.validMixinTab(api.mixinKeyEncTab),
    `${api.mixinKeyEncTab.length} 个元素`,
    'src/main/api.js → mixinKeyEncTab 必须是 0~63 的 64 个互不重复整数'
  );
  const badUrls = Object.keys(api.urls).filter((k) => !/^https?:\/\//i.test(api.urls[k]));
  check('接口地址格式合法', badUrls.length === 0, `异常 ${badUrls.length} 个`, `src/main/api.js → urls.${badUrls[0] || '?'} 不是合法地址`);
  if (cfgStatus.errors.length) {
    for (const e of cfgStatus.errors) {
      console.log('      ⚠️  覆盖文件问题：' + e);
      tally.warn++;
      record('warn', '覆盖文件问题', e, '修正 api-override.json 里被忽略的字段（未列出的字段会沿用内置默认值）');
    }
  }

  // ---------- 1. 设备指纹 ----------
  group('设备指纹 spi');
  const spi = await initCookie();
  check(
    '获取 buvid3 / buvid4',
    !!(spi && spi.b_3),
    spi ? `buvid3=${String(spi.b_3).slice(0, 16)}…` : '',
    `src/main/api.js → urls.spi（当前 ${api.urls.spi}）；若接口失效需换成新的指纹接口`
  );
  check('同时拿到 buvid4', !!(spi && spi.b_4), '', '影响不大，可忽略', true);

  // ---------- 2. 取样 ----------
  group('取样（排行榜 / 热门）');
  const rank = await get(api.urls.ranking + '?rid=0&type=all');
  const rankCode = rank.json ? rank.json.code : NaN;
  // -352 / -412 是风控限流码：短时间内重复请求过多就会这样，歇一会儿自愈。
  // 本项只是「取样入口」，失败会自动退回 urls.popular，对程序本身没有影响，
  // 所以按「警告」而非「失败」处理，免得把暂时性限流误报成接口失效、还指错要改的文件。
  const rankRisk = rankCode === -352 || rankCode === -412;
  let sample = rank.json && rank.json.data && rank.json.data.list && rank.json.data.list[0];
  check(
    '排行榜接口可达',
    rankCode === 0,
    rank.json ? rank.json.message || `code=${rankCode}` : rank.netError || '',
    rankRisk
      ? '接口返回 -352（风控限流），多为短时间重复请求过多，稍等重跑即可；' +
        '本项仅作取样入口，失败会自动退回 urls.popular，不影响程序使用'
      : `src/main/api.js → urls.ranking（当前 ${api.urls.ranking}）`,
    rankRisk
  );
  if (!sample) {
    const pop = await get(api.urls.popular + '?ps=1&pn=1');
    check(
      '备用热门接口可用',
      !!(pop.json && pop.json.code === 0),
      pop.json && pop.json.message,
      `src/main/api.js → urls.popular（当前 ${api.urls.popular}）`
    );
    sample = pop.json && pop.json.data && pop.json.data.list && pop.json.data.list[0];
  }
  if (!sample) {
    console.log('\n⚠️  拿不到任何样本视频，后续网络项无法继续，先解决上面的取样问题。');
    // 后面所有网络项都测不了，本身就是一次失败 —— 否则会被误报成「全部通过」
    tally.fail++;
    record(
      'fail',
      '取得样本视频',
      '排行榜与热门接口都未返回可用样本',
      `src/main/api.js → urls.ranking（当前 ${api.urls.ranking}）、urls.popular（当前 ${api.urls.popular}）；两者都失效时需换成新的取样接口`
    );
    return summary();
  }
  const bvid = sample.bvid;
  console.log(`      样本：${bvid}  ${String(sample.title).slice(0, 30)}`);

  // ---------- 3. view ----------
  group('视频信息 view');
  const view = await get(`${api.urls.view}?bvid=${bvid}`);
  const V = view.json && view.json.data;
  check(
    'view 接口返回 code=0',
    view.json && view.json.code === 0,
    view.json && view.json.message,
    `src/main/api.js → urls.view（当前 ${api.urls.view}）`
  );
  check(
    '返回 bvid / title / cid / owner',
    !!(V && V.bvid && V.title && V.cid && V.owner),
    V ? `cid=${V.cid}` : '',
    '接口能通但字段对不上 → 改 src/main/resolver.js 里读取 view 结果的部分（约 80~100 行）'
  );
  check(
    '返回 pages 数组（分P）',
    !!(V && Array.isArray(V.pages)),
    V && V.pages ? `${V.pages.length} 页` : '',
    '同上：src/main/resolver.js 读取 pages 的位置'
  );
  if (V) console.log(`      ${String(V.title).slice(0, 34)} | UP:${V.owner && V.owner.name} | 时长:${V.duration}s`);
  const cid = V ? V.cid : sample.cid;

  // ---------- 4. playurl ----------
  group('播放地址 playurl');
  const extra = Object.keys(api.playurlParams)
    .map((k) => `&${encodeURIComponent(k)}=${encodeURIComponent(api.playurlParams[k])}`)
    .join('');
  const playUrl = `${api.urls.playurl}?bvid=${bvid}&cid=${cid}&qn=127${extra}`;
  const play = await get(playUrl);
  const P = play.json && play.json.data;
  check(
    'playurl 返回 code=0',
    play.json && play.json.code === 0,
    play.json && play.json.message,
    `src/main/api.js → urls.playurl（当前 ${api.urls.playurl}）`
  );
  check(
    '返回 dash 结构',
    !!(P && P.dash),
    P ? `durl=${!!P.durl}` : '',
    '接口还在但不返回 dash 了 → 改 src/main/api.js 的 urls.playurl 与 playurlParams（当前 ' +
      JSON.stringify(api.playurlParams) +
      '）'
  );
  if (P && P.dash) {
    const vids = P.dash.video || [];
    const auds = P.dash.audio || [];
    check(
      '视频轨数量 > 0',
      vids.length > 0,
      `${vids.length} 条`,
      'src/main/resolver.js 的 extractStreams()：读取 dash.video 的字段名变了'
    );
    check(
      '音频轨数量 > 0',
      auds.length > 0,
      `${auds.length} 条`,
      'src/main/resolver.js 的 extractStreams()：读取 dash.audio 的字段名变了'
    );
    check(
      '视频轨带 baseUrl',
      !!(vids[0] && vids[0].baseUrl),
      '',
      'src/main/resolver.js 的 norm()：字段可能改名（如 baseUrl → base_url）'
    );
    check(
      '视频轨带 backupUrl（多来源加速）',
      !!(vids[0] && vids[0].backupUrl && vids[0].backupUrl.length),
      '',
      '仅影响下载速度，不影响可用性',
      true
    );
    if (vids[0]) {
      console.log(`      最高画质 id=${vids[0].id} codecs=${vids[0].codecs} ${vids[0].width}x${vids[0].height}`);
      console.log(`      音频 id=${auds[0] && auds[0].id} codecs=${auds[0] && auds[0].codecs}`);
    }

    // ---------- 5. 流地址可用性 ----------
    group('流地址可用性实测');
    try {
      const r = await fetch(vids[0].baseUrl, {
        headers: { 'User-Agent': UA, Referer: REFERER, Range: 'bytes=0-65535' },
      });
      check(
        '带请求头直连视频流返回 2xx/206',
        r.status === 206 || r.status === 200,
        'HTTP ' + r.status,
        'src/main/api.js → headers（CDN 开始校验防盗链）；同时检查 src/main/downloader.js 提交给 aria2 的 header'
      );
      const buf = Buffer.from(await r.arrayBuffer());
      check(
        '实际取到数据',
        buf.length > 1000,
        buf.length + ' bytes',
        '地址可访问但无内容 → 可能已改为需要额外参数'
      );
    } catch (e) {
      check(
        '带请求头直连视频流',
        false,
        e.message,
        'src/main/api.js → headers / src/main/downloader.js 的 aria2 header'
      );
    }
    if (vids[0]) {
      // 顺带验一次 playurl 里的时效参数还在不在（不在也不影响使用，只作观察）
      try {
        const u = new URL(vids[0].baseUrl);
        const dl = u.searchParams.get('deadline');
        if (dl) {
          const left = Math.round((Number(dl) * 1000 - Date.now()) / 60000);
          console.log(`      地址时效：还剩约 ${left} 分钟（deadline 参数）`);
        } else {
          console.log('      地址时效：未发现 deadline 参数（B站 可能改了签名方式，注意观察）');
        }
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  // ---------- 6. WBI 签名 ----------
  group('WBI 签名');
  const nav = await get(api.urls.nav);
  const wbiImg = nav.json && nav.json.data && nav.json.data.wbi_img;
  check(
    'nav 返回 wbi_img 密钥对',
    !!(wbiImg && wbiImg.img_url && wbiImg.sub_url),
    '',
    `src/main/api.js → urls.nav（当前 ${api.urls.nav}）`
  );
  if (wbiImg) {
    const pick = (u) => u.split('/').pop().split('.')[0];
    const orig = pick(wbiImg.img_url) + pick(wbiImg.sub_url);
    const mixinKey = api.mixinKeyEncTab.map((n) => orig[n]).join('').slice(0, 32);
    check(
      'mixinKey 长度 = 32',
      mixinKey.length === 32,
      '',
      'src/main/api.js → mixinKeyEncTab 元素不合法'
    );

    const params = { aid: V ? V.aid : sample.aid, cid };
    const wts = Math.round(Date.now() / 1000);
    const all = Object.assign({}, params, { wts });
    const query = Object.keys(all)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
      .join('&');
    const w_rid = md5(query + mixinKey);
    const wbiRes = await get(`${api.urls.playerWbi}?${query}&w_rid=${w_rid}`);
    const code = wbiRes.json && wbiRes.json.code;
    check(
      '签名后的 wbi/v2 返回 code=0',
      code === 0,
      `code=${code} ${(wbiRes.json && wbiRes.json.message) || ''}`,
      code === -352 || code === -403
        ? '签名被风控拒绝。★ 先换 WBI 混淆表：去 B站 网页源码里搜 mixinKeyEncTab（或 wbi 签名逻辑），' +
          '把 64 个数字覆盖到 src/main/api.js 的 mixinKeyEncTab，或写进 api-override.json'
        : `src/main/api.js → urls.playerWbi（当前 ${api.urls.playerWbi}）`
    );
    const subs = wbiRes.json && wbiRes.json.data && wbiRes.json.data.subtitle;
    check(
      '返回字幕结构',
      !!subs,
      subs ? `字幕 ${(subs.subtitles || []).length} 条` : '',
      'src/main/resolver.js 读取字幕的位置（字段可能改名）',
      true
    );
  } else {
    console.log('      ⚠️  拿不到 WBI 密钥，跳过签名验证');
    tally.warn++;
    record('warn', 'WBI 密钥获取', '未拿到 wbi_img，已跳过签名验证', `src/main/api.js → urls.nav（当前 ${api.urls.nav}）`);
  }

  // ---------- 7. 附加内容 ----------
  group('附加内容（弹幕）');
  try {
    const res = await fetch(`${api.urls.danmaku}?oid=${cid}`, {
      headers: { 'User-Agent': UA, Referer: REFERER, 'Accept-Encoding': 'identity' },
    });
    let buf = Buffer.from(await res.arrayBuffer());
    let xml = buf.toString('utf8');
    if (!xml.startsWith('<?xml') && !xml.includes('<i>')) {
      for (const fn of ['inflateRawSync', 'inflateSync', 'gunzipSync']) {
        try {
          const out = zlib[fn](buf);
          if (out && out.length) {
            xml = out.toString('utf8');
            break;
          }
        } catch (e) {
          /* 换下一种 */
        }
      }
    }
    const n = (xml.match(/<d\s+p="/g) || []).length;
    check(
      '弹幕可获取并解压',
      n > 0,
      `${n} 条`,
      `src/main/api.js → urls.danmaku（当前 ${api.urls.danmaku}）；` +
        '若接口改回 JSON 格式，需改 src/main/bili.js 的 danmakuXml() 与 converters.js'
    );
  } catch (e) {
    check('弹幕接口', false, e.message, `src/main/api.js → urls.danmaku`);
  }

  // ---------- 8. 登录 ----------
  group('扫码登录接口');
  const qr = await get(api.urls.qrGenerate);
  check(
    '二维码生成接口 code=0',
    qr.json && qr.json.code === 0,
    qr.json && qr.json.message,
    `src/main/api.js → urls.qrGenerate（当前 ${api.urls.qrGenerate}）`
  );
  check(
    '返回 url 与 qrcode_key',
    !!(qr.json && qr.json.data && qr.json.data.url && qr.json.data.qrcode_key),
    '',
    'src/main/bili.js 的 loginQrGenerate()：字段可能改名'
  );
  const poll = await get(`${api.urls.qrPoll}?qrcode_key=test`);
  check(
    '轮询接口可达（返回标准信封）',
    // code !== -1：-1 是 get() 在网络层失败时塞的伪信封标记，别把它误当成「接口可达」
    !!(poll.json && typeof poll.json.code === 'number' && poll.json.code !== -1),
    poll.json ? `code=${poll.json.code}` : '',
    `src/main/api.js → urls.qrPoll（当前 ${api.urls.qrPoll}）`
  );
  console.log('      （轮询返回码含义见 api.js 的 qrCodes：' + JSON.stringify(api.qrCodes) + '）');

  // ---------- 9. 短链 ----------
  group('短链展开');
  try {
    const r = await fetch('https://b23.tv/BV1xx411c7mD', { redirect: 'follow', headers: { 'User-Agent': UA } });
    check(
      'b23.tv 可自动跳转',
      !!r.url && /bilibili\.com/i.test(r.url),
      '→ ' + String(r.url).slice(0, 56),
      'src/main/api.js → shortLinkRegex（短链域名变了）；当前值 ' + api.shortLinkRegex
    );
  } catch (e) {
    check('b23.tv 跳转', false, e.message, 'src/main/api.js → shortLinkRegex');
  }

  return summary();

  // ---------------------------------------------------------------- 结论
  function summary() {
    const total = tally.ok + tally.warn + tally.fail;
    console.log('\n---------------- 体检结论 ----------------');
    console.log(`通过 ${tally.ok} · 警告 ${tally.warn} · 失败 ${tally.fail}   （共 ${total} 项）`);

    if (tally.fail === 0) {
      console.log('\n✅ 未发现失效项：当前程序与 B站 的接口约定一致，解析与下载应当正常。');
      if (tally.warn > 0) console.log('   上面有警告项，不影响使用，可留意。');
    } else {
      console.log(`\n❌ 有 ${tally.fail} 项失败，按下列位置修改后再跑一次本脚本：\n`);
      for (const h of hints) {
        console.log(`   [${h.group}] ${h.label}`);
        console.log(`      → ${h.fix}`);
      }
      console.log('\n改完不需要重新打包：直接重启程序即可（覆盖文件同样在重启后生效）。');
    }

    console.log('\n提示：');
    console.log('  · 想不改代码就改接口   → node tools/api-test.js --init-override 生成覆盖文件');
    console.log('  · 查看覆盖文件位置     → node tools/api-test.js --where');
    console.log('  · 生成可整份贴出的报告 → node tools/api-test.js --report');
    console.log('  · 验证解析与下载链路   → electron tools/parse-test.js && electron tools/selftest.js');
    console.log('');

    if (reportWanted) writeReport(total);

    process.exit(tally.fail > 0 ? 1 : 0);
  }
})().catch((e) => {
  console.error('\n体检脚本异常终止：', e);
  // 兜底：万一还是崩了，把崩溃前已经跑到的检查项落盘，别让报告白丢
  if (reportWanted) {
    try {
      writeReport(tally.ok + tally.warn + tally.fail);
      console.log('   （报告只包含崩溃前已完成的检查项）');
    } catch (err) {
      console.error('   报告兜底写入也失败：' + err.message);
    }
  }
  process.exit(2);
});
