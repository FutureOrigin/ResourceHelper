import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBox,
  children,
  findChild,
  groupFragments,
  listBoxes,
  listTrex,
  parseTopLevel,
  readChunkOffsets,
  readMfhdSequence,
  readTrunDataOffset,
  readUint32
} from '../../src/core/mp4.js';
import { REMUX_ERRORS, remuxAuto, remuxFragmented, remuxProgressive, canRemuxFragmented } from '../../src/core/remux.js';

function findTrun(bytes, moofBox) {
  const full = { type: 'moof', start: moofBox.start, end: moofBox.end, headerSize: 8, size: moofBox.size };
  const traf = children(bytes, full).find((b) => b.type === 'traf');
  return findChild(bytes, traf, 'trun');
}

/* ---------------- 合成 MP4 的最小构件 ---------------- */

function u32(n) {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function box(type, parts) {
  const body = parts.reduce((acc, part) => {
    const bytes = part instanceof Uint8Array ? part : new Uint8Array(0);
    const out = new Uint8Array(acc.length + bytes.length);
    out.set(acc, 0);
    out.set(bytes, acc.length);
    return out;
  }, new Uint8Array(0));
  return buildBox(type, body);
}

function mvhd(timescale, duration) {
  const payload = new Uint8Array(96);
  payload[0] = 0;                        // version 0
  payload[12] = (timescale >>> 24) & 0xff;
  payload[13] = (timescale >>> 16) & 0xff;
  payload[14] = (timescale >>> 8) & 0xff;
  payload[15] = timescale & 0xff;
  payload.set(u32(duration), 16);        // duration at payload offset 16 => box offset 24
  return buildBox('mvhd', payload);
}

function tkhd(trackId) {
  const payload = new Uint8Array(76);
  payload[0] = 0;                        // version 0
  payload.set(u32(trackId), 12);         // track_ID at payload 12 => box offset 20
  return buildBox('tkhd', payload);
}

function stco(offsets) {
  const payload = new Uint8Array(8 + offsets.length * 4);
  payload.set(u32(offsets.length), 4);
  offsets.forEach((value, index) => payload.set(u32(value), 8 + index * 4));
  return buildBox('stco', payload);
}

function trak(trackId, chunkOffsets) {
  return box('trak', [
    tkhd(trackId),
    box('mdia', [box('minf', [box('stbl', [stco(chunkOffsets)])])])
  ]);
}

const FTYP = box('ftyp', [new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0])]);

/** 造一个"单轨 + 单个 mdat"的 MP4，mdat 数据用 fill 填充 */
function makeSingleTrackFile(trackId, dataLength, fill, timescale) {
  const mdatData = new Uint8Array(dataLength).fill(fill);
  const mdatBox = buildBox('mdat', mdatData);
  // 先造一次拿 moov 尺寸，再填真实偏移
  const probeMoov = box('moov', [mvhd(timescale || 1000, 5000), trak(trackId, [0])]);
  const dataOffset = FTYP.length + probeMoov.length + 8;
  const moov = box('moov', [mvhd(timescale || 1000, 4000), trak(trackId, [dataOffset])]);
  const file = new Uint8Array(FTYP.length + moov.length + mdatBox.length);
  file.set(FTYP, 0);
  file.set(moov, FTYP.length);
  file.set(mdatBox, FTYP.length + moov.length);
  return { file, dataOffset, mdatData };
}

/* ---------------- 测试 ---------------- */

test('progressive 合流：两条轨的 chunk 偏移都被重写到正确位置', () => {
  const video = makeSingleTrackFile(1, 100, 0xaa);
  const audio = makeSingleTrackFile(1, 60, 0xbb, 48000); // track_id 故意与视频冲突

  const { data, stats } = remuxProgressive(video.file, audio.file);

  const top = parseTopLevel(data);
  assert.ok(top.moov, '输出必须有 moov');
  const traks = children(data, top.moov, 'trak');
  assert.equal(traks.length, 2, '输出必须包含视频与音频两条 trak');

  const videoOffsets = readChunkOffsets(data, traks[0]);
  const audioOffsets = readChunkOffsets(data, traks[1]);
  assert.equal(videoOffsets.count, 1);
  assert.equal(audioOffsets.count, 1);

  // 关键断言：偏移指向的字节必须是对应轨道的数据
  assert.equal(data[videoOffsets.values[0]], 0xaa, '视频偏移必须指向视频数据');
  assert.equal(data[videoOffsets.values[0] + 99], 0xaa);
  assert.equal(data[audioOffsets.values[0]], 0xbb, '音频偏移必须指向音频数据');
  assert.equal(data[audioOffsets.values[0] + 59], 0xbb);

  assert.equal(stats.audioTrackId, 2, 'track_id 冲突时应重新编号');

  // 输出应当恰好是：一个 ftyp + 一个 moov + 视频 mdat + 音频 mdat
  assert.equal(top.boxes.filter((b) => b.type === 'ftyp').length, 1);
  assert.equal(top.boxes.filter((b) => b.type === 'moov').length, 1);
  const mdats = top.boxes.filter((b) => b.type === 'mdat');
  assert.equal(mdats.length, 2, '两段载荷都要保留');
  assert.equal(mdats[0].size - 8, 100);
  assert.equal(mdats[1].size - 8, 60);
  // 音频 moov 被拆掉、只留 trak，所以总长必然小于两个文件之和
  assert.ok(data.length < video.file.length + audio.file.length);
});

