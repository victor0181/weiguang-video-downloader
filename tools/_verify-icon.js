'use strict';
/* Verify that the icons embedded in an .exe really are the ones from the .ico:
 * walk the PE resource tree, pull each RT_ICON back out and compare it byte for
 * byte with the matching image in the file. Also dumps the 256x256 entry as a
 * viewable .png so the result can be eyeballed.
 *
 *   node tools/_verify-icon.js <exe> <ico> [out.png]
 */
const fs = require('fs');
const path = require('path');
const { parsePE, listResources, readIco } = require('./embed-icon.js');

const exe = process.argv[2];
const icoPath = process.argv[3];
const pngOut = process.argv[4];

const buf = fs.readFileSync(exe);
const pe = parsePE(buf);
const icons = listResources(buf, pe, [3]);
const groups = listResources(buf, pe, [14]);
const images = readIco(icoPath);

const g = groups[0];
const n = buf.readUInt16LE(g.dataFileOff + 4);
let allOk = true;
const rows = [];

for (let i = 0; i < n; i++) {
  const o = g.dataFileOff + 6 + i * 14;
  const w = buf[o] === 0 ? 256 : buf[o];
  const size = buf.readUInt32LE(o + 8);
  const iconId = buf.readUInt16LE(o + 12);
  const leaf = icons.find((x) => x.id === iconId && x.lang === g.lang);
  if (!leaf) { rows.push(w + 'x' + w + ': NO ICON RESOURCE'); allOk = false; continue; }
  const inExe = buf.subarray(leaf.dataFileOff, leaf.dataFileOff + leaf.size);
  const img = images.find((m) => m.w === w);
  const same = img && img.size === inExe.length && Buffer.compare(img.data, inExe) === 0;
  if (!same) allOk = false;
  rows.push(w + 'x' + w + ' iconId=' + iconId + ' bytes=' + inExe.length +
    ' vs ico=' + (img ? img.size : 'n/a') + ' -> ' + (same ? 'IDENTICAL' : 'DIFFERENT'));
}

// Dump the 256 image as a viewable PNG. logo.ico stores every size as a PNG
// (supported by Windows since Vista), so the bytes can be written out as-is.
if (pngOut) {
  const e = images.find((m) => m.w === 256) || images[0];
  if (e) {
    if (e.data.subarray(0, 4).toString('hex') === '89504e47') {
      fs.writeFileSync(pngOut, e.data);
      console.log('PNG written: ' + pngOut + '  (' + e.w + 'x' + e.h + ', PNG-compressed entry)');
    } else {
      console.log('PNG dump skipped: entry is not PNG-compressed');
    }
  }
}

console.log('exe = ' + exe + '  size=' + buf.length);
console.log(rows.join('\n'));
console.log(allOk ? 'RESULT: ALL IDENTICAL' : 'RESULT: MISMATCH');
process.exit(allOk ? 0 : 1);
