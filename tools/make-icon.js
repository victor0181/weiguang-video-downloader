// make-icon.js —— 生成应用图标（assets/logo.ico）
//
//   node_modules/electron/dist/electron.exe tools/make-icon.js [输出路径]
//   默认输出 assets/logo.ico；同时把各尺寸 PNG 写到 tools/out/ 便于预览，
//   并额外渲染一张「多尺寸 + 明/暗底」对照图 tools/out/icon-preview.png。
//
// 设计：靛蓝→蓝→青 渐变圆角方块 + 白色「下载」符号（下箭头 + 托盘）
//   —— 软件已从 BiliDown-Next 改名为通用的「视频下载器」，图标不再用字母 B，
//      改用任何尺寸下都能一眼认出的「下载」符号；托盘（U 形）让它更明确地
//      读作"存下来"而不是"下一段/下一条"。
//   —— 与界面里的 .tb-logo / .about-logo 是同一套几何（同一渲染引擎渲染，视觉完全对齐）。
//
// 想改外观：改下面的 THEME / LAYOUT / glyphMarkup() 即可，无需碰渲染逻辑。
'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

// Windows 控制台默认 GBK(936)，Electron 输出 UTF-8 字节会乱码 → 先切成 UTF-8
if (process.platform === 'win32' && process.stdout && process.stdout.isTTY) {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore', windowsHide: true });
  } catch (e) {
    /* ignore */
  }
}

// 生成的尺寸（Windows 会按需挑最合适的一张）
const SIZES = [256, 128, 64, 48, 32, 24, 16];

const THEME = {
  // 与 css/app.css 里的 --logo-1 / --logo-2 / --logo-3 保持一致
  stops: ['#6d4dff', '#4f6bff', '#22d3ee'],
  radiusPct: 22.5, // 圆角占边长比例（与界面里的方块观感一致）
  glyph: '#ffffff',
  // 对照图用（明/暗底各来一条，方便判断小尺寸下的对比度）
  previewBg: ['#eef1f7', '#171a21'],
  previewLabel: ['rgba(20,26,40,.45)', 'rgba(255,255,255,.42)'],
};

// 字形几何。坐标系固定 24×24，与界面里内联 SVG 的那份完全一致 ——
// 改这里时记得同步 index.html 的 .tb-logo / .about-logo（两处必须同款）。
const LAYOUT = {
  svgRatio: 0.86, // svg 边长 / 图标边长
  svgRatioSmall: 1.1, // <= smallCutoff 时放大（此时已省略托盘，放大才不会显得空）
  smallCutoff: 20,
  arrowWidth: 2.9, // 箭头描边宽度（24 坐标系）
  trayWidth: 2.5, // 托盘描边宽度
  arrowDrop: 2.7, // 省略托盘时箭头下移量，让它仍然居中
};

/** 下箭头 + 托盘（托盘在极小尺寸下省略，否则会糊成一团） */
function glyphMarkup(size) {
  const withTray = size > LAYOUT.smallCutoff;
  const dy = withTray ? 0 : LAYOUT.arrowDrop;
  const arrow =
    `<g transform="translate(0 ${dy})" stroke-width="${LAYOUT.arrowWidth}">` +
    '<path d="M12 4.4 V14.1" />' +
    '<path d="M7.5 9.7 L12 14.2 L16.5 9.7" />' +
    '</g>';
  const tray = withTray
    ? `<path d="M5.1 16.2 V17.5 A3.1 3.1 0 0 0 8.2 20.6 H15.8 A3.1 3.1 0 0 0 18.9 17.5 V16.2"` +
      ` stroke-width="${LAYOUT.trayWidth}" />`
    : '';
  return arrow + tray;
}

function glyphSvg(size, extraStyle = '') {
  const r = size <= LAYOUT.smallCutoff ? LAYOUT.svgRatioSmall : LAYOUT.svgRatio;
  const px = (size * r).toFixed(2);
  return (
    `<svg width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="${THEME.glyph}"` +
    ` stroke-linecap="round" stroke-linejoin="round" style="display:block;${extraStyle}">` +
    glyphMarkup(size) +
    '</svg>'
  );
}

function pageHtml(size) {
  const [c1, c2, c3] = THEME.stops;
  // 注意：页面上按「目标像素尺寸」画出图标本体（#stage），窗口本身固定开大一点。
  // 原因：Windows 对窗口有最小尺寸限制，直接开 16px 窗口会被撑大，截出来只有一角。
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:transparent;overflow:hidden}
#stage{
  width:${size}px;height:${size}px;
  border-radius:${THEME.radiusPct}%;
  background:linear-gradient(135deg,${c1} 0%,${c2} 55%,${c3} 100%);
  display:flex;align-items:center;justify-content:center;
  overflow:hidden;
}
</style></head><body><div id="stage">${glyphSvg(size)}</div></body></html>`;
}

/** 对照图：两种底色 × 七种尺寸（1:1 实际像素），用来判断小尺寸下的可辨识度 */
const SHEET_W = 900;
const SHEET_STRIP_H = 340;
const SHEET_H = SHEET_STRIP_H * 2;

function previewHtml(sizes) {
  const [c1, c2, c3] = THEME.stops;
  const cell = (bg, i) =>
    `<div class="strip" style="background:${bg}">` +
    `<span class="lb" style="color:${THEME.previewLabel[i]}">实际像素 1:1 —— 16 · 24 · 32 · 48 · 64 · 128 · 256</span>` +
    '<div class="row">' +
    sizes
      .map(
        (s) =>
          `<div class="tile" style="width:${s + 16}px;height:${s + 16}px;border-radius:${Math.round(
            (s + 16) * (THEME.radiusPct / 100)
          )}px;background:linear-gradient(135deg,${c1} 0%,${c2} 55%,${c3} 100%)">` +
          glyphSvg(s) +
          '</div>'
      )
      .join('') +
    '</div></div>';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${SHEET_W}px;height:${SHEET_H}px;overflow:hidden;
  font:12px "Segoe UI","Microsoft YaHei",sans-serif;background:#fff}
