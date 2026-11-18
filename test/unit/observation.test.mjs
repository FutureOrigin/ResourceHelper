import test from 'node:test';
import assert from 'node:assert/strict';

import { isMuxedContainer, mediaToObservation } from '../../src/core/observation.js';

test('视频观测：视频地址进 videoUrl，音轨为空', () => {
  const obs = mediaToObservation({
    key: 'https://x/v.mp4', hash: 'r1', group_key: 'grp', title: '视频',
    type: 'video', extension: 'MP4', is_audio: false,
    qualities: [{ label: '1080P', width: 1920, height: 1080, videoUrl: 'https://x/v.mp4', audioUrl: '' }]
  }, 7, 3);
  assert.equal(obs.groupKey, 'grp');
  assert.equal(obs.scope.tabId, 7);
  assert.equal(obs.scope.generation, 3);
  assert.equal(obs.variant.extension, 'mp4', '扩展名统一小写');
  assert.equal(obs.variant.videoUrl, 'https://x/v.mp4');
  assert.equal(obs.variant.audioUrl, '');
  assert.equal(obs.variant.height, 1080);
  assert.equal(obs.kind, 'media');
});

test('音频观测：地址进 audioUrl', () => {
  const obs = mediaToObservation({
    key: 'https://x/a.m4a', url: 'https://x/a.m4a', hash: 'r2', title: '音频', type: 'audio', extension: 'm4a', is_audio: true
  }, 1, 0);
  assert.equal(obs.kind, 'audio');
  assert.equal(obs.variant.audioUrl, 'https://x/a.m4a');
  assert.equal(obs.variant.videoUrl, '');
});

test('音画分离：视频变体带上自己的音轨地址', () => {
  const obs = mediaToObservation({
    key: 'https://x/v.mp4', hash: 'r3', extension: 'mp4',
    qualities: [{ label: '1080P', videoUrl: 'https://x/v.mp4', audioUrl: 'https://x/a.m4a' }]
  }, 1, 0);
  assert.equal(obs.variant.videoUrl, 'https://x/v.mp4');
  assert.equal(obs.variant.audioUrl, 'https://x/a.m4a');
});

test('归属字段优先用 media 自带的，否则用参数', () => {
  const obs = mediaToObservation({
    key: 'k', hash: 'h', url: 'https://x/a.mp4', extension: 'mp4',
    frame_id: 5, document_id: 'DOC', generation: 9, provenance: 'page-json'
  }, 2, 1);
  assert.equal(obs.scope.frameId, 5);
  assert.equal(obs.scope.documentId, 'DOC');
  assert.equal(obs.scope.generation, 9);
  assert.equal(obs.provenance, 'page-json');
});

test('会话容器判定', () => {
  assert.equal(isMuxedContainer('mp4'), true);
  assert.equal(isMuxedContainer('M4S'), true);
  assert.equal(isMuxedContainer('m3u8'), false);
  assert.equal(isMuxedContainer(''), false);
});
