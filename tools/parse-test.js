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
 * parse-test.js —— 解析层专项测试（单视频 / 多P / 合集）
 * 用法：electron.exe tools/parse-test.js
 */

const path = require('path');
const { app, session } = require('electron');

const SRC = path.join(__dirname, '..', 'src', 'main');
const { BiliClient } = require(path.join(SRC, 'bili'));
const { resolve: resolveLink, extractStreams, parseCollectionLink, isSeriesLink } = require(path.join(SRC, 'resolver'));

// ★ userData 隔离（同 selftest.js）：不指定则用项目内目录，别写进共用的 %APPDATA%\Electron。
const PROFILE = process.env.BD_USERDATA || path.join(__dirname, '_bilitest_prof');
try {
  require('fs').mkdirSync(PROFILE, { recursive: true });
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

const CASES = [
  { name: '单视频', input: 'https://www.bilibili.com/video/BV17NHX6KEX2', expect: '单视频', minParts: 1 },
  { name: '多P（50P）', input: 'BV1FPjy6TEiE', expect: '分集', minParts: 50 },
  { name: '合集（42集）', input: 'BV1784y137sT', expect: '合集', minParts: 40 },
  { name: '带参数链接', input: 'https://www.bilibili.com/video/BV17NHX6KEX2/?p=1&t=3', expect: '单视频', minParts: 1 },
  // 合集页面链接（含分享短链展开后的形态）：链接里只有 mid + sid、没有 BV 号，
  // 走的是一条专门的分支（先「翻译」成入口 bvid 再复用普通流程）
  {
    name: '合集页面链接',
    input: 'https://space.bilibili.com/1027737427/channel/collectiondetail?sid=465513',
    expect: '合集',
    minParts: 40,
  },
];

/** 纯函数检查：链接识别规则（不依赖网络） */
function checkLinkParsing() {
  console.log('[链接识别 · 纯函数]');
  const pc = [
    ['标准合集链接', 'https://space.bilibili.com/546195/channel/collectiondetail?sid=1903592', { mid: 546195, sid: 1903592 }],
    ['参数顺序无关', 'https://space.bilibili.com/546195/channel/collectiondetail?spm_id_from=333.999&sid=1903592', { mid: 546195, sid: 1903592 }],
    ['结尾斜杠', 'https://space.bilibili.com/546195/channel/collectiondetail/?sid=1903592', { mid: 546195, sid: 1903592 }],
    ['普通视频链接返回 null', 'https://www.bilibili.com/video/BV17NHX6KEX2', null],
    ['系列链接返回 null', 'https://space.bilibili.com/546195/channel/seriesdetail?sid=123', null],
    ['非B站域名返回 null', 'https://example.com/546195/channel/collectiondetail?sid=1903592', null],
    ['缺 sid 返回 null', 'https://space.bilibili.com/546195/channel/collectiondetail', null],
  ];
  for (const [name, url, want] of pc) {
    const got = parseCollectionLink(url);
    const ok = want === null ? got === null : !!got && got.mid === want.mid && got.sid === want.sid;
    check(name, ok, JSON.stringify(got));
  }
  check('系列链接可被识别', isSeriesLink('https://space.bilibili.com/546195/channel/seriesdetail?sid=123') === true);
  check('合集链接不被误判为系列', isSeriesLink('https://space.bilibili.com/546195/channel/collectiondetail?sid=123') === false);
  console.log('');
}

app.whenReady().then(async () => {
  console.log('\n========== 解析层专项测试 ==========\n');
  const bili = new BiliClient(session.defaultSession);

  checkLinkParsing();

  for (const c of CASES) {
    console.log(`[${c.name}] ${c.input}`);
    try {
      const m = await resolveLink(bili, c.input);
      check('类型判定正确', m.type === c.expect, `实际=${m.type} 期望=${c.expect}`);
      check(`分集数量 ≥ ${c.minParts}`, m.parts.length >= c.minParts, `实际=${m.parts.length}`);
      check('标题非空', !!m.title, String(m.title).slice(0, 30));
      check('UP 主信息完整', !!(m.up && m.up.name && m.up.mid), m.up && m.up.name);
      check('每个 part 都有 cid', m.parts.every((p) => !!p.cid));
      check('每个 part 都有 bvid', m.parts.every((p) => !!p.bvid));

      const p0 = m.parts[0];
      console.log(`      首集：idx=${p0.index} cid=${p0.cid} bvid=${p0.bvid} 时长=${p0.duration}s`);
      console.log(`      标题：${String(p0.title).slice(0, 34)}`);

      // 用首集验证能拿到流
      const play = await bili.playurl(p0.bvid, p0.cid, 127);
      const { videos, audios } = extractStreams(play);
      check('首集可取到视频流', videos.length > 0, `${videos.length} 条`);
      check('首集可取到音频流', audios.length > 0, `${audios.length} 条`);
    } catch (e) {
      check('解析过程无异常', false, e.message);
    }
    console.log('');
  }

  console.log(`========== 结果：通过 ${pass}，失败 ${fail} ==========\n`);
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 300);
});
