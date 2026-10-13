'use strict';

/*
 * embed-icon.js -- replace the Win32 icon of a PE file (.exe) IN PLACE.
 *
 * Why not kernel32's BeginUpdateResource / UpdateResource (what rcedit and
 * friends use)?
 *   UpdateResource does not reclaim the old block: it appends the new data at
 *   the end of the resource section and repoints the data entry. Electron's
 *   .rsrc section has essentially no spare room, so replacing its 4 icons
 *   (~37 KB of fresh data) exhausts the section, and every following call --
 *   including RT_GROUP_ICON -- just returns false. Verified: updating the group
 *   icon alone succeeds, doing it after the icons fails.
 *
 * So we patch the existing resource blocks byte for byte instead: zero new
 * space is needed, the file size never changes, and it is fully deterministic.
 * Consequence: the number of icon sizes is capped by the slots the .exe already
 * has (Electron ships 4). We fill them with the sizes the Windows shell
 * actually asks for -- 256 / 48 / 32 / 16 -- which is the complete useful set.
 *
 * Usage:
 *   node tools/embed-icon.js <exe> <ico>     replace the icon
 *   node tools/embed-icon.js <exe> --check   print what is currently embedded
 */

const fs = require('fs');

// Shell-relevant sizes, most important first. Explorer asks for 16 (list),
// 32 (medium/taskbar), 48 (large/alt-tab) and 256 (extra large); everything
// else it renders by scaling these.
const SIZE_PRIORITY = [256, 48, 32, 16, 64, 96, 128, 24, 20, 40, 60, 72, 512];

const RT_ICON = 3;
const RT_GROUP_ICON = 14;

// ---------- PE ----------

function parsePE(buf) {
  if (buf.length < 0x40) throw new Error('file too small to be a PE');
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', peOff, peOff + 4) !== 'PE\0\0') throw new Error('not a PE file');
  const coff = peOff + 4;
  const numSections = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = buf.readUInt16LE(opt);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('unexpected optional header magic 0x' + magic.toString(16));
  const ddBase = opt + (magic === 0x20b ? 112 : 96);
  const rsrcRva = buf.readUInt32LE(ddBase + 2 * 8);
  if (!rsrcRva) throw new Error('PE has no resource directory');

  const sections = [];
  const secOff = opt + optSize;
  for (let i = 0; i < numSections; i++) {
    const s = secOff + i * 40;
    sections.push({
      name: buf.toString('latin1', s, s + 8).replace(/\0+$/, ''),
      vsize: buf.readUInt32LE(s + 8),
      vaddr: buf.readUInt32LE(s + 12),
      rawSize: buf.readUInt32LE(s + 16),
      rawPtr: buf.readUInt32LE(s + 20),
    });
  }
  const rsrc = sections.find((s) => rsrcRva >= s.vaddr && rsrcRva < s.vaddr + Math.max(s.vsize, s.rawSize));
  if (!rsrc) throw new Error('resource directory is not inside any section');

  const rvaToFile = (rva) => {
    const sec = sections.find((s) => rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawSize));
    if (!sec) throw new Error('unmapped RVA 0x' + rva.toString(16));
    return sec.rawPtr + (rva - sec.vaddr);
  };

  return { sections, rsrcRva, rsrcBase: rsrc.rawPtr + (rsrcRva - rsrc.vaddr), rvaToFile };
}

/** Walk the resource tree; returns every leaf of the requested types. */
function listResources(buf, pe, types) {
  const found = [];
  const walk = (dirOff, level, type, id, lang) => {
    const named = buf.readUInt16LE(dirOff + 12);
    const ids = buf.readUInt16LE(dirOff + 14);
    for (let i = 0; i < named + ids; i++) {
      const e = dirOff + 16 + i * 8;
      const nameId = buf.readUInt32LE(e);
      const off = buf.readUInt32LE(e + 4);
      const isDir = (off & 0x80000000) !== 0;
      const child = pe.rsrcBase + (off & 0x7fffffff);
      const num = (nameId & 0x80000000) ? -1 : nameId;
      if (level === 0) {
        if (types.includes(num)) walk(child, 1, num, id, lang);
      } else if (level === 1) {
        if (!isDir) throw new Error('unexpected leaf at level 1');
        walk(child, 2, type, num, lang);
      } else {
        const dataRva = buf.readUInt32LE(child);
        found.push({
          type, id, lang: num,   // level 2 entries ARE the language ids
          size: buf.readUInt32LE(child + 4),
          dataFileOff: pe.rvaToFile(dataRva),
          sizeFieldOff: child + 4,
        });
      }
    }
  };
  walk(pe.rsrcBase, 0, 0, 0, 0);
  return found;
}

// ---------- ico ----------

function readIco(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt16LE(0) !== 0 || b.readUInt16LE(2) !== 1) throw new Error('not an .ico file: ' + file);
  const count = b.readUInt16LE(4);
  const images = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const size = b.readUInt32LE(o + 8);
    const off = b.readUInt32LE(o + 12);
    images.push({
      w: b[o] === 0 ? 256 : b[o],
      h: b[o + 1] === 0 ? 256 : b[o + 1],
      colors: b[o + 2],
      planes: b.readUInt16LE(o + 4),
      bpp: b.readUInt16LE(o + 6),
      size,
      data: b.subarray(off, off + size),
    });
  }
  return images;
}

