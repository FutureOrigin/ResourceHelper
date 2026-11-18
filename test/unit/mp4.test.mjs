import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBox,
  concatBytes,
  findChild,
  findPath,
  getTrackId,
  listBoxes,
  parseTopLevel,
  readChunkOffsets,
  readMovieHeader,
  readUint32,
  setTrackId,
  shiftChunkOffsets,
  writeChunkOffsets,
  writeMovieDuration,
  writeUint32
} from '../../src/core/mp4.js';

function u32(n) {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function box(type, parts) {
  const body = concatBytes((parts || []).map((p) => (p instanceof Uint8Array ? p : new Uint8Array(0))));
  return buildBox(type, body);
}

test('buildBox 写入 size 与 type', () => {
  const boxed = buildBox('free', new Uint8Array([1, 2, 3]));
  assert.equal(boxed.length, 11);
  assert.equal(readUint32(boxed, 0), 11);
  assert.equal(String.fromCharCode(...boxed.slice(4, 8)), 'free');
});

test('listBoxes 顺序遍历且能处理嵌套', () => {
  const file = box('moov', [box('mvhd', new Uint8Array(8)), box('trak', new Uint8Array(4))]);
  const top = listBoxes(file, 0, file.length);
  assert.equal(top.length, 1);
  assert.equal(top[0].type, 'moov');
  const inner = listBoxes(file, 8, file.length);
  assert.deepEqual(inner.map((b) => b.type), ['mvhd', 'trak']);
});

test('64 位 size（size===1）被正确处理', () => {
  const payload = new Uint8Array([9, 9, 9, 9]);
  const boxed = new Uint8Array(16 + payload.length);
  writeUint32(boxed, 0, 1);                       // size = 1 → 走 largesize
  boxed.set([0x66, 0x72, 0x65, 0x65], 4);         // 'free'
  writeUint32(boxed, 8, 0);                       // largesize high
  writeUint32(boxed, 12, 16 + payload.length);    // largesize low
  boxed.set(payload, 16);

  const header = listBoxes(boxed, 0, boxed.length)[0];
  assert.equal(header.headerSize, 16);
  assert.equal(header.size, 16 + payload.length);
});

test('size 越界或过小直接视为无效，不会死循环', () => {
  const broken = new Uint8Array(12);
  writeUint32(broken, 0, 4);                      // size < header
  assert.deepEqual(listBoxes(broken, 0, broken.length), []);
});

test('tkhd 的 track_ID 可读可写（v0）', () => {
  const tkhdPayload = new Uint8Array(76);
  const tkhd = box('tkhd', [tkhdPayload]);
  const trak = box('trak', [tkhd]);
  assert.equal(getTrackId(trak, { type: 'trak', start: 0, end: trak.length, headerSize: 8 }), 0);
  setTrackId(trak, { type: 'trak', start: 0, end: trak.length, headerSize: 8 }, 7);
  assert.equal(getTrackId(trak, { type: 'trak', start: 0, end: trak.length, headerSize: 8 }), 7);
});

test('stco 读写与平移', () => {
  // version/flags(4) + entry_count(4) + 3 个 32 位偏移
  const payload = new Uint8Array(8 + 3 * 4);
  payload.set(u32(3), 4);
  payload.set(u32(100), 8);
  payload.set(u32(200), 12);
  payload.set(u32(300), 16);

  const trak = box('trak', [box('mdia', [box('minf', [box('stbl', [box('stco', [payload])])])])]);
  const trakBox = { type: 'trak', start: 0, end: trak.length, headerSize: 8 };
  const table = readChunkOffsets(trak, trakBox);
  assert.deepEqual(table.values, [100, 200, 300]);

  shiftChunkOffsets(trak, trakBox, 50);
  assert.deepEqual(readChunkOffsets(trak, trakBox).values, [150, 250, 350]);

  writeChunkOffsets(trak, readChunkOffsets(trak, trakBox).boxStart, 'stco', [1, 2, 3]);
  assert.deepEqual(readChunkOffsets(trak, trakBox).values, [1, 2, 3]);
});

test('mvhd 时长读取与写回', () => {
  const payload = new Uint8Array(96);
  payload.set(u32(1000), 12);   // timescale => box offset 20
  payload.set(u32(5000), 16);   // duration  => box offset 24
  const mvhd = box('mvhd', [payload]);
  const moov = box('moov', [mvhd]);
  const moovBox = { type: 'moov', start: 0, end: moov.length, headerSize: 8 };

  const header = readMovieHeader(moov, moovBox);
  assert.equal(header.timescale, 1000);
  assert.equal(header.duration, 5000);

  writeMovieDuration(moov, header, 9000);
  assert.equal(readMovieHeader(moov, moovBox).duration, 9000);
});

test('findPath 能定位到深层 box，找不到返回 null', () => {
  const trak = box('trak', [box('mdia', [box('minf', [box('stbl', [box('stco', new Uint8Array(8))])])])]);
  const found = findPath(trak, ['mdia', 'minf', 'stbl', 'stco'], 8, trak.length);
  assert.ok(found);
  assert.equal(found.type, 'stco');
  assert.equal(findPath(trak, ['mdia', 'minf', 'nope'], 8, trak.length), null);
});

test('findChild 只在直接子级里找（不越级）', () => {
  const moov = box('moov', [box('trak', [box('mdia', [])])]);
  const moovBox = { type: 'moov', start: 0, end: moov.length, headerSize: 8 };
  assert.ok(findChild(moov, moovBox, 'trak'));
  assert.equal(findChild(moov, moovBox, 'mdia'), null, 'mdia 在 trak 里面，不是直接子级');
});

test('parseTopLevel 汇总 ftyp / moov / mdat / 分片标记', () => {
  const file = concatBytes([
    box('ftyp', new Uint8Array(8)),
    box('moov', new Uint8Array(8)),
    box('mdat', new Uint8Array(16)),
    box('moof', new Uint8Array(8))
  ]);
  const parsed = parseTopLevel(file);
  assert.ok(parsed.ftyp);
  assert.ok(parsed.moov);
  assert.equal(parsed.mdat.length, 1);
  assert.equal(parsed.hasFragments, true);
});
