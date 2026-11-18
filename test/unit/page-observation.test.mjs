import test from 'node:test';
import assert from 'node:assert/strict';

import { variantsToObservations } from '../../src/core/page-observation.js';

const variants = [
  { kind: 'video', id: '80', url: 'https://upos.example/v80.m4s', height: 1080, width: 1920, bitrate: 2400000, label: '1080P 高清', videoOnly: true },
  { kind: 'video', id: '64', url: 'https://upos.example/v64.m4s', height: 720, label: '720P 准高清', videoOnly: true },
  { kind: 'audio', id: '30280', url: 'https://upos.example/a192.m4s', bitrate: 192000, label: '192K 高保真' }
];

test('同一条媒体的多个变体共享 group_key', () => {
  const list = variantsToObservations({ adapterId: 'bilibili-video', mediaId: 'BV1xx', title: '某视频', variants });
  assert.equal(list.length, 3);
  for (const item of list) assert.equal(item.group_key, 'bilibili-video:BV1xx');
});

test('变体 id 由 URL 稳定推导，重复解析得到同一个 id', () => {
  const a = variantsToObservations({ adapterId: 'x', mediaId: '1', variants });
  const b = variantsToObservations({ adapterId: 'x', mediaId: '1', variants });
  assert.deepEqual(a.map((item) => item.hash), b.map((item) => item.hash));
});

test('视频/音频按 kind 与容器区分', () => {
  const list = variantsToObservations({ adapterId: 'x', mediaId: '1', title: 't', variants });
  assert.equal(list[0].is_audio, false);
  assert.equal(list[0].video_only, true);
  assert.equal(list[2].is_audio, true);
  assert.equal(list[2].qualities[0].videoUrl, '');
  assert.equal(list[2].qualities[0].audioUrl, 'https://upos.example/a192.m4s');
});

test('标题保持媒体名，画质只作为变体标签', () => {
  const list = variantsToObservations({ adapterId: 'x', mediaId: '1', title: '某视频', variants });
  assert.equal(list[0].title, '某视频', '标题里不应混入画质');
  assert.equal(list[0].qualities[0].label, '1080P 高清');
  const noLabel = variantsToObservations({ adapterId: 'x', mediaId: '1', title: '', variants: [{ kind: 'video', url: 'https://x/a.mp4', height: 480 }] });
  assert.equal(noLabel[0].title, '480P');
});

test('没有媒体 id 时每条变体各自成卡（DOM 采集的兜底）', () => {
  const list = variantsToObservations({ adapterId: 'generic-dom', mediaId: '', variants });
  assert.equal(list.length, 3);
  const keys = new Set(list.map((item) => item.group_key));
  assert.equal(keys.size, 3, '没有 id 时不应把不同地址合并到一张卡');
});

test('URL 与扩展名缺失时有合理兜底', () => {
  const list = variantsToObservations({ adapterId: 'x', mediaId: '1', variants: [{ kind: 'video', url: 'https://x/stream' }] });
  assert.equal(list[0].extension, 'mp4');
  const withQuery = variantsToObservations({ adapterId: 'x', mediaId: '1', variants: [{ kind: 'video', url: 'https://x/a.M4S?token=1' }] });
  assert.equal(withQuery[0].extension, 'm4s');
  assert.equal(variantsToObservations({ adapterId: 'x', mediaId: '1', variants: [{ kind: 'video' }] }).length, 0, '没有地址的变体直接丢弃');
});

test('作用域与来源透传', () => {
  const list = variantsToObservations({
    adapterId: 'x', mediaId: '1', variants,
    scope: { tabId: 9, frameId: 2, documentId: 'DOC', generation: 3 },
    provenance: 'page-json'
  });
  assert.equal(list[0].frame_id, 2);
  assert.equal(list[0].document_id, 'DOC');
  assert.equal(list[0].provenance, 'page-json');
});