test('合流后视频偏移相对原文件应当后移「音频 trak 的长度」', () => {
  const video = makeSingleTrackFile(1, 100, 0xaa);
  const audio = makeSingleTrackFile(2, 60, 0xbb, 48000);
  const topBefore = parseTopLevel(video.file);
  const before = readChunkOffsets(video.file, children(video.file, topBefore.moov, 'trak')[0]);

  const { data, stats } = remuxProgressive(video.file, audio.file);
  const topAfter = parseTopLevel(data);
  const after = readChunkOffsets(data, children(data, topAfter.moov, 'trak')[0]);

  assert.equal(after.values[0] - before.values[0], stats.videoDelta);
  assert.ok(stats.videoDelta > 0);
});

test('空输入与非 MP4 输入给出明确错误码', () => {
  assert.throws(
    () => remuxProgressive(new Uint8Array(0), new Uint8Array(1)),
    (e) => e.code === REMUX_ERRORS.EMPTY
  );
  const notMp4 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  try {
    remuxProgressive(notMp4, notMp4);
    assert.fail('应当抛错');
  } catch (e) {
    assert.equal(e.code, REMUX_ERRORS.NO_MOOV);
  }
});

test('分片 MP4（fMP4）明确拒绝，交给分片路径', () => {
  const video = makeSingleTrackFile(1, 100, 0xaa);
  const audio = makeSingleTrackFile(2, 60, 0xbb, 48000);
  const fragment = box('moof', [new Uint8Array(8)]);
  const withFragments = new Uint8Array(video.file.length + fragment.length);
  withFragments.set(video.file, 0);
  withFragments.set(fragment, video.file.length);

  try {
    remuxProgressive(withFragments, audio.file);
    assert.fail('应当抛错');
  } catch (e) {
    assert.equal(e.code, REMUX_ERRORS.FRAGMENTED);
  }
});

test('输出可被自己的解析器完整遍历（box 长度自洽）', () => {
  const video = makeSingleTrackFile(1, 128, 0xaa);
  const audio = makeSingleTrackFile(2, 64, 0xbb, 48000);
  const { data } = remuxProgressive(video.file, audio.file);
  const boxes = listBoxes(data, 0, data.length);
  let cursor = 0;
  for (const box of boxes) {
    assert.equal(box.start, cursor);
    cursor = box.end;
  }
  assert.equal(cursor, data.length, 'box 链必须精确覆盖整个文件');
});

/* ---------------- 分片 MP4（fMP4）---------------- */

function mfhd(sequence) {
  const payload = new Uint8Array(8);
  payload.set(u32(sequence), 4);
  return buildBox('mfhd', payload);
}

function tfhd(trackId, flags) {
  const payload = new Uint8Array(8);
  payload.set(u32(trackId), 4);
  const boxed = buildBox('tfhd', payload);
  boxed[9] = (flags >>> 16) & 0xff;
  boxed[10] = (flags >>> 8) & 0xff;
  boxed[11] = flags & 0xff;
  return boxed;
}

function tfdt(time) {
  const payload = new Uint8Array(8);
  payload.set(u32(time), 4);
  return buildBox('tfdt', payload);
}

function trun(dataOffset) {
  const payload = new Uint8Array(12);
  payload[3] = 0x01;                    // flags: data-offset-present
  payload.set(u32(1), 4);               // sample_count
  payload.set(u32(dataOffset), 8);
  return buildBox('trun', payload);
}

function trex(trackId) {
  const payload = new Uint8Array(24);
  payload.set(u32(trackId), 4);
  return buildBox('trex', payload);
}

