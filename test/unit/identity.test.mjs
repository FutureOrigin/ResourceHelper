import test from 'node:test';
import assert from 'node:assert/strict';

import { contentPrint, ensureMediaIdentity, normalizeUrl, resourceKey, shortId, siteKey } from '../../src/core/identity.js';

test('normalizeUrl 去掉 hash 与默认端口，并小写 host', () => {
  assert.equal(normalizeUrl('https://CDN.Example.com:443/a/b.mp4#t=10'), 'https://cdn.example.com/a/b.mp4');
  assert.equal(normalizeUrl('http://x.com:80/a'), 'http://x.com/a');
});

test('normalizeUrl 对查询参数排序，顺序不同视为同一资源', () => {
  const a = normalizeUrl('https://x.com/v.mp4?b=2&a=1');
  const b = normalizeUrl('https://x.com/v.mp4?a=1&b=2');
  assert.equal(a, b);
});

test('normalizeUrl 剔除易变参数（range/rn/clen/mime 等）', () => {
  const url = normalizeUrl('https://rr1.googlevideo.com/videoplayback?itag=137&range=0-1048575&rn=3&clen=123&mime=video%2Fmp4&expire=99');
  assert.ok(url.includes('itag=137'));
  assert.ok(url.includes('expire=99'));
  assert.ok(!url.includes('range='));
  assert.ok(!url.includes('rn='));
  assert.ok(!url.includes('clen='));
  assert.ok(!url.includes('mime='));
});

test('normalizeUrl 保留 token/sign 这类决定内容的参数', () => {
  const url = normalizeUrl('https://x.com/a.mp4?token=abc&sign=def');
  assert.ok(url.includes('token=abc'));
  assert.ok(url.includes('sign=def'));
});

test('normalizeUrl 拒绝非 http(s)', () => {
  assert.equal(normalizeUrl('blob:https://x.com/123'), null);
  assert.equal(normalizeUrl('data:image/png;base64,AAAA'), null);
  assert.equal(normalizeUrl(''), null);
});

test('resourceKey 对无效 URL 退回原始字符串', () => {
  assert.equal(resourceKey('not a url at all'), 'not a url at all');
  assert.equal(resourceKey(null), '');
});

test('resourceKey 支持相对地址（配合 base）', () => {
  assert.equal(
    resourceKey('/media/a.mp4', 'https://x.com/watch/1'),
    'https://x.com/media/a.mp4'
  );
});

test('shortId 是确定性 17 位短 id，且不同 URL 不同', () => {
  const a = shortId('https://x.com/a.mp4');
  const b = shortId('https://x.com/b.mp4');
  assert.equal(a, shortId('https://x.com/a.mp4'));
  assert.match(a, /^r[0-9a-f]{16}$/);
  assert.notEqual(a, b);
});

test('AUDIT B1 的碰撞对在新身份下不再撞车', () => {
  const a = 'https://cdn0.example.com/media/klt.mp4?token=338023';
  const b = 'https://cdn4.example.com/media/1yis.mp4?token=107';
  assert.notEqual(resourceKey(a), resourceKey(b));
  assert.notEqual(shortId(resourceKey(a)), shortId(resourceKey(b)));
});

test('同一资源的不同 range 分块得到同一个 key', () => {
  const first = 'https://rr1.googlevideo.com/videoplayback?itag=137&range=0-1048575&id=abc';
  const second = 'https://rr1.googlevideo.com/videoplayback?itag=137&range=1048576-2097151&id=abc';
  assert.equal(resourceKey(first), resourceKey(second));
});

test('contentPrint 把同一内容的不同镜像合并', () => {
  const mirrorA = { mime: 'video/mp4', totalBytes: 1024, etag: 'W/"a"', firstChunkHash: 'ff00' };
  const mirrorB = { mime: 'video/mp4', totalBytes: 1024, etag: 'W/"a"', firstChunkHash: 'ff00' };
  assert.equal(contentPrint(mirrorA), contentPrint(mirrorB));
  assert.notEqual(contentPrint(mirrorA), contentPrint({ ...mirrorA, totalBytes: 2048 }));
});

test('ensureMediaIdentity 给内容脚本产出的媒体补齐 key/hash', () => {
  const media = ensureMediaIdentity({ url: 'https://x.com/a.mp4?token=1', title: 'A' });
  assert.equal(media.key, 'https://x.com/a.mp4?token=1');
  assert.match(media.hash, /^r[0-9a-f]{16}$/);
  assert.equal(media.key, resourceKey('https://x.com/a.mp4?token=1'));
});

test('ensureMediaIdentity 不会覆盖已有身份，且容忍空值', () => {
  const kept = ensureMediaIdentity({ key: 'bilibili:BV1', hash: 'rdeadbeefdeadbeef', url: 'https://x/y' });
  assert.equal(kept.key, 'bilibili:BV1');
  assert.equal(kept.hash, 'rdeadbeefdeadbeef');
  assert.equal(ensureMediaIdentity(null), null);
});

test('siteKey 用站点自带的稳定 ID 而不是 URL', () => {
  assert.equal(siteKey('youtube', 'dQw4w9WgXcQ', 137), 'youtube:dQw4w9WgXcQ:137');
  assert.equal(siteKey('bilibili', 'BV1xx'), 'bilibili:BV1xx');
});
