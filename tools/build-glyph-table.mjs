#!/usr/bin/env node
/**
 * 生成"字形指纹表"（src/data/glyph-table.bin）
 *
 * 站点做字体反爬时，把常用字换成私用区码位，再用自绘子集字体把码位画成真字。
 * 还原的思路是"认字形"：把每个字形解释成轮廓命令串，算 64 位 FNV-1a 指纹，
 * 再拿参考字体（思源黑体 SC Normal，SIL OFL 1.1）的全字符集指纹表反查。
 *
 * 这里刻意复用运行时那套解析代码（src/core/font-glyph.js），
 * 保证"建表"和"查表"用的是同一份轮廓序列化逻辑。
 *
 * 用法：
 *   node tools/build-glyph-table.mjs --font=<参考字体.otf> [--out=src/data/glyph-table.bin]
 *
 * 参考字体（版本要与站点子集来源一致，当前线上为 2.002）：
 *   https://cdn.jsdelivr.net/gh/adobe-fonts/source-han-sans@2.002R/OTF/SimplifiedChinese/SourceHanSansSC-Normal.otf
 *
 * 二进制布局（大端）：
 *   0  magic 'GHT1' | 4 version u16 | 6 hashBytes u16 | 8 count u32
 *   12 count*hashBytes 指纹（64 位 FNV-1a 的高 48 位）
 *     count*2 UTF-16BE 真字
 *   末尾 u32 crc32（覆盖前面全部字节）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CffFont, getCffTable, readCmap, readSfntTables, signatureHex } from '../src/core/font-glyph.js';

const HASH_BYTES = 6;
const MAGIC = 0x47485431; // 'GHT1'

const args = new Map(process.argv.slice(2).map((item) => {
  const index = item.indexOf('=');
  return index < 0 ? [item, ''] : [item.slice(0, index), item.slice(index + 1)];
}));
const fontPath = args.get('--font');
const outPath = args.get('--out') || 'src/data/glyph-table.bin';

if (!fontPath) {
  console.error('用法：node tools/build-glyph-table.mjs --font=<参考字体.otf> [--out=src/data/glyph-table.bin]');
  process.exit(1);
}

function isPrivateUse(cp) {
  return (cp >= 0xE000 && cp <= 0xF8FF) || (cp >= 0xF0000 && cp <= 0xFFFFD) || (cp >= 0x100000 && cp <= 0x10FFFD);
}

/** 可打印 ASCII + GBK 全部字符（去重、去私用区、保序） */
function charset() {
  const seen = new Set();
  const chars = [];
  for (let code = 0x20; code < 0x7F; code++) {
    const ch = String.fromCharCode(code);
    seen.add(ch);
    chars.push(ch);
  }
  let decoder;
  try {
    decoder = new TextDecoder('gbk');
  } catch (err) {
    throw new Error('当前 Node 不带 GBK 解码器（需要完整 ICU）');
  }
  for (let hi = 0x81; hi < 0xFF; hi++) {
    for (let lo = 0x40; lo < 0xFF; lo++) {
      if (lo === 0x7F) continue;
      let ch;
      try {
        ch = decoder.decode(new Uint8Array([hi, lo]));
      } catch (err) {
        continue;
      }
      if (!ch || ch.length !== 1) continue;
      if (seen.has(ch) || isPrivateUse(ch.codePointAt(0))) continue;
      seen.add(ch);
      chars.push(ch);
    }
  }
  return chars;
}

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const bytes = new Uint8Array(readFileSync(fontPath));
const { tables } = readSfntTables(bytes);
const cffBytes = getCffTable(tables);
if (!cffBytes) {
  console.error('参考字体没有 CFF 轮廓（TrueType 暂不支持）');
  process.exit(1);
}
const font = new CffFont(cffBytes);
const cmap = readCmap(tables);

const entries = [];
const seenKey = new Set();
let missing = 0;
for (const ch of charset()) {
  const gid = cmap.get(ch.codePointAt(0));
  if (gid === undefined || gid >= font.numGlyphs) {
    missing++;
    continue;
  }
  let outline;
  try {
    outline = font.outline(gid);
  } catch (err) {
    missing++;
    continue;
  }
  if (!outline) {
    missing++;
    continue;
  }
  const key = signatureHex(outline).slice(0, HASH_BYTES * 2);
  if (seenKey.has(key)) continue;
  seenKey.add(key);
  entries.push([key, ch]);
}

entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

const header = Buffer.alloc(12);
header.writeUInt32BE(MAGIC, 0);
header.writeUInt16BE(1, 4);
header.writeUInt16BE(HASH_BYTES, 6);
header.writeUInt32BE(entries.length, 8);

const hashBlock = Buffer.alloc(entries.length * HASH_BYTES);
const charBlock = Buffer.alloc(entries.length * 2);
entries.forEach(([key, ch], index) => {
  for (let i = 0; i < HASH_BYTES; i++) hashBlock[index * HASH_BYTES + i] = parseInt(key.slice(i * 2, i * 2 + 2), 16);
  charBlock.writeUInt16BE(ch.charCodeAt(0), index * 2);
});

const payload = Buffer.concat([header, hashBlock, charBlock]);
const checksum = Buffer.alloc(4);
checksum.writeUInt32BE(crc32(payload), 0);
const out = Buffer.concat([payload, checksum]);

writeFileSync(path.resolve(outPath), out);
console.log('[glyph-table] 参考字体 ' + path.basename(fontPath)
  + '；字形 ' + entries.length + ' 条，缺 ' + missing + '，'
  + (out.length / 1024).toFixed(1) + ' KiB -> ' + outPath
  + '（crc32 ' + checksum.readUInt32BE(0).toString(16).padStart(8, '0') + '）');
