#!/usr/bin/env node
'use strict';

/*
 * build-portable.js -- build a green (unpacked, no-installer) Windows build.
 *
 * Why this file exists
 * --------------------
 * The project has no build chain, and the target machine has no system
 * Node/npm. So instead of pulling electron-builder (which also drags in NSIS /
 * winCodeSign helper binaries over the network), we reuse the Electron runtime
 * that already sits in node_modules/electron/dist and simply assemble a
 * runnable folder:
 *
 *   dist/<AppName>/
 *     <AppName>.exe            <- renamed electron.exe
 *     *.dll *.pak *.bin locales\ ...
 *     resources\
 *       app\                   <- our code (src / assets / docs / tools / package.json)
 *         node_modules\        <- production deps only (qrcode + its tree)
 *       bin\                   <- aria2c.exe + ffmpeg.exe + aria2c.conf
 *
 * resources/bin is exactly where src/main/config.js getBinDir() looks once
 * packaged (process.resourcesPath + '/bin'), so no source change is needed.
 * Note that bin MUST stay outside resources/app: if we ever ship the code as
 * app.asar, a child process cannot be spawned from inside an asar archive.
 *
 * The exe also gets its Win32 icon swapped for assets/logo.ico (see
 * embed-icon.js) -- renaming electron.exe does NOT change the icon Windows
 * shows in Explorer, that one lives in the PE resource section.
 *
 * Usage
 * -----
 *   node tools/build-portable.js            (plain Node)
 *   node tools/build-portable.js --zip      (also produce a shareable .zip)
 *   node tools/build-portable.js --stamp    (reset file times to the build time)
 *
 *   With no system Node installed, run it through the bundled Electron:
 *     set ELECTRON_RUN_AS_NODE=1
 *     node_modules\electron\dist\electron.exe tools\build-portable.js
 *
 * Console output is ASCII only on purpose: the default Windows console is
 * CP936 while Node writes UTF-8 bytes, so any Chinese log line would turn into
 * mojibake. Chinese is fine inside file contents and file names.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { embed: embedIcon, describe: describeIcon } = require('./embed-icon.js');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const OUT_ROOT = path.join(ROOT, 'dist');

// Files/dirs under electron/dist that must NOT be copied as-is.
//   resources\  -> holds the stock default_app.asar; we replace it with our app.
//   debug.log   -> runtime noise left behind by a previous launch.
const ELECTRON_SKIP_TOP = new Set(['resources', 'debug.log']);

// Content copied into resources/app (bin goes to resources/bin instead).
const APP_ENTRIES = ['package.json', 'src', 'assets', 'docs', 'tools', 'README.md'];

// Noise inside tools/ that should not ship.
//   directories  -> test outputs / throwaway browser profiles
//   _*.js        -> dev-only helpers. They need a specially prepared environment
//                   (BD_SCREENSHOT automation mode, a build to inspect) and are
//                   useless to someone who just unzipped the release, so keeping
//                   them out of the package costs nothing. They stay in the repo.
const APP_SKIP = new Set([
  'out', '_dy_out', '_dyprof', '_bilitest_prof', '_selftest_out',
  '_shot-about.js', '_shot-douyin.js', '_shot-pkg.js', '_verify-icon.js',
  // 自检脚本与它们的临时目录（详见各自文件头注释）
  '_mp3-test.js', '_mp3-e2e-node.js', '_ui-render.js', '_audio-e2e.js', '_node-shim.js',
  '_ui-clear-btn.js', '_config-reset.js', '_ui-reset-settings.js', '_ui-chip-select.js',
  '_dy-4k-probe.js', '_health-probe.js', '_ui-health-banner.js', '_dy-resolve-probe.js',
  '_dy-timing-probe.js', '_dy-detail-probe.js',
  '_stale-aria2-probe.js', '_ffmpeg-guard-probe.js', '_health-sample-probe.js',
  '_ui-home-audio.png', '_ui-queue-transcode.png', '_ui-clear-btn.png', '_ui-reset-settings.png',
  '_ui-chip-select.png', '_ui-health-banner.png',
  '_configreset_prof', '_dy4k_out', '_dy4kprof', '_dy_out2', '_dyprof2', '_healthprof',
  '_stale_probe_out', '_ffguard_out',
  '_audiotest_out', '_audiotest_prof', '_mp3e2e_out', '_mp3e2e_prof', '_mp3test', '_nodetest_prof',
]);

/** 同步睡眠（打包脚本全程同步，借 Atomics.wait 阻塞主线程） */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 建目录，带退避重试。
 *
 * ★ 为什么不能直接 mkdirSync：Windows 在 rmSync 返回后，目录可能仍处于
 *   "pending delete" 状态，立刻重建同名目录会 EPERM；本机沙箱把删除行为
 *   异步化（送到回收站）后更是稳定踩到。退避重试几轮即可。
 */
