/**
 * 真实清单回归（P3/P4 的"泛用性"证据）
 *
 * 前面的解析测试都用合成 fixture，只能证明"按规范实现"。
 * 这里用真实线上清单（已下载到 test/fixtures/real/）验证同一套解析器能吃下真货：
 *   · Apple 的 fMP4 示例：主列表带 aud1/aud2/aud3 音轨组、字幕组、CC 组
 *   · Apple 的媒体列表：EXT-X-MAP 初始化段 + 大量分片
 *   · Akamai 的 DASH MPD：SegmentTemplate 固定时长 + 10 个视频档 + 1 个音轨
 *
 * 数据来源（公开示例）：
 *   https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/
 *   https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parseMasterPlaylist, parseMediaPlaylist, pickAudioRendition, pickBestVariant } from '../../src/core/hls.js';
import { parseMpd, parseIsoDuration, pickBestRepresentations } from '../../src/core/dash.js';

const DIR = path.resolve(import.meta.dirname, '../fixtures/real');
const read = (name) => readFileSync(path.join(DIR, name), 'utf8');

const APPLE_BASE = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8';

test('真实 HLS 主列表：变体、音轨组、字幕组都能解析', () => {
  const master = parseMasterPlaylist(read('apple-master.m3u8'), APPLE_BASE);

  // 真实清单里同一批分辨率会出现三次（分别配 aud1/aud2/aud3 三档音轨）
  assert.ok(master.variants.length >= 20, '至少 20 个变体，实际 ' + master.variants.length);

  const resolutions = master.variants.map((v) => v.resolution && v.resolution.height).filter(Boolean);
  assert.ok(resolutions.includes(1080), '应包含 1080P 档');
  assert.ok(resolutions.includes(540), '应包含 540P 档');

  const audioGroups = new Set(master.audioRenditions.map((item) => item.groupId));
  assert.deepEqual([...audioGroups].sort(), ['aud1', 'aud2', 'aud3'], '应有 3 个音轨组');
  assert.ok(master.subtitles.length >= 1, '应有字幕组');

  // 每条变体都必须引用一个真实存在的音轨组
  const groups = new Set(master.variants.map((v) => v.audioGroup));
  assert.deepEqual([...groups].sort(), ['aud1', 'aud2', 'aud3']);
  assert.ok(master.variants.every((v) => audioGroups.has(v.audioGroup)));
});

test('真实 HLS 主列表：能选出最高画质并配套音轨', () => {
  const master = parseMasterPlaylist(read('apple-master.m3u8'), APPLE_BASE);
  const best = pickBestVariant(master.variants, {});
  assert.equal(best.resolution.height, 1080);

  const audio = pickAudioRendition(master, best);
  assert.ok(audio && audio.uri, '应当挑到音轨播放列表');
  assert.ok(audio.uri.startsWith('https://'), '音轨地址必须是绝对地址：' + audio.uri);
  assert.ok(audio.uri.endsWith('.m3u8'));
});

test('真实 HLS 媒体列表：初始化段与分片都能解析', () => {
  const mediaUrl = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/v5/prog_index.m3u8';
  const media = parseMediaPlaylist(read('apple-media.m3u8'), mediaUrl);

  assert.ok(media.segments.length > 20, '应有大量分片，实际 ' + media.segments.length);
  assert.ok(media.initSegment && media.initSegment.uri, 'fMP4 应当有 EXT-X-MAP 初始化段');
  assert.ok(media.initSegment.uri.startsWith('https://'), '初始化段地址需补全为绝对地址');
  assert.equal(media.segments[0].sequence, 1, '媒体序列号从 1 开始');
  assert.ok(media.segments.every((s) => s.uri.startsWith('https://')));
  assert.ok(media.segments.every((s) => s.duration > 0));
});

test('真实 DASH MPD：时长、码率阶梯与选档', () => {
  const parsed = parseMpd(read('akamai-bbb.mpd'), 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd');

  assert.equal(parsed.isLive, false);
  assert.ok(Math.abs(parsed.durationSeconds - 634.566) < 0.01, 'MPD 时长应为 634.566s，实际 ' + parsed.durationSeconds);

  assert.equal(parsed.video.length, 10, '应有 10 个视频档');
  assert.equal(parsed.audio.length, 1, '应有 1 个音轨');

  const best = pickBestRepresentations(parsed, {});
  assert.equal(best.video.height, 2160, '最高档应为 4K');
  assert.equal(best.audio.id, 'bbb_a64k');

  // SegmentTemplate 用固定时长展开：分片地址应带 RepresentationID 与序号
  assert.ok(best.video.segments.length > 100, '分片数量应上百，实际 ' + best.video.segments.length);
  assert.ok(best.video.segments[0].url.includes('bbb_30fps_3840x2160_12000k'));
  assert.ok(best.video.segments[0].url.endsWith('.m4v'));
  assert.ok(best.video.initUrl.endsWith('_0.m4v'), '初始化段地址：' + best.video.initUrl);

  // 分片总时长应与 MPD 时长基本一致（每片 120/30 = 4 秒）
  const total = best.video.segments.reduce((sum, seg) => sum + seg.duration, 0);
  assert.ok(Math.abs(total - parsed.durationSeconds) < 10, '分片总时长 ' + total.toFixed(1) + 's 应接近 MPD 时长');
});

test('ISO 时长解析吃下真实 MPD 的写法', () => {
  assert.ok(Math.abs(parseIsoDuration('PT634.566S') - 634.566) < 0.001);
  assert.equal(parseIsoDuration('PT2.00S'), 2);
});
