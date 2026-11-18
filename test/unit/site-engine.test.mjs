import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  evaluateExpression,
  extractWithAdapter,
  matchesAdapter,
  parsePath,
  selectAdapter,
  splitAlternatives
} from '../../src/core/site-engine.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const bilibili = JSON.parse(readFileSync(path.join(ROOT, 'src/sites/bilibili.json'), 'utf8'));
const youtube = JSON.parse(readFileSync(path.join(ROOT, 'src/sites/youtube.json'), 'utf8'));

const BILI_PAGE = {
  code: 0,
  data: {
    bvid: 'BV1RqWe6EE6Q',
    is_drm: 0,
    videoData: { title: '某测试视频' },
    dash: {
      duration: 300,
      video: [
        { id: 80, baseUrl: 'https://upos.example/v80.m4s', bandwidth: 2400000, width: 1920, height: 1080, codecs: 'avc1.640032' },
        { id: 64, backupUrl: ['https://backup.example/v64.m4s'], bandwidth: 1200000, width: 1280, height: 720, codecs: 'avc1.64001f' },
        { id: 32, baseUrl: 'https://upos.example/v32.m4s', bandwidth: 600000, width: 854, height: 480, codecs: 'avc1.4d401f' }
      ],
      audio: [{ id: 30280, baseUrl: 'https://upos.example/a192.m4s', bandwidth: 192000 }]
    }
  }
};

const YT_PAGE = {
  videoDetails: { videoId: 'abc123XYZ', title: 'YT 测试视频' },
  streamingData: {
    adaptiveFormats: [
      { itag: 137, url: 'https://rr1.googlevideo.com/videoplayback?itag=137', mimeType: 'video/mp4; codecs="avc1.640028"', width: 1920, height: 1080, bitrate: 2400000 },
      { itag: 140, url: 'https://rr1.googlevideo.com/videoplayback?itag=140', mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 },
      { itag: 251, url: 'https://rr1.googlevideo.com/videoplayback?itag=251', mimeType: 'audio/webm; codecs="opus"', bitrate: 160000 }
    ]
  }
};

test('splitAlternatives 只切顶层 ||', () => {
  assert.deepEqual(splitAlternatives("$.a || $.b || 'x||y'"), ['$.a', '$.b', "'x||y'"]);
});

test('parsePath 支持属性、下标、通配与 $doc', () => {
  assert.deepEqual(parsePath('$.data.dash.video[*]'), [
    { type: 'key', value: 'data' }, { type: 'key', value: 'dash' },
    { type: 'key', value: 'video' }, { type: 'wild' }
  ]);
  assert.deepEqual(parsePath('$.a[1]'), [{ type: 'key', value: 'a' }, { type: 'index', value: 1 }]);
  assert.equal(parsePath('$doc.title')[0].type, 'doc');
});

test('evaluateExpression：路径、兜底、比较、包含、$doc', () => {
  const ctx = { data: { a: { b: 42 }, flag: 1, mime: 'video/mp4', list: [{ v: 1 }, { v: 2 }] }, doc: { title: '页面标题' } };
  assert.equal(evaluateExpression('$.a.b', ctx), 42);
  assert.equal(evaluateExpression('$.missing || $.a.b', ctx), 42);
  assert.equal(evaluateExpression("$.missing || '兜底'", ctx), '兜底');
  assert.equal(evaluateExpression('$.flag == 1', ctx), true);
  assert.equal(evaluateExpression("$.mime contains 'video'", ctx), true);
  assert.equal(evaluateExpression('$doc.title', ctx), '页面标题');
  assert.deepEqual(evaluateExpression('$.list[*].v', ctx), [1, 2]);
  assert.equal(evaluateExpression('$.missing', ctx), null);
});

test('matchesAdapter 支持通配域名与路径', () => {
  assert.equal(matchesAdapter(bilibili, 'https://www.bilibili.com/video/BV1xx'), true);
  assert.equal(matchesAdapter(bilibili, 'https://www.bilibili.com/read/123'), false);
  assert.equal(matchesAdapter(youtube, 'https://www.youtube.com/watch?v=abc'), true);
  assert.equal(matchesAdapter(youtube, 'https://www.youtube.com/feed/subscriptions'), false);
});

test('B 站适配器：分辨率标签、备用地址、音轨都正确', () => {
  const result = extractWithAdapter(bilibili, { data: BILI_PAGE, doc: { title: '某测试视频_哔哩哔哩' }, url: 'https://www.bilibili.com/video/BV1RqWe6EE6Q' });
  assert.equal(result.matched, true);
  assert.equal(result.id, 'BV1RqWe6EE6Q');
  assert.equal(result.title, '某测试视频');

  const videos = result.variants.filter((item) => item.kind === 'video');
  const audios = result.variants.filter((item) => item.kind === 'audio');
  assert.equal(videos.length, 3);
  assert.equal(audios.length, 1);
  assert.equal(videos[0].label, '1080P 高清');
  assert.equal(videos[0].height, 1080);
  assert.equal(videos[0].videoOnly, true);
  assert.equal(videos[1].url, 'https://backup.example/v64.m4s', '没有 baseUrl 时用 backupUrl[0]');
  assert.equal(audios[0].label, '192K 高保真');
  assert.equal(audios[0].bitrate, 192000);
});

test('YouTube 适配器：同一个 adaptiveFormats 数组按 mimeType 分流', () => {
  const result = extractWithAdapter(youtube, { data: YT_PAGE, doc: { title: 'YT 测试视频 - YouTube' }, url: 'https://www.youtube.com/watch?v=abc123XYZ' });
  const videos = result.variants.filter((item) => item.kind === 'video');
  const audios = result.variants.filter((item) => item.kind === 'audio');
  assert.equal(videos.length, 1);
  assert.equal(audios.length, 2);
  assert.equal(videos[0].label, '1080P 高清视频轨');
  assert.equal(videos[0].id, '137');
  assert.deepEqual(audios.map((a) => a.id), ['140', '251']);
});

test('container 表达式会被求值（不能把 "$.ext" 原样当扩展名）', () => {
  const adapter = {
    id: 't', match: ['*'], title: ['$doc.title'],
    media: {
      audio: { each: '$media[*]', url: '$.src', container: '$.ext' }
    }
  };
  const result = extractWithAdapter(adapter, {
    data: {},
    media: [{ src: 'https://x/a.m4a', ext: 'M4A' }],
    doc: { title: 't', url: 'https://x/' },
    url: 'https://x/'
  });
  assert.equal(result.variants.length, 1);
  assert.equal(result.variants[0].container, 'm4a');
});

test('URL 不匹配时不产出任何变体', () => {
  const result = extractWithAdapter(bilibili, { data: BILI_PAGE, doc: {}, url: 'https://example.com/x' });
  assert.equal(result.matched, false);
  assert.deepEqual(result.variants, []);
});

test('sites/ 下每个适配器都在后台注册表里', () => {
  const dir = path.join(ROOT, 'src/sites');
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 2, '至少要有 B 站与 YouTube 两个适配器');
  const registry = readFileSync(path.join(ROOT, 'src/bg/adapters.js'), 'utf8');
  for (const file of files) {
    assert.ok(registry.includes('sites/' + file), file + ' 未在 bg/adapters.js 的 ADAPTER_FILES 中注册');
  }
});

test('selectAdapter 从列表里挑匹配项', () => {
  assert.equal(selectAdapter([youtube, bilibili], 'https://www.bilibili.com/video/BV1').id, 'bilibili-video');
  assert.equal(selectAdapter([youtube, bilibili], 'https://example.com/x'), null);
});