/** 造一个分片 MP4：ftyp + moov(mvex) + N×(moof + mdat) */
function makeFragmented(trackId, fragmentCount, fill) {
  const FTYP_FRAG = box('ftyp', [new Uint8Array([0x69, 0x73, 0x6f, 0x35, 0, 0, 2, 0])]);
  const moov = box('moov', [
    mvhd(1000, 0),
    box('trak', [tkhd(trackId), box('mdia', [])]),
    box('mvex', [trex(trackId)])
  ]);

  const fragments = [];
  for (let i = 0; i < fragmentCount; i += 1) {
    const mdat = buildBox('mdat', new Uint8Array(32).fill(fill));
    // 先算 moof 长度：用占位 offset 造一次
    const probe = box('moof', [mfhd(i + 1), box('traf', [tfhd(trackId, 0x020000), tfdt(1024 * i), trun(0)])]);
    const dataOffset = probe.length + 8;
    const moof = box('moof', [mfhd(i + 1), box('traf', [tfhd(trackId, 0x020000), tfdt(1024 * i), trun(dataOffset)])]);
    fragments.push(moof, mdat);
  }

  const parts = [FTYP_FRAG, moov].concat(fragments);
  const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    file.set(part, offset);
    offset += part.length;
  }
  return file;
}

test('fMP4 合流：合成双轨 moov 并交错片段、重编序号', () => {
  const video = makeFragmented(1, 2, 0xaa);
  const audio = makeFragmented(1, 2, 0xbb);   // track_id 故意冲突

  const { data, stats } = remuxFragmented(video, audio);

  const top = parseTopLevel(data);
  assert.ok(top.moov, '输出必须有 moov');
  const traks = children(data, top.moov, 'trak');
  assert.equal(traks.length, 2, '两条 trak');

  const mvex = children(data, top.moov, 'mvex')[0];
  assert.ok(mvex, '必须有 mvex');
  assert.equal(listTrex(data, mvex).length, 2, '两条 trex');

  const groups = groupFragments(data).fragments;
  assert.equal(groups.length, 4, '2 视频 + 2 音频片段');

  const sequences = groups.map((group) => {
    const moofBox = { type: 'moof', start: group.moof.start, end: group.moof.end, headerSize: 8, size: group.moof.size };
    const inner = children(data, moofBox);
    return readMfhdSequence(data, inner.find((b) => b.type === 'mfhd'));
  });
  assert.deepEqual(sequences, [1, 2, 3, 4], '序号必须连续递增');

  // 交错顺序：视频、音频、视频、音频
  const videoGroup = groups[0];
  const audioGroup = groups[1];
  const videoDataOffset = readTrunDataOffset(data, findTrun(data, videoGroup.moof));
  const audioDataOffset = readTrunDataOffset(data, findTrun(data, audioGroup.moof));
  assert.equal(data[videoGroup.moof.start + videoDataOffset], 0xaa, '视频片段的数据应可定位');
  assert.equal(data[audioGroup.moof.start + audioDataOffset], 0xbb, '音频片段的数据应可定位');

  assert.equal(stats.audioTrackId, 2, 'track_id 冲突时音频重编为 2');
  assert.equal(stats.sequences, 4);
});

test('fMP4 合流：音频侧 tfhd 的 track_id 被同步重编', () => {
  const video = makeFragmented(3, 1, 0xaa);
  const audio = makeFragmented(3, 1, 0xbb);
  const { data } = remuxFragmented(video, audio);
  const groups = groupFragments(data).fragments;
  const audioTraf = children(data, { type: 'moof', start: groups[1].moof.start, end: groups[1].moof.end, headerSize: 8, size: groups[1].moof.size })
    .find((b) => b.type === 'traf');
  const tfhdBox = children(data, audioTraf).find((b) => b.type === 'tfhd');
  assert.equal(readUint32(data, tfhdBox.start + 12), 4, '音频 tfhd 应改成 3+1');
});

test('整文件输入交给 fMP4 路径时明确报错', () => {
  const video = makeSingleTrackFile(1, 100, 0xaa);
  const audio = makeSingleTrackFile(2, 60, 0xbb, 48000);
  try {
    remuxFragmented(video.file, audio.file);
    assert.fail('应当抛错');
  } catch (e) {
    assert.equal(e.code, REMUX_ERRORS.NO_FRAGMENTS);
  }
});

test('remuxAuto 按输入是否含 moof 自动选路', () => {
  const fragmented = makeFragmented(1, 1, 0xaa);
  const audioFragmented = makeFragmented(2, 1, 0xbb);
  const viaFragments = remuxAuto(fragmented, audioFragmented);
  assert.equal(parseTopLevel(viaFragments.data).hasFragments, true, '分片输入应产出分片输出');

  const video = makeSingleTrackFile(1, 100, 0xaa);
  const audio = makeSingleTrackFile(2, 60, 0xbb, 48000);
  const viaProgressive = remuxAuto(video.file, audio.file);
  assert.equal(parseTopLevel(viaProgressive.data).hasFragments, false, '整文件输入应产出整文件');
});

test('canRemuxFragmented 能区分两种输入', () => {
  const fragmented = makeFragmented(1, 1, 0xaa);
  const progressive = makeSingleTrackFile(1, 100, 0xaa);
  assert.equal(canRemuxFragmented(fragmented, fragmented), true);
  assert.equal(canRemuxFragmented(progressive.file, progressive.file), false);
});