function mkdirWithRetry(dir, tries = 25, waitMs = 200) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return;
    } catch (e) {
      last = e;
      sleepSync(waitMs);
    }
  }
  throw last;
}

function readAppName() {
  // Single source of truth: src/main/main.js  ->  const APP_NAME = '...'
  try {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
    const m = src.match(/^const APP_NAME\s*=\s*['"]([^'"]+)['"]/m);
    if (m && m[1]) return m[1];
  } catch (e) { /* fall through */ }
  return 'video-downloader';
}

function readDataDirName() {
  // Same single source of truth: src/main/main.js -> const DATA_DIR_NAME = '...'
  // ★ 注意：这是**程序同级目录**下的数据文件夹名（不再是 %APPDATA% 里的名字）。
  // 自动同步，免得数据搬到别处之后使用说明里还写着旧路径。
  try {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
    const m = src.match(/^const DATA_DIR_NAME\s*=\s*['"]([^'"]+)['"]/m);
    if (m && m[1]) return m[1];
  } catch (e) { /* fall through */ }
  return 'data';
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch (e) {
    return '0.0.0';
  }
}

/**
 * Resolve the production dependency closure by walking package.json files.
 * The layout produced by npm here is flat (all packages hoisted to the top
 * level node_modules), so a plain name lookup is enough. Written by hand so
 * the script still works when npm is unavailable.
 */
function collectProdDeps() {
  const nm = path.join(ROOT, 'node_modules');
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const found = new Map();
  const queue = Object.keys(rootPkg.dependencies || {});
  const missing = [];

  while (queue.length) {
    const name = queue.shift();
    if (found.has(name)) continue;
    const dir = path.join(nm, name);
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      missing.push(name);
      continue;
    }
    found.set(name, dir);
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (e) { /* ignore */ }
    for (const d of Object.keys(pkg.dependencies || {})) {
      if (!found.has(d)) queue.push(d);
    }
  }
  return { found, missing };
}

/**
 * Recursive copy, written by hand on purpose.
 *
 * do NOT switch this to fs.cpSync: inside the WorkBuddy sandbox fs.cpSync
 * silently KILLS the node process (no exception, no stderr, exit code 127)
 * as soon as it is asked to copy certain trees. Reproduced with
 * fs.cpSync('node_modules/qrcode', dst, { recursive: true }).
 * mkdirSync + copyFileSync walk works every time, so we use that.
 *
 * @param {Set<string>|null} skip  entry NAMES to skip, applied at this level only
 */
function copyTree(src, dest, skip) {
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (skip && skip.has(e.name)) continue;
      copyTree(path.join(src, e.name), path.join(dest, e.name), null);
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  return true;
}

function dirSize(target) {
  let total = 0;
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) walk(path.join(p, e));
    } else {
      total += st.size;
    }
  };
  walk(target);
  return total;
}

/**
 * Electron ships every file with a fixed 1980-01-01T00:00Z timestamp (their
 * release archives normalise times for reproducible builds), and Windows'
 * CopyFile keeps that time -- which is why a freshly built package looks like
 * it was made in 1980. Harmless, but confusing to whoever you hand it to.
 * `--stamp` rewrites every timestamp to the moment of the build.
 */
function stampTree(dir, when) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += stampTree(p, when);
    else { fs.utimesSync(p, when, when); n++; }
  }
  return n;
}

const human = (n) => {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
};

const log = (s) => process.stdout.write(s + '\n');
const step = (n, total, s) => log('  [' + n + '/' + total + '] ' + s);

function fail(msg) {
  log('');
  log('  [ERROR] ' + msg);
  process.exit(1);
}

