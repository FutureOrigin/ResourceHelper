import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILD_KINDS, MESSAGE, normalizeBuildRequest, normalizeProgress, normalizeReady } from '../../src/core/offscreen-protocol.js';

test('消息类型都带前缀且唯一', () => {
  const values = Object.values(MESSAGE);
  assert.equal(new Set(values).size, values.length);
  for (const value of values) assert.match(value, /^RH_/);
  assert.deepEqual(BUILD_KINDS, ['hls', 'dash', 'mux']);
});

test('构建请求：合法输入被规整', () => {
  const req = normalizeBuildRequest({ kind: 'hls', jobId: 'j1', tabId: 7, payload: { url: 'https://x/a.m3u8', title: '标题' } });
  assert.deepEqual(req, {
    kind: 'hls',
    jobId: 'j1',
    tabId: 7,
    payload: { url: 'https://x/a.m3u8', title: '标题', audioUrl: '', height: null }
  });
});

test('构建请求：kind 不支持 / 缺 url 一律返回 null（调用方回退本地）', () => {
  assert.equal(normalizeBuildRequest({ kind: 'live', payload: { url: 'x' } }), null);
  assert.equal(normalizeBuildRequest({ kind: 'hls', payload: {} }), null);
  assert.equal(normalizeBuildRequest(null), null);
  assert.equal(normalizeBuildRequest({ kind: 'hls', payload: { url: 'u' }, tabId: 'x' }).tabId, null);
});

test('就绪消息：必须是 blob URL 且有文件名', () => {
  const ready = normalizeReady({ jobId: 'j', blobUrl: 'blob:chrome-extension://abc/1', filename: 'a.mp4', meta: { title: 't' } });
  assert.equal(ready.filename, 'a.mp4');
  assert.equal(ready.meta.title, 't');

  assert.equal(normalizeReady({ blobUrl: 'https://x/a.mp4', filename: 'a' }), null);
  assert.equal(normalizeReady({ blobUrl: 'blob:x', filename: '   ' }), null);
  assert.equal(normalizeReady(null), null);
});

test('进度消息：夹紧到 0..100 并截断文案', () => {
  assert.equal(normalizeProgress({ percent: 150 }).percent, 100);
  assert.equal(normalizeProgress({ percent: -5 }).percent, 0);
  assert.equal(normalizeProgress({ percent: 'abc' }).percent, 0);
  const long = normalizeProgress({ text: 'x'.repeat(500) });
  assert.equal(long.text.length, 120);
});