function buildGroup(items) {
  const g = Buffer.alloc(6 + 14 * items.length);
  g.writeUInt16LE(0, 0);
  g.writeUInt16LE(1, 2);
  g.writeUInt16LE(items.length, 4);
  items.forEach((it, i) => {
    const o = 6 + i * 14;
    g[o] = it.w >= 256 ? 0 : it.w;
    g[o + 1] = it.h >= 256 ? 0 : it.h;
    g[o + 2] = it.colors & 0xff;
    g[o + 3] = 0;
    g.writeUInt16LE(it.planes, o + 4);
    g.writeUInt16LE(it.bpp, o + 6);
    g.writeUInt32LE(it.size, o + 8);
    g.writeUInt16LE(it.id, o + 12);
  });
  return g;
}

// ---------- check ----------

function describe(exePath) {
  const buf = fs.readFileSync(exePath);
  const pe = parsePE(buf);
  const icons = listResources(buf, pe, [RT_ICON]).sort((a, b) => a.id - b.id);
  const groups = listResources(buf, pe, [RT_GROUP_ICON]).sort((a, b) => a.id - b.id);
  const out = { exe: exePath, size: buf.length, groups: [], icons: [] };
  for (const g of groups) {
    const n = buf.readUInt16LE(g.dataFileOff + 4);
    const entries = [];
    for (let i = 0; i < n; i++) {
      const o = g.dataFileOff + 6 + i * 14;
      entries.push({
        w: buf[o] === 0 ? 256 : buf[o],
        h: buf[o + 1] === 0 ? 256 : buf[o + 1],
        bpp: buf.readUInt16LE(o + 6),
        size: buf.readUInt32LE(o + 8),
        iconId: buf.readUInt16LE(o + 12),
      });
    }
    out.groups.push({ id: g.id, lang: g.lang, entries });
  }
  for (const ic of icons) {
    out.icons.push({ id: ic.id, lang: ic.lang, size: ic.size });
  }
  return out;
}

// ---------- embed ----------

function embed(exePath, icoPath) {
  const buf = fs.readFileSync(exePath);
  const pe = parsePE(buf);
  const images = readIco(icoPath);

  const iconLeaves = listResources(buf, pe, [RT_ICON]).sort((a, b) => a.size - b.size);
  const groupLeaves = listResources(buf, pe, [RT_GROUP_ICON]).sort((a, b) => a.id - b.id);
  if (!iconLeaves.length) throw new Error('no RT_ICON resources in ' + exePath);
  if (!groupLeaves.length) throw new Error('no RT_GROUP_ICON resources in ' + exePath);

  // Reuse the existing icon slots so we never need extra room. Pick by shell
  // priority (16/32/48/256 before the rest), best-fitting each image into the
  // smallest free slot that can hold it.
  const slots = iconLeaves.map((l, i) => ({ leaf: l, used: false, index: i }));
  const chosen = [];
  for (const w of SIZE_PRIORITY) {
    const img = images.find((m) => m.w === w && m.h === w && !chosen.includes(m));
    if (!img) continue;
    let best = null;
    for (const s of slots) {
      if (s.used || s.leaf.size < img.size) continue;
      if (!best || s.leaf.size < best.leaf.size) best = s;
    }
    if (!best) continue;
    best.used = true;
    chosen.push({ img, slot: best.leaf });
  }
  if (!chosen.length) throw new Error('none of the .ico images fit into the existing icon slots');

  // Icon resource ids stay as they are (1..N); the group must point at them.
  const groupItems = chosen
    .map((c) => ({
      w: c.img.w, h: c.img.h, colors: c.img.colors, planes: c.img.planes, bpp: c.img.bpp,
      size: c.img.size, id: c.slot.id,
    }))
    .sort((a, b) => a.w - b.w);
  const group = buildGroup(groupItems);

  const groupLeaf = groupLeaves[0];
  if (group.length > groupLeaf.size) {
    throw new Error('new icon group needs ' + group.length + ' bytes but only ' + groupLeaf.size + ' are available');
  }

  // Collect every write first, then apply, so a failure cannot leave the file
  // half-patched in an unusable state.
  const patches = [];
  for (const c of chosen) {
    const { slot, img } = c;
    patches.push({ off: slot.dataFileOff, data: img.data });
    const padLen = slot.size - img.size;
    if (padLen > 0) patches.push({ off: slot.dataFileOff + img.size, data: Buffer.alloc(padLen) });
    const sz = Buffer.alloc(4);
    sz.writeUInt32LE(img.size, 0);
    patches.push({ off: slot.sizeFieldOff, data: sz });
  }
  patches.push({ off: groupLeaf.dataFileOff, data: group });
  const padGroup = groupLeaf.size - group.length;
  if (padGroup > 0) patches.push({ off: groupLeaf.dataFileOff + group.length, data: Buffer.alloc(padGroup) });

  const fd = fs.openSync(exePath, 'r+');
  try {
    for (const p of patches) {
      const written = fs.writeSync(fd, p.data, 0, p.data.length, p.off);
      if (written !== p.data.length) throw new Error('short write at 0x' + p.off.toString(16));
    }
  } finally {
    fs.closeSync(fd);
  }

  return {
    groupId: groupLeaf.id,
    lang: groupLeaf.lang,
    sizes: groupItems.map((g) => g.w),
    groupBytes: group.length,
  };
}

// ---------- cli ----------

function main() {
  const [, , a1, a2] = process.argv;
  if (!a1 || !a2) {
    console.error('usage: node tools/embed-icon.js <exe> <ico> | <exe> --check');
    process.exit(2);
  }
  try {
    if (a2 === '--check') {
      const info = describe(a1);
      console.log(JSON.stringify(info, null, 2));
      return;
    }
    const r = embed(a1, a2);
    console.log('ICON ok: group ' + r.groupId + ' (lang ' + r.lang + ') -> ' + r.sizes.join(', ') +
      '  [' + r.groupBytes + ' bytes]');
  } catch (e) {
    console.error('ICON FAIL: ' + e.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { embed, describe, parsePE, listResources, readIco };