.strip{height:${SHEET_STRIP_H}px;padding:20px 24px;display:flex;flex-direction:column;justify-content:flex-end}
.lb{display:block;margin-bottom:14px;letter-spacing:.4px}
.row{display:flex;align-items:flex-end;gap:16px}
.tile{display:flex;align-items:center;justify-content:center;flex:none}
</style></head><body>${cell(THEME.previewBg[0], 0)}${cell(THEME.previewBg[1], 1)}</body></html>`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 承载窗口开这么大（远大于最小窗口限制），实际图标按目标尺寸画在左上角
const CANVAS = 256;

/** 复用同一个窗口逐张渲染 → PNG Buffer */
async function renderPages(win, pages) {
  const out = [];
  for (const { key, html, w, h } of pages) {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await sleep(200); // 等字体/渐变画完（隐藏窗口没有 rAF 可用）
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
    if (!img || img.isEmpty()) throw new Error(`capture ${key} returned empty`);
    const got = img.getSize();
    if (got.width !== w || got.height !== h) {
      throw new Error(`capture ${key} returned ${got.width}x${got.height}, want ${w}x${h}`);
    }
    out.push({ key, png: img.toPNG() });
    await sleep(80);
  }
  return out;
}

/** 打包 ICO（每个条目内嵌 PNG，Windows Vista+ 支持） */
function buildIco(items) {
  const n = items.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(n, 4);

  const dir = Buffer.alloc(16 * n);
  let offset = 6 + 16 * n;
  items.forEach((it, i) => {
    const o = i * 16;
    const wh = it.size >= 256 ? 0 : it.size; // 256 记作 0
    dir.writeUInt8(wh, o);
    dir.writeUInt8(wh, o + 1);
    dir.writeUInt8(0, o + 2); // 调色板数
    dir.writeUInt8(0, o + 3); // 保留
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(it.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += it.png.length;
  });

  return Buffer.concat([header, dir, ...items.map((i) => i.png)]);
}

(async () => {
  app.commandLine.appendSwitch('force-device-scale-factor', '1');

  // Electron 默认在「所有窗口都关掉」时直接退出应用；这里我们是逐张
  // 创建→销毁窗口，必须禁用这个默认行为，否则渲染完第一张进程就没了。
  app.on('window-all-closed', () => {
    /* keep alive */
  });

  await app.whenReady();

  const outIco = process.argv[2] || path.join(__dirname, '..', 'assets', 'logo.ico');
  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });

  const sorted = [...SIZES].sort((a, b) => b - a);

  const win = new BrowserWindow({
    width: CANVAS,
    height: CANVAS,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    paintWhenInitiallyHidden: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // 隐藏窗口默认会被节流，会导致渲染不完整
    },
  });

  const rendered = [];
  try {
    // 1) 逐尺寸渲染图标本体
    for (const size of sorted) {
      const [r] = await renderPages(win, [
        { key: `${size}x${size}`, html: pageHtml(size), w: size, h: size },
      ]);
      rendered.push({ size, png: r.png });
      fs.writeFileSync(path.join(outDir, `icon-${size}.png`), r.png);
      console.log(`[make-icon] rendered ${size}x${size} (${r.png.length} bytes)`);
    }

    // 2) 对照图（窗口需要开大一些）
    win.setContentSize(SHEET_W, SHEET_H);
    await sleep(150);
    const [sheet] = await renderPages(win, [
      { key: 'preview', html: previewHtml(sorted), w: SHEET_W, h: SHEET_H },
    ]);
    fs.writeFileSync(path.join(outDir, 'icon-preview.png'), sheet.png);
    console.log(`[make-icon] preview sheet ${sheet.png.length} bytes`);
  } finally {
    win.destroy();
  }

  const ico = buildIco(rendered); // 已按尺寸从大到小
  fs.mkdirSync(path.dirname(outIco), { recursive: true });
  fs.writeFileSync(outIco, ico);

  console.log(`[make-icon] wrote ${outIco}  (${ico.length} bytes, ${rendered.length} sizes)`);
  console.log(`[make-icon] preview PNGs: ${outDir}`);

  app.exit(0);
})().catch((e) => {
  console.error('[make-icon] failed: ' + (e && e.stack ? e.stack : e));
  app.exit(1);
});
