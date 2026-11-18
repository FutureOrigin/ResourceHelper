/**
 * 决策层单测
 *
 * 这些用例直接锁住 AUDIT 里的两个"静默产错"缺陷：
 *   B5 —— 找不到目标资源时不得退化成"取第一条"；
 *   A5 —— 没有独立音轨时不得把视频字节改名成 .mp3。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIO_EXTENSIONS,
  ERROR_CODES,
  buildDownloadPlan,
  buildFilename,
  detectStreamKind,
  extensionFromUrl,
  filenameForResource,
  pickTargetMedia,
  resolveTracks,
  sanitizeFilename
} from '../../src/core/decision.js';

function videoMedia(overrides) {
  return Object.assign({
    hash: 'res_abc',
    url: 'https://cdn.example.com/v/1080.mp4',
    title: '测试视频',
    type: 'video',
    extension: 'mp4',
    is_audio: false,
    has_drm: false,
    qualities: [{ index: 0, label: '1080P', videoUrl: 'https://cdn.example.com/v/1080.mp4', audioUrl: '' }]
  }, overrides || {});
}

function audioMedia(overrides) {
  return Object.assign({
    hash: 'res_music',
    url: 'https://m801.music.126.net/song.m4a?auth=1',
    title: '晴天 - 周杰伦',
    type: 'audio',
    extension: 'm4a',
    is_audio: true,
    has_drm: false,
    qualities: [{ index: 0, label: 'M4A 高保真音频', videoUrl: '', audioUrl: 'https://m801.music.126.net/song.m4a?auth=1' }]
  }, overrides || {});
}

/* ---------------------------------------------------------------- *
 * B5：目标选择必须精确命中
 * ---------------------------------------------------------------- */
test('pickTargetMedia 命中 hash', () => {
  const hit = pickTargetMedia([videoMedia()], { mediaHash: 'res_abc' });
  assert.equal(hit.ok, true);
  assert.equal(hit.media.hash, 'res_abc');
});

test('pickTargetMedia 命中画质项里的 URL', () => {
  const hit = pickTargetMedia([videoMedia()], { url: 'https://cdn.example.com/v/1080.mp4' });
  assert.equal(hit.ok, true);
});

test('pickTargetMedia 优先用一级身份键命中', () => {
  const a = videoMedia({ hash: 'r1', key: 'https://cdn.example.com/a.mp4' });
  const b = videoMedia({ hash: 'r2', key: 'https://cdn.example.com/b.mp4' });
  const hit = pickTargetMedia([a, b], { mediaKey: 'https://cdn.example.com/b.mp4' });
  assert.equal(hit.ok, true);
  assert.equal(hit.media.key, 'https://cdn.example.com/b.mp4');
});

test('pickTargetMedia 找不到时返回错误，绝不取第一条', () => {
  const miss = pickTargetMedia([videoMedia()], { mediaHash: 'res_missing' });
  assert.equal(miss.ok, false);
  assert.equal(miss.code, ERROR_CODES.RESOURCE_NOT_FOUND);
  assert.equal(miss.media, undefined);
  assert.match(miss.message, /失效/);
});

test('pickTargetMedia 空列表也返回错误', () => {
  const miss = pickTargetMedia([], { mediaHash: 'res_abc' });
  assert.equal(miss.ok, false);
  assert.equal(miss.code, ERROR_CODES.RESOURCE_NOT_FOUND);
});

/* ---------------------------------------------------------------- *
 * A5：音频提取不得把视频改名
 * ---------------------------------------------------------------- */
