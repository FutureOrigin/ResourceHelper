/**
 * 字体反爬（私用区码位 + 自绘字体）还原
 *
 * 线上样本见 test/fixtures/fonts/private-use-subset.otf：
 * 用思源黑体裁出 8 个字、去掉 hinting 与子程序（与站点做法一致），
 * 再把码位改成 U+E000..U+E007。指纹表能认出它们的轮廓，说明
 * "轮廓指纹 → 真字"这条链路是通的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  applyMapping,
  buildPrivateUseMapping,
  collectPrivateUse,
  isPrivateUse,
  openFontTables,
  parseGlyphTable
} from '../../src/core/font-deobfuscate.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURE = path.join(ROOT, 'test/fixtures/fonts/private-use-subset.otf');
const TABLE = path.join(ROOT, 'src/data/glyph-table.bin');
const CHARS = ['雨', '夜', '雷', '声', '风', '灯', '影', '火'];

const table = parseGlyphTable(new Uint8Array(readFileSync(TABLE)));

test('内置指纹表可解析，覆盖量合理', () => {
  assert.ok(table.size > 20000, '表太小，GBK 覆盖面不对：' + table.size);
  for (const key of table.keys()) assert.match(key, /^[0-9a-f]{12}$/);
});

test('私用区码位识别覆盖三个平面', () => {
  assert.equal(isPrivateUse(0xE000), true);
  assert.equal(isPrivateUse(0xF8FF), true);
  assert.equal(isPrivateUse(0xF0000), true);
  assert.equal(isPrivateUse(0x10FFFD), true);
  assert.equal(isPrivateUse(0x4E00), false);
  assert.equal(isPrivateUse(0x20), false);
});

test('统计正文里的私用区字符', () => {
  const stats = collectPrivateUse('雨\uE000夜\uE000\uE001！');
  assert.equal(stats.total, 3);
  assert.deepEqual(stats.distinct.sort(), ['\uE000', '\uE001']);
  assert.equal(collectPrivateUse('全是正常文字').total, 0);
});

test('沙箱字体里的 8 个私用区码位全部还原成真字', async () => {
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  const { map, glyphs, matched } = await buildPrivateUseMapping(bytes, table);
  assert.equal(glyphs, CHARS.length);
  assert.equal(matched, CHARS.length);
  CHARS.forEach((char, index) => {
    assert.equal(map.get(0xE000 + index), char, 'U+' + (0xE000 + index).toString(16) + ' 应还原为 ' + char);
  });
});

test('还原后的正文可以直接用；没命中的字符原样保留', async () => {
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  const { map } = await buildPrivateUseMapping(bytes, table);
  const source = '\uE000\uE001，\uE002\uE003。\uE007\uE0FF';
  assert.equal(applyMapping(source, map), '雨夜，雷声。火\uE0FF');
});

test('指纹表头部被破坏时明确报错', () => {
  const bytes = new Uint8Array(readFileSync(TABLE));
  const broken = bytes.slice(0, 4096);
  broken[0] = 0;
  assert.throws(() => parseGlyphTable(broken), /bad-glyph-table/);
});

test('woff2 明确拒绝而不是给出错字', async () => {
  const fake = new Uint8Array([0x77, 0x4F, 0x46, 0x32, 0, 0, 0, 0]);
  await assert.rejects(() => openFontTables(fake), /woff2-unsupported/);
});

test('非字体字节不会伪装成成功', async () => {
  await assert.rejects(() => openFontTables(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), /unknown-font-format/);
});