// ---------- minimal zip writer ----------
//
// The archive is built here instead of shelling out to tar.exe / PowerShell,
// because both mangle non-ASCII entry names:
//   * Windows bsdtar (tar -a -c -f x.zip) writes names as GBK WITHOUT the
//     UTF-8 flag (general purpose bit 11) -> fine on a Chinese Windows, but
//     mojibake on other locales / Linux / macOS.
//   * Compress-Archive does set bit 11, but stores '\\' as the path separator
//     (non-standard) and is very slow on a 400 MB tree.
// Writing the archive by hand gives UTF-8 names AND standard '/' separators.

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(d) {
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF,
  };
}

function zipDir(srcDir, zipPath, rootName) {
  const entries = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const relPath = rel + '/' + e.name;
      if (e.isDirectory()) {
        entries.push({ name: relPath + '/', dir: true });
        walk(full, relPath);
      } else {
        entries.push({ name: relPath, dir: false, full });
      }
    }
  })(srcDir, rootName);

  if (entries.length > 0xFFFF) throw new Error('too many entries for a plain zip');

  const now = dosDateTime(new Date());
  const fd = fs.openSync(zipPath, 'w');
  let offset = 0;
  const central = [];
  const write = (b) => { fs.writeSync(fd, b, 0, b.length, offset); offset += b.length; };

  try {
    for (const en of entries) {
      const nameBuf = Buffer.from(en.name, 'utf8');
      let method = 0, crc = 0, compSize = 0, uncompSize = 0, data = null;

      if (!en.dir) {
        const raw = fs.readFileSync(en.full);
        const deflated = zlib.deflateRawSync(raw);
        if (deflated.length < raw.length) {
          method = 8; data = deflated; compSize = deflated.length;
        } else {
          method = 0; data = raw; compSize = raw.length;
        }
        crc = crc32(raw);
        uncompSize = raw.length;
      }

      const localOffset = offset;
      if (localOffset > 0xFFFFFFFF || compSize > 0xFFFFFFFF || uncompSize > 0xFFFFFFFF) {
        throw new Error('archive exceeds 4 GB; zip64 is not implemented (' + en.name + ')');
      }

      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);       // version needed
      lh.writeUInt16LE(0x0800, 6);   // bit 11 = names are UTF-8
      lh.writeUInt16LE(method, 8);
      lh.writeUInt16LE(now.time, 10);
      lh.writeUInt16LE(now.date, 12);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(compSize, 18);
      lh.writeUInt32LE(uncompSize, 22);
      lh.writeUInt16LE(nameBuf.length, 26);
      lh.writeUInt16LE(0, 28);
      write(lh); write(nameBuf);
      if (data) write(data);

      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);       // version made by
      ch.writeUInt16LE(20, 6);       // version needed
      ch.writeUInt16LE(0x0800, 8);
      ch.writeUInt16LE(method, 10);
      ch.writeUInt16LE(now.time, 12);
      ch.writeUInt16LE(now.date, 14);
      ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(compSize, 20);
      ch.writeUInt32LE(uncompSize, 24);
      ch.writeUInt16LE(nameBuf.length, 28);
      ch.writeUInt16LE(0, 30);       // extra len
      ch.writeUInt16LE(0, 32);       // comment len
      ch.writeUInt16LE(0, 34);       // disk start
      ch.writeUInt16LE(0, 36);       // internal attrs
      ch.writeUInt32LE(en.dir ? 0x10 : 0, 38);  // DOS attrs
      ch.writeUInt32LE(localOffset, 42);
      central.push({ ch, nameBuf });
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const c of central) {
      write(c.ch); write(c.nameBuf);
      centralSize += c.ch.length + c.nameBuf.length;
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);
    write(eocd);
  } finally {
    fs.closeSync(fd);
  }
  return entries.length;
}

