/**
 * 字体反爬正文还原
 *
 * 站点把常用字（以及 ASCII、标点）换成私用区码位（U+E000–U+F8FF 等），再用
 * 一份自绘子集字体把私用区码位画成真字的字形。结果是：页面看着完全正常，
 * 复制/提取出来却是一串私用区码位——普通字体里没有这些码位，看起来就是
 * "缺字/乱码"。
 *
 * 还原步骤：
 *   1. 找出正文实际使用的那个自绘字体（family 名是随机的，别按名字猜）；
 *   2. 下载字体，解析 cmap 拿到 私用区码位 → GID；
 *   3. 把每个 GID 解释成轮廓命令串，算 64 位指纹；
 *   4. 用内置指纹表（参考字体 = 思源黑体 SC Normal）反查真字。
 *
 * 这一步和解禁复制无关：解禁改的是 CSS 与事件，改不了"码位本身是私用区"。
 */

import {
  CffFont,
  getCffTable,
  readCmap,
  readSfntTables,
  readWoffTables,
  signatureHex
} from './font-glyph.js';

/** 轮廓命令串 → 指纹表键（64 位 FNV-1a 的高 48 位，12 位十六进制） */
export function glyphKey(outline) {
  return signatureHex(outline).slice(0, 12);
}

/** 私用区码位（BMP + 两个增补平面） */
export function isPrivateUse(cp) {
  return (cp >= 0xE000 && cp <= 0xF8FF) || (cp >= 0xF0000 && cp <= 0xFFFFD) || (cp >= 0x100000 && cp <= 0x10FFFD);
}

/** 统计文本里的私用区字符 */
export function collectPrivateUse(text) {
  const distinct = new Set();
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (isPrivateUse(cp)) {
      total++;
      distinct.add(ch);
    }
  }
  return { total, distinct: [...distinct] };
}

const TABLE_MAGIC = 0x47485431; // 'GHT1'

/**
 * 解析内置指纹表（tools/build-glyph-table.py 生成的二进制）。
 * 布局：magic 'GHT1' | version u16 | hashBytes u16 | count u32 |
 *       count*hashBytes 指纹 | count*2 UTF-16LE 真字 | crc32
 */
export function parseGlyphTable(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== TABLE_MAGIC) throw new Error('bad-glyph-table');
  const version = view.getUint16(4);
  if (version !== 1) throw new Error('unsupported-glyph-table-version');
  const hashBytes = view.getUint16(6);
  const count = view.getUint32(8);
  const hashStart = 12;
  const charStart = hashStart + count * hashBytes;
  const expected = charStart + count * 2;
  if (bytes.length < expected) throw new Error('truncated-glyph-table');
  const map = new Map();
  for (let i = 0; i < count; i++) {
    let key = '';
    for (let b = 0; b < hashBytes; b++) key += bytes[hashStart + i * hashBytes + b].toString(16).padStart(2, '0');
    map.set(key, String.fromCharCode(view.getUint16(charStart + i * 2)));
  }
  return map;
}

function isSfnt(bytes) {
  if (bytes.length < 4) return false;
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  return tag === 'OTTO' || tag === 'true' || tag === 'ttcf' || tag === '\x00\x01\x00\x00';
}

function isWoff(bytes) {
  return bytes.length >= 4 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'wOFF';
}

function isWoff2(bytes) {
  return bytes.length >= 4 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'wOF2';
}

/** WOFF1 → sfnt 表集合；inflate 由调用方提供（浏览器是 DecompressionStream） */
async function expandWoff(bytes, inflate) {
  const entries = readWoffTables(bytes);
  const tables = new Map();
  for (const entry of entries) {
    const data = entry.compLength === entry.origLength
      ? entry.data
      : await inflate(entry.data, entry.origLength);
    tables.set(entry.tag.trim(), data);
  }
  return tables;
}

/**
 * 字体字节 → 表集合。
 * 只支持 sfnt（OTTO/TTF）与 WOFF1；WOFF2 需要 brotli，浏览器里没有解压 API。
 */
export async function openFontTables(bytes, options = {}) {
  if (isSfnt(bytes)) return readSfntTables(bytes).tables;
  if (isWoff(bytes)) {
    return expandWoff(bytes, options.inflate || defaultInflate);
  }
  if (isWoff2(bytes)) throw new Error('woff2-unsupported');
  throw new Error('unknown-font-format');
}

/** WOFF1 的表体是 zlib 压缩的；浏览器与 Node 18+ 都自带 DecompressionStream */
async function defaultInflate(data) {
  if (typeof DecompressionStream !== 'function') throw new Error('woff-unsupported');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 字体字节 + 指纹表 → 私用区码位到真字的映射。
 * 返回 { map, glyphs, matched }：glyphs 是字体里被覆盖到的私用区码位总数。
 */
export async function buildPrivateUseMapping(bytes, table, options = {}) {
  const tables = await openFontTables(bytes, options);
  const cffBytes = getCffTable(tables);
  if (!cffBytes) throw new Error('not-a-cff-font');
  const font = new CffFont(cffBytes);
  const cmap = readCmap(tables);
  const map = new Map();
  let glyphs = 0;
  let matched = 0;
  for (const [cp, gid] of cmap) {
    if (!isPrivateUse(cp)) continue;
    if (gid >= font.numGlyphs) continue;
    glyphs++;
    let outline;
    try {
      outline = font.outline(gid);
    } catch (err) {
      continue;
    }
    if (!outline) continue;
    const char = table.get(glyphKey(outline));
    if (char) {
      map.set(cp, char);
      matched++;
    }
  }
  return { map, glyphs, matched };
}

/** 用映射替换文本里的私用区字符；未命中的原样保留 */
export function applyMapping(text, map) {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    out += map.get(cp) || ch;
  }
  return out;
}
