import test from 'node:test';
import assert from 'node:assert/strict';

import { createLiveState, describeProgress, nextSegments, recommendInterval } from '../../src/core/live-record.js';

const seg = (sequence, uri, extra) => Object.assign({ sequence, uri, duration: 4 }, extra || {});

test('首次拉取：整窗都要', () => {
  const state = createLiveState();
  const result = nextSegments(state, { segments: [seg(1, 'a'), seg(2, 'b'), seg(3, 'c')] });
  assert.equal(result.added, 3);
  assert.deepEqual(result.segments.map((s) => s.uri), ['a', 'b', 'c']);
  assert.equal(state.lastSequence, 3);
});

test('第二次拉取：只取新增，旧片跳过', () => {
  const state = createLiveState();
  nextSegments(state, { segments: [seg(1, 'a'), seg(2, 'b')] });
  const result = nextSegments(state, { segments: [seg(1, 'a'), seg(2, 'b'), seg(3, 'c'), seg(4, 'd')] });
  assert.deepEqual(result.segments.map((s) => s.uri), ['c', 'd']);
  assert.equal(result.skipped, 2);
  assert.equal(state.totalSegments, 4);
});

test('没有新增时不重复下载', () => {
  const state = createLiveState();
  nextSegments(state, { segments: [seg(1, 'a'), seg(2, 'b')] });
  const result = nextSegments(state, { segments: [seg(1, 'a'), seg(2, 'b')] });
  assert.equal(result.added, 0);
  assert.equal(result.segments.length, 0);
});

test('序列号跳变如实计入 gaps，不假装连贯', () => {
  const state = createLiveState();
  nextSegments(state, { segments: [seg(1, 'a')] });
  const result = nextSegments(state, { segments: [seg(1, 'a'), seg(5, 'e')] });
  assert.equal(result.added, 1);
  assert.equal(result.gaps, 3, '中间缺了 2/3/4 三片');
});

test('播放列表回退（换源/重开）时重置游标', () => {
  const state = createLiveState();
  nextSegments(state, { segments: [seg(101, 'a'), seg(102, 'b')] });
  const result = nextSegments(state, { segments: [seg(1, 'x'), seg(2, 'y')] });
  assert.equal(result.reset, true);
  assert.deepEqual(result.segments.map((s) => s.uri), ['x', 'y']);
  assert.equal(state.lastSequence, 2);
});

test('不连续标记会被记录一次', () => {
  const state = createLiveState();
  const result = nextSegments(state, { segments: [seg(1, 'a', { discontinuity: true }), seg(2, 'b')] });
  assert.equal(result.discontinuity, true);
  assert.equal(state.discontinuity, 1);
});

test('同一地址即使序列号变了也不重复下载', () => {
  const state = createLiveState();
  nextSegments(state, { segments: [seg(1, 'same')] });
  const result = nextSegments(state, { segments: [seg(2, 'same')] });
  assert.equal(result.added, 0, '地址已见过就跳过');
});

test('seen 集合不会无限增长', () => {
  const state = createLiveState();
  for (let round = 0; round < 50; round += 1) {
    const segments = [];
    for (let i = 0; i < 10; i += 1) segments.push(seg(round * 10 + i, 'u' + (round * 10 + i)));
    nextSegments(state, { segments });
  }
  assert.ok(state.seen.size <= 4 * 32 * 4, 'seen 应被裁剪到一个窗口量级，实际 ' + state.seen.size);
});

test('轮询间隔取目标时长一半并夹紧', () => {
  assert.equal(recommendInterval(4), 2000);
  assert.equal(recommendInterval(0.2), 1000);
  assert.equal(recommendInterval(60), 10000);
  assert.equal(recommendInterval(undefined), 4000, '未知目标时长时按 4 秒轮询');
});

test('进度摘要', () => {
  const state = createLiveState();
  nextSegments(state, { segments: [seg(1, 'a'), seg(2, 'b')] });
  const progress = describeProgress(state, 125000);
  assert.equal(progress.segments, 2);
  assert.equal(progress.seconds, 125);
});