test('音频资源提取：走 direct，扩展名来自观测到的 URL', () => {
  const plan = buildDownloadPlan(audioMedia(), { audioOnly: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'direct');
  assert.equal(plan.extension, 'm4a');
  assert.match(plan.url, /\.m4a/);
});

test('mp3 音乐资源提取：保留 mp3 扩展名', () => {
  const media = audioMedia({
    url: 'https://m801.music.126.net/song.mp3?auth=1',
    extension: 'mp3',
    qualities: [{ index: 0, label: 'MP3', videoUrl: '', audioUrl: 'https://m801.music.126.net/song.mp3?auth=1' }]
  });
  const plan = buildDownloadPlan(media, { audioOnly: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.extension, 'mp3');
});

test('音画分离流提取音轨：直接下音轨，不重新编码', () => {
  const media = videoMedia({
    qualities: [{
      index: 0,
      label: '1080P',
      videoUrl: 'https://cdn.example.com/v/1080.m4s',
      audioUrl: 'https://cdn.example.com/a/192k.m4a'
    }]
  });
  const plan = buildDownloadPlan(media, { audioOnly: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'direct');
  assert.equal(plan.url, 'https://cdn.example.com/a/192k.m4a');
  assert.equal(plan.extension, 'm4a');
});

test('显式指定音轨时直接下载该音轨（音频页精确选择）', () => {
  const plan = buildDownloadPlan(videoMedia(), {
    audioOnly: true,
    audioUrl: 'https://cdn.example.com/a/30280.m4a'
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'direct');
  assert.equal(plan.url, 'https://cdn.example.com/a/30280.m4a');
  assert.equal(plan.extension, 'm4a');
});

test('只有视频轨时拒绝提取音频（AUDIT A5）', () => {
  const plan = buildDownloadPlan(videoMedia(), { audioOnly: true });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, ERROR_CODES.AUDIO_TRACK_UNAVAILABLE);
  assert.equal(plan.url, undefined);
  assert.equal(plan.extension, undefined);
});

/* ---------------------------------------------------------------- *
 * 视频下载路由
 * ---------------------------------------------------------------- */
test('音画分离 → mux', () => {
  const media = videoMedia({
    qualities: [{
      index: 0,
      label: '1080P',
      videoUrl: 'https://cdn.example.com/v/1080.mp4',
      audioUrl: 'https://cdn.example.com/a/128k.m4a'
    }]
  });
  const plan = buildDownloadPlan(media, {});
  assert.equal(plan.mode, 'mux');
  assert.equal(plan.videoUrl, 'https://cdn.example.com/v/1080.mp4');
  assert.equal(plan.audioUrl, 'https://cdn.example.com/a/128k.m4a');
});

test('音画齐备时一律走合流（整文件与 fMP4 都由 engine 的 remuxAuto 选路）', () => {
  const progressive = videoMedia({
    qualities: [{ index: 0, label: '1080P', container: 'mp4', videoUrl: 'https://x/v.mp4', audioUrl: 'https://x/a.m4a', audioContainer: 'mp4' }]
  });
  assert.equal(buildDownloadPlan(progressive, {}).mode, 'mux');

  const fragmented = videoMedia({
    qualities: [{
      index: 0,
      label: '1080P',
      container: 'fmp4-segment',
      videoUrl: 'https://x/v1080.m4s',
      audioUrl: 'https://x/a.m4s',
      audioContainer: 'fmp4-segment'
    }]
  });
  const plan = buildDownloadPlan(fragmented, {});
  assert.equal(plan.mode, 'mux', '分片流不再降级');
  assert.equal(plan.audioUrl, 'https://x/a.m4s');
});

test('容器未知时也允许合流（交给 remux 判定）', () => {
  const media = videoMedia({
    qualities: [{ index: 0, label: '1080P', container: '', videoUrl: 'https://x/v.mp4', audioUrl: 'https://x/a.m4a', audioContainer: '' }]
  });
  assert.equal(buildDownloadPlan(media, {}).mode, 'mux');
});

test('m3u8 → stream', () => {
  const media = videoMedia({
    url: 'https://cdn.example.com/hls/master.m3u8?token=1',
    type: 'm3u8_stream',
    extension: 'm3u8',
    qualities: [{ index: 0, label: 'HLS', videoUrl: 'https://cdn.example.com/hls/master.m3u8?token=1', audioUrl: '' }]
  });
  const plan = buildDownloadPlan(media, {});
  assert.equal(plan.mode, 'stream');
  assert.equal(plan.streamKind, 'hls');
});

test('mpd 走 DASH 模式，而不是把 XML 存成 mp4', () => {
  const media = videoMedia({
    url: 'https://cdn.example.com/dash/manifest.mpd',
    type: 'mpd_stream',
    extension: 'mpd',
    qualities: [{ index: 0, label: 'DASH', videoUrl: 'https://cdn.example.com/dash/manifest.mpd', audioUrl: '' }]
  });
  const plan = buildDownloadPlan(media, {});
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'dash');
  assert.equal(plan.url, 'https://cdn.example.com/dash/manifest.mpd');
});

test('普通 mp4 → direct', () => {
  const plan = buildDownloadPlan(videoMedia(), {});
  assert.equal(plan.mode, 'direct');
  assert.equal(plan.extension, 'mp4');
});

test('DRM 内容在决策层就被拒绝', () => {
  const plan = buildDownloadPlan(videoMedia({ has_drm: true }), {});
  assert.equal(plan.ok, false);
  assert.equal(plan.code, ERROR_CODES.DRM_PROTECTED);
});

/* ---------------------------------------------------------------- *
 * 文件名与工具函数
 * ---------------------------------------------------------------- */
test('sanitizeFilename 去掉非法字符与路径分隔符', () => {
  assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
});

test('sanitizeFilename 处理 Windows 保留名', () => {
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(sanitizeFilename('lpt9'), '_lpt9');
});

test('sanitizeFilename 按 UTF-8 字节截断且不切坏中文', () => {
  const out = sanitizeFilename('中'.repeat(100), 30);
  assert.ok(new TextEncoder().encode(out).length <= 30);
  assert.ok(out.length > 0);
  assert.ok(!out.includes('\uFFFD'));
});

test('下载计划会把模板应用到 plan.filename', () => {
  const media = videoMedia({
    url: 'https://cdn.example.com/v.mp4',
    title: '某视频',
    extension: 'mp4',
    qualities: [{ index: 0, label: '1080P', videoUrl: 'https://cdn.example.com/v.mp4', audioUrl: '' }]
  });
  const plan = buildDownloadPlan(media, { filenameTemplate: 'dl-{title}.{ext}' });
  assert.equal(plan.ok, true);
  assert.equal(plan.filename, 'dl-某视频.mp4');

  const withDate = buildDownloadPlan(media, { filenameTemplate: '{title}-{date}.{ext}', date: '20260101' });
  assert.equal(withDate.filename, '某视频-20260101.mp4');
});

test('buildFilename 支持设置里的文件名模板', () => {
  const media = videoMedia({ title: '某视频', url: 'https://cdn.example.com/v.mp4' });
  assert.equal(
    buildFilename(media, '1080P', 'mp4', { template: '{title} [{quality}].{ext}' }),
    '某视频 [1080P].mp4'
  );

  const noExt = buildFilename(media, '', 'mp4', { template: '{title}-{date}', date: '20260101' });
  assert.equal(noExt, '某视频-20260101.mp4', '模板没写 {ext} 时必须补上扩展名');

  const dirty = buildFilename(media, '', 'mp4', { template: '../{title}.{ext}' });
  assert.ok(!dirty.includes('/'), '模板同样要经过非法字符清洗');
});

test('buildFilename 追加画质后缀，但不重复追加', () => {
  const media = videoMedia({ title: '测试视频' });
  assert.equal(buildFilename(media, '1080P 高清', 'mp4'), '测试视频 [1080P 高清].mp4');
  const already = videoMedia({ title: '测试视频 [1080P 高清]' });
  assert.equal(buildFilename(already, '1080P 高清', 'mp4'), '测试视频 [1080P 高清].mp4');
});

test('filenameForResource 从 URL 取可读文件名', () => {
  assert.equal(
    filenameForResource('https://cdn.example.com/img/%E5%B0%81%E9%9D%A2.webp?x=1'),
    '封面.webp'
  );
  assert.equal(
    filenameForResource('https://cdn.example.com/a/b/photo', { extension: 'jpg' }),
    'photo.jpg'
  );
  assert.match(filenameForResource('https://cdn.example.com/', { prefix: 'image', timestamp: 12345678 }), /^image-12345678.bin$/);
  assert.equal(filenameForResource('not a url', { extension: 'png', prefix: 'x' }), 'x-' + String(Date.now()).slice(-8) + '.png');
});

test('extensionFromUrl 忽略 query 与 hash', () => {
  assert.equal(extensionFromUrl('https://x/y/a.m3u8?token=abc'), 'm3u8');
  assert.equal(extensionFromUrl('https://x/y/a'), '');
});

test('detectStreamKind 依据 URL 与资源类型判断', () => {
  assert.equal(detectStreamKind({ type: 'video' }, 'https://x/a.m3u8'), 'hls');
  assert.equal(detectStreamKind({ type: 'mpd_stream' }, 'https://x/a.bin'), 'dash');
  assert.equal(detectStreamKind({ type: 'video' }, 'https://x/a.mp4'), 'file');
});

test('resolveTracks：音轨地址与视频相同视为无独立音轨', () => {
  const tracks = resolveTracks({
    url: 'https://x/a.mp4',
    qualities: [{ videoUrl: 'https://x/a.mp4', audioUrl: 'https://x/a.mp4' }]
  }, 0);
  assert.equal(tracks.audioUrl, '');
});

test('AUDIO_EXTENSIONS 覆盖常见音频容器', () => {
  for (const ext of ['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wav']) {
    assert.ok(AUDIO_EXTENSIONS.includes(ext));
  }
});