function main() {
  const wantZip = process.argv.includes('--zip');
  const wantStamp = process.argv.includes('--stamp');
  const appName = readAppName();
  const dataDirName = readDataDirName();
  const version = readVersion();
  const outDir = path.join(OUT_ROOT, appName);
  const exeName = appName + '.exe';
  const srcExe = path.join(ELECTRON_DIST, 'electron.exe');

  log('');
  log('  ============================================================');
  log('   Portable build  --  ' + appName + '  v' + version);
  log('  ============================================================');
  log('');

  // ---- preflight ----
  if (!fs.existsSync(srcExe)) {
    fail('Electron runtime not found at ' + srcExe +
      '\n          Run the install script first (needs Node.js + network).');
  }
  for (const f of ['aria2c.exe', 'ffmpeg.exe', 'aria2c.conf']) {
    if (!fs.existsSync(path.join(ROOT, 'bin', f))) {
      fail('Missing bin/' + f + ' -- the package would not be able to download anything.');
    }
  }
  for (const f of ['main.js', 'preload.js']) {
    if (!fs.existsSync(path.join(ROOT, 'src', 'main', f))) {
      fail('Missing src/main/' + f + ' -- wrong working directory?');
    }
  }

  const TOTAL = 7;

  // ---- 1. clean ----
  step(1, TOTAL, 'Cleaning ' + path.relative(ROOT, outDir) + ' ...');
  if (fs.existsSync(outDir)) {
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
    } catch (e) {
      // Windows keeps a lock on the running exe, so a still-open app lands here.
      fail('Cannot clear ' + path.relative(ROOT, outDir) + ' (' + (e.code || e.message) + ').' +
        '\n          Is ' + exeName + ' still running? Close it (and its tray icon) and try again.');
    }
  }
  mkdirWithRetry(outDir);

  // ---- 2. electron runtime ----
  step(2, TOTAL, 'Copying Electron runtime (this is the slow part) ...');
  copyTree(ELECTRON_DIST, outDir, ELECTRON_SKIP_TOP);

  // Stock electron.exe -> <AppName>.exe
  const dstExe = path.join(outDir, exeName);
  fs.renameSync(path.join(outDir, 'electron.exe'), dstExe);

  // ---- 3. app icon ----
  step(3, TOTAL, 'Embedding the app icon into ' + exeName + ' ...');
  try {
    const r = embedIcon(dstExe, path.join(ROOT, 'assets', 'logo.ico'));
    log('         group ' + r.groupId + ' lang ' + r.lang + ' -> ' + r.sizes.join('/') + ' px');
  } catch (e) {
    log('  [warn] icon embedding failed: ' + e.message);
    log('         the exe will keep Electron\'s stock icon.');
  }

  // ---- 4. app code ----
  step(4, TOTAL, 'Copying application code into resources/app ...');
  const appDir = path.join(outDir, 'resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  for (const entry of APP_ENTRIES) {
    const from = path.join(ROOT, entry);
    if (!fs.existsSync(from)) continue;
    copyTree(from, path.join(appDir, entry), entry === 'tools' ? APP_SKIP : null);
  }

  // ---- 4.5 build stamp ----
  // app 根目录写一份 build-info.json：关于页与启动日志都会显示它。
  // ★ 目的：让「用户到底跑的是哪个包」一眼可辨。历史上好几个差异极大的包都叫
  //   v1.1.0，导致「我明明修了为什么还这样」的排查成本极高（2026-10-12 实际踩过）。
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const builtAt =
    `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ` +
    `${p2(now.getHours())}:${p2(now.getMinutes())}`;
  const stamp = `v${version}-${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(
    now.getHours()
  )}${p2(now.getMinutes())}`;
  fs.writeFileSync(
    path.join(appDir, 'build-info.json'),
    JSON.stringify({ version, builtAt, stamp }, null, 2) + '\n',
    'utf8'
  );
  log('  build stamp: ' + stamp + '  (' + builtAt + ')');

  // ---- 5. production dependencies ----
  step(5, TOTAL, 'Copying production dependencies ...');
  const { found, missing } = collectProdDeps();
  const nmOut = path.join(appDir, 'node_modules');
  fs.mkdirSync(nmOut, { recursive: true });
  for (const [name, dir] of found) {
    copyTree(dir, path.join(nmOut, name), null);
  }
  if (missing.length) {
    log('  [warn] declared but not installed (skipped): ' + missing.join(', '));
  }

  // ---- 6. sidecar binaries ----
  step(6, TOTAL, 'Copying aria2c / ffmpeg into resources/bin ...');
  const binOut = path.join(outDir, 'resources', 'bin');
  fs.mkdirSync(binOut, { recursive: true });
  copyTree(path.join(ROOT, 'bin'), binOut, null);

  // ---- 7. readme ----
  step(7, TOTAL, 'Writing usage notes ...');
  const readme = [
    appName + ' —— 绿色免安装版  (v' + version + ')',
    '='.repeat(46),
    '',
    '一、怎么用',
    '  1. 把整个「' + appName + '」文件夹解压到任意位置（建议非系统盘，如 D 盘）。',
    '  2. 双击文件夹里的「' + exeName + '」即可运行。',
    '  3. 首次运行若弹出蓝色「Windows 已保护你的电脑」→ 点「更多信息」→「仍要运行」。',
    '     原因：本程序没有购买代码签名证书，这是 Windows 对无签名程序的常规提示，不是病毒。',
    '',
    '二、注意事项',
    '  · 不要只把 ' + exeName + ' 单独拷走：resources 与 ' + dataDirName + ' 文件夹都得和它在一起。',
    '  · 数据全部在程序自己的文件夹里（绿色便携，不往系统盘塞）：',
    '      ' + dataDirName + '\\   设置、下载记录、B站/抖音 登录态、缓存全在里面；',
    '      logs\\   运行日志 app.log，反馈问题时把它发回来即可。',
    '  · 想换台电脑或在 U 盘里用：连整个文件夹一起拷过去就行，设置和登录态都跟着走。',
    '  · 用过老版本（数据还在 %APPDATA% 里那会儿）的话，首次运行会自动把旧数据',
    '    整份搬进 ' + dataDirName + '\\，设置与登录态都不会丢，无需手动处理。',
    '  · 卸载：直接删掉整个文件夹即可，不留任何残余（数据就在里面，一并清掉了）。',
    '  · 未登录 B站 时最高只能下 480P（B站 的限制，且接口会"谎报"更高画质）；',
    '    用「扫码登录」后会按账号权限给到更高清晰度。',
    '',
    '三、目录说明',
    '  ' + exeName + '                主程序',
    '  ' + dataDirName + '\\' + ' '.repeat(Math.max(1, 24 - dataDirName.length)) + '全部程序数据（设置 / 下载记录 / 登录态 / 缓存）',
    '  logs\\                        运行日志 app.log',
    '  resources\\app\\               程序代码（src / assets / docs / tools / node_modules）',
    '  resources\\bin\\               内置 aria2c.exe 与 ffmpeg.exe（下载与混流靠它们）',
    '  resources\\app\\tools\\         自检脚本，可在此目录命令行里运行',
    '',
    '四、想自己重新打包',
    '  在本目录命令行执行：node tools\\build-portable.js        （或双击 打包.bat）',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(outDir, '使用说明.txt'), '\ufeff' + readme, 'utf8');

  // ---- verify ----
  const must = [
    dstExe,
    path.join(appDir, 'package.json'),
    path.join(appDir, 'src', 'main', 'main.js'),
    path.join(appDir, 'src', 'renderer', 'index.html'),
    path.join(appDir, 'node_modules', 'qrcode', 'package.json'),
    path.join(binOut, 'aria2c.exe'),
    path.join(binOut, 'ffmpeg.exe'),
    path.join(binOut, 'aria2c.conf'),
  ];
  const bad = must.filter((p) => !fs.existsSync(p));
  if (bad.length) {
    fail('Post-build verification failed, missing:\n          ' + bad.join('\n          '));
  }

  // A silently un-embedded icon is easy to miss, so read it back.
  let iconLine = '';
  try {
    const info = describeIcon(dstExe);
    const g = info.groups[0];
    const sizes = g ? g.entries.map((e) => e.w).sort((a, b) => a - b) : [];
    iconLine = sizes.length
      ? '   Icon ' + sizes.join('/') + ' px'
      : '   [warn] no icon sizes found in the exe';
  } catch (e) {
    iconLine = '   [warn] icon readback failed: ' + e.message;
  }

  let stampLine = '';
  if (wantStamp) {
    const n = stampTree(outDir, new Date());
    stampLine = '   Stamped ' + n + ' files with the build time';
  }

  const total = dirSize(outDir);
  log('');
  log('  ------------------------------------------------------------');
  log('   OK   ' + outDir);
  log('   Size ' + human(total) + '   (' + found.size + ' production packages)');
  if (iconLine) log(iconLine);
  if (stampLine) log(stampLine);
  log('   Run  ' + exeName);
  log('  ------------------------------------------------------------');

  if (wantZip) {
    const zipPath = path.join(OUT_ROOT, appName + '-v' + version + '-portable-x64.zip');
    log('');
    log('  Zipping -> ' + path.basename(zipPath) + ' ...');
    if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
    try {
      const n = zipDir(outDir, zipPath, appName);
      log('  OK   ' + zipPath);
      log('       ' + human(fs.statSync(zipPath).size) + ', ' + n + ' entries');
    } catch (e) {
      log('  [warn] zip step failed: ' + e.message);
      log('         the folder itself is complete and usable.');
    }
  }
  log('');
}

main();
