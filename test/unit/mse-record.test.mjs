import test from 'node:test';
import assert from 'node:assert/strict';

import { MSE_RECORD_ERRORS, MseRecorder, kindOf, startsWithInitSegment } from '../../src/core/mse-record.js';
import { children, parseTopLevel } from '../../src/core/mp4.js';
import { makeFragmented, splitIntoMseChunks } from '../fixtures/fmp4.mjs';

function feed(recorder, mimeType, chunks) {
  for (const chunk of chunks) recorder.add(mimeType, chunk);
}

test('双轨录制 -> 合流成一个双 trak 文件', () => {
  const recorder = new MseRecorder();
  feed(recorder, 'video/mp4; codecs="avc1.640028"', splitIntoMseChunks(makeFragmented(1, 2, 0xaa)));
  feed(recorder, 'audio/mp4; codecs="mp4a.40.2"', splitIntoMseChunks(makeFragmented(1, 2, 0xbb)));

  assert.equal(recorder.trackCount, 2);
  const result = recorder.assemble();
  assert.equal(result.mode, 'mux');
  assert.equal(result.tracks, 2);

  const top = parseTopLevel(result.data);
  assert.ok(top.moov, '输出必须带 moov');
  assert.equal(children(result.data, top.moov, 'trak').length, 2);
  assert.deepEqual(result.warnings, []);
});

test('只有视频轨：直接拼接，不做合流', () => {
  const recorder = new MseRecorder();
  const chunks = splitIntoMseChunks(makeFragmented(1, 3, 0xaa));
  feed(recorder, 'video/mp4', chunks);

  const result = recorder.assemble();
  assert.equal(result.mode, 'single');
  const expected = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  assert.equal(result.data.length, expected, '单轨应当逐字节保留');
});

test('只有音频轨：标记为 audio', () => {
  const recorder = new MseRecorder();
  feed(recorder, 'audio/webm', splitIntoMseChunks(makeFragmented(1, 1, 0xcc)));
  const result = recorder.assemble();
  assert.equal(result.mode, 'audio');
  assert.equal(result.tracks, 1);
});

test('没有初始化段时给出 MISSING_INIT 警告而不是静默产出坏文件', () => {
  const recorder = new MseRecorder();
  // 只喂分片（moof/mdat），不给 ftyp+moov
  const chunks = splitIntoMseChunks(makeFragmented(1, 2, 0xaa)).slice(1);
  feed(recorder, 'video/mp4', chunks);
  const result = recorder.assemble();
  assert.ok(result.warnings.includes('MISSING_INIT'));
});

test('超过上限后拒绝新数据，但已录内容仍可组装', () => {
  const recorder = new MseRecorder({ maxBytes: 200 });
  const chunks = splitIntoMseChunks(makeFragmented(1, 2, 0xaa));
  const results = chunks.map((chunk) => recorder.add('video/mp4', chunk));

  assert.ok(results.some((item) => item.accepted === false && item.reason === 'TOO_LARGE'));
  assert.ok(recorder.droppedBytes > 0);
  assert.ok(recorder.totalBytes <= 200);
  const assembled = recorder.assemble();
  assert.ok(assembled.data.length > 0);
});

test('空录制给出明确错误码', () => {
  const recorder = new MseRecorder();
  assert.throws(() => recorder.assemble(), (e) => e.code === MSE_RECORD_ERRORS.EMPTY);
});

test('轨道顺序：视频优先，其次按字节数', () => {
  const recorder = new MseRecorder();
  recorder.add('audio/mp4', new Uint8Array(10));
  recorder.add('video/mp4', new Uint8Array(4));
  recorder.add('video/mp4', new Uint8Array(4));
  const list = recorder.trackList();
  assert.equal(list[0].kind, 'video');
  assert.equal(list[1].kind, 'audio');
});

test('工具函数：mime 分类与初始化段判定', () => {
  assert.equal(kindOf('video/mp4; codecs="avc1"'), 'video');
  assert.equal(kindOf('audio/webm'), 'audio');
  assert.equal(kindOf(''), 'other');
  assert.equal(startsWithInitSegment(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])), true);
  assert.equal(startsWithInitSegment(new Uint8Array([0, 0, 0, 0x10, 0x6d, 0x6f, 0x6f, 0x66])), false);
  assert.equal(startsWithInitSegment(new Uint8Array(2)), false);
});
