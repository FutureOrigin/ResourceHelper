import test from 'node:test';
import assert from 'node:assert/strict';

import { canMux, pairVariants, pickAudioFor, sameFamily } from '../../src/core/pair.js';

const video = (overrides) => Object.assign({
  id: 'v1080', isAudio: false, extension: 'mp4', url: 'https://x/v1080.mp4', bitrate: 2000000, height: 1080
}, overrides || {});

const audio = (overrides) => Object.assign({
  id: 'a140', isAudio: true, extension: 'm4a', url: 'https://x/a140.m4a', bitrate: 128000, lang: 'und'
}, overrides || {});

test('容器族判定', () => {
  assert.equal(sameFamily('mp4', 'm4a'), true);
  assert.equal(sameFamily('webm', 'weba'), true);
  assert.equal(sameFamily('mp4', 'webm'), false);
  assert.equal(sameFamily('unknown', 'm4a'), null);
});

test('同容器族优先，跨族排除', () => {
  const chosen = pickAudioFor(video({ extension: 'webm' }), [
    audio({ id: 'aac', extension: 'm4a' }),
    audio({ id: 'opus', extension: 'webm', bitrate: 160000 })
  ]);
  assert.equal(chosen.id, 'opus');
});

test('同族内按码率取高', () => {
  const chosen = pickAudioFor(video(), [
    audio({ id: 'low', bitrate: 64000 }),
    audio({ id: 'high', bitrate: 192000 })
  ]);
  assert.equal(chosen.id, 'high');
});

test('原声轨优先于码率略高的配音轨', () => {
  const chosen = pickAudioFor(video(), [
    audio({ id: 'dub', bitrate: 200000, lang: 'ja' }),
    audio({ id: 'original', bitrate: 128000, isOriginal: true })
  ]);
  assert.equal(chosen.id, 'original');
});

test('没有可用音轨时返回 null', () => {
  assert.equal(pickAudioFor(video(), []), null);
  assert.equal(pickAudioFor(video({ extension: 'mp4' }), [audio({ extension: 'webm' })]), null,
    '容器族不兼容时不能硬配');
});

test('pairVariants 给每条视频轨配一条音轨', () => {
  const { pairs, unpaired } = pairVariants([
    video({ id: 'v1' }),
    video({ id: 'v2' }),
    audio({ id: 'a1' })
  ]);
  assert.equal(pairs.size, 2);
  assert.equal(pairs.get('v1').id, 'a1');
  assert.equal(pairs.get('v2').id, 'a1');
  assert.deepEqual(unpaired, []);
});

test('视频轨自带 audioUrl 时不重复配对', () => {
  const { pairs } = pairVariants([
    video({ id: 'v1', audioUrl: 'https://x/own.m4a' }),
    audio({ id: 'a1' })
  ]);
  assert.equal(pairs.size, 0, '站点已显式配对，不再猜');
});

test('没有任何音轨时全部进 unpaired', () => {
  const { pairs, unpaired } = pairVariants([video({ id: 'v1' }), video({ id: 'v2' })]);
  assert.equal(pairs.size, 0);
  assert.deepEqual(unpaired, ['v1', 'v2']);
});

test('canMux 拒绝 fMP4 分片（当前 remux 只支持整文件）', () => {
  assert.equal(canMux('mp4', 'mp4'), true);
  assert.equal(canMux(undefined, undefined), true);
  assert.equal(canMux('fmp4-segment', 'mp4'), false);
  assert.equal(canMux('mp4', 'fmp4-segment'), false);
});
