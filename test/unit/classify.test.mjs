import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STREAM_EXTS,
  hostOfUrl,
  isCandidateUrl,
  isKnownMediaHost,
  isMediaMime,
  isYouTubeUrl
} from '../../src/core/classify.js';

test('后缀命中即可（含 query）', () => {
  assert.equal(isCandidateUrl('https://x.com/a.m3u8?token=1'), true);
  assert.equal(isCandidateUrl('https://x.com/a.mp4'), true);
});

test('已知媒体 CDN 的任意路径都算候选', () => {
  assert.equal(isCandidateUrl('https://rr1.googlevideo.com/videoplayback?id=1', 'rr1.googlevideo.com'), true);
  assert.equal(isCandidateUrl('https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/25/1.m4s', 'upos-sz-mirrorcos.bilivideo.com'), true);
  assert.equal(isCandidateUrl('https://ws.stream.qqmusic.qq.com/x', 'ws.stream.qqmusic.qq.com'), true);
});

test('AUDIT E2 的误伤：旧实现会把 evil 域名当成媒体 CDN', () => {
  // 旧的 String.includes('kugou.com') 会命中这些地址
  assert.equal('https://notkugou.com/a'.includes('kugou.com'), true);
  assert.equal('https://kugou.com.evil.cn/a'.includes('kugou.com'), true);
  // 新的 host 精确后缀匹配不会
  assert.equal(isKnownMediaHost('notkugou.com'), false);
  assert.equal(isKnownMediaHost('kugou.com.evil.cn'), false);
  assert.equal(isKnownMediaHost('kugou.com'), true);
  assert.equal(isKnownMediaHost('www.kugou.com'), true);
});

test('普通静态资源不算候选', () => {
  assert.equal(isCandidateUrl('https://cdn.example.com/app.js', 'cdn.example.com'), false);
  assert.equal(isCandidateUrl('https://cdn.example.com/style.css?v=2', 'cdn.example.com'), false);
});

test('MIME 判定覆盖 HLS/DASH 与音视频容器', () => {
  assert.equal(isMediaMime('application/vnd.apple.mpegurl'), true);
  assert.equal(isMediaMime('application/dash+xml'), true);
  assert.equal(isMediaMime('video/mp4; charset=utf-8'), true);
  assert.equal(isMediaMime('text/html'), false);
  assert.equal(isMediaMime(''), false);
});

test('YouTube 播放地址判定依赖 videoplayback 路径', () => {
  assert.equal(isYouTubeUrl('https://rr1.googlevideo.com/videoplayback?itag=18', 'rr1.googlevideo.com'), true);
  assert.equal(isYouTubeUrl('https://rr1.googlevideo.com/other', 'rr1.googlevideo.com'), false);
  assert.equal(isYouTubeUrl('https://evil.cn/videoplayback', 'evil.cn'), false);
});

test('hostOfUrl 容错', () => {
  assert.equal(hostOfUrl('not a url'), '');
  assert.equal(hostOfUrl('https://A.B.com/x'), 'a.b.com');
});

test('STREAM_EXTS 不把 .ts 之外的普通后缀误判', () => {
  assert.equal(STREAM_EXTS.test('https://x/a.js'), false);
  assert.equal(STREAM_EXTS.test('https://x/a.ts'), true);
});
