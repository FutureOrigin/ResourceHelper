/**
 * 整页快照：后台抓取端的纯逻辑单测
 *
 * fetch 本身没法在 Node 里测（chrome API + 网络），但"哪些失败值得重试""规则长什么样"
 * "文本怎么解码"这三件事决定了防盗链重试会不会误伤、CSS 会不会变乱码，必须锁住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeTextBytes,
  isFetchable,
  isRefererRetryable,
  planRefererRules,
  uniqueHosts
} from '../../src/bg/archive-fetch.js';
import { charsetFromContentType, dataUrlFor, guessMimeFromUrl, stripContentTypeParams } from '../../src/core/base64.js';
import { base64ToBytes, bytesToBase64 } from '../../src/core/base64.js';

test('可抓判定只认 http(s)', () => {
  assert.equal(isFetchable('https://e.com/a.png'), true);
  assert.equal(isFetchable('http://e.com/a.png'), true);
  assert.equal(isFetchable('file:///c:/a.png'), false);
  assert.equal(isFetchable('data:image/png;base64,AA'), false);
  assert.equal(isFetchable(''), false);
});

test('防盗链重试：只对"可能被拦"的失败重试', () => {
  assert.equal(isRefererRetryable({ ok: false, status: 403 }), true);
  assert.equal(isRefererRetryable({ ok: false, status: 401 }), true);
  assert.equal(isRefererRetryable({ ok: false, status: 412 }), true);
  assert.equal(isRefererRetryable({ ok: false, status: 0 }), true, '网络层失败也值得再试');
  assert.equal(isRefererRetryable({ ok: false, status: 404 }), false, '404 换 Referer 也没用');
  assert.equal(isRefererRetryable({ ok: false, status: 500 }), false);
  assert.equal(isRefererRetryable({ ok: true, status: 200 }), false);
  assert.equal(isRefererRetryable(null), false);
});

test('host 去重：大小写归一、按字母序、忽略非法地址', () => {
  assert.deepEqual(
    uniqueHosts(['https://CDN.e.com/a.png', 'https://cdn.e.com/b.png', 'http://zzz.e.com/', 'not a url', 'data:x']),
    ['cdn.e.com', 'zzz.e.com']
  );
  assert.deepEqual(uniqueHosts([]), []);
});

test('Referer 规则：只作用于没有标签页归属的请求（即扩展自己发的）', () => {
  const rules = planRefererRules('https://e.com/page', ['cdn.e.com', 'img.e.com'], 900000);
  assert.equal(rules.length, 2);

  const [first, second] = rules;
  assert.equal(first.id, 900000);
  assert.equal(second.id, 900001);
  assert.equal(first.priority, 2);
  assert.equal(first.action.type, 'modifyHeaders');
  assert.deepEqual(first.action.requestHeaders, [
    { header: 'referer', operation: 'set', value: 'https://e.com/page' }
  ]);
  assert.equal(first.condition.urlFilter, '||cdn.e.com^');
  assert.deepEqual(first.condition.tabIds, [-1], '不能影响用户正在浏览的页面');
  assert.ok(first.condition.resourceTypes.includes('xmlhttprequest'));
  assert.ok(first.condition.resourceTypes.includes('font'));
});

test('Referer 规则：页面地址不是 http(s) 时一条都不生成', () => {
  assert.deepEqual(planRefererRules('chrome://settings', ['cdn.e.com']), []);
  assert.deepEqual(planRefererRules('', ['cdn.e.com']), []);
  assert.deepEqual(planRefererRules('https://e.com/', []), []);
});

test('文本解码：按 charset，未知 charset 退回 UTF-8', () => {
  const bytes = new TextEncoder().encode('中文 CSS');
  assert.equal(decodeTextBytes(bytes, 'utf-8'), '中文 CSS');
  assert.equal(decodeTextBytes(bytes, 'utf-8; charset=x'), '中文 CSS');
  assert.equal(decodeTextBytes(bytes, 'totally-unknown'), '中文 CSS');
  assert.equal(decodeTextBytes(new Uint8Array([65, 66]), ''), 'AB');
});

test('Content-Type 清洗：data: 前缀里只能放纯 mime', () => {
  assert.equal(stripContentTypeParams('text/css; charset=utf-8'), 'text/css');
  assert.equal(stripContentTypeParams('IMAGE/PNG'), 'image/png');
  assert.equal(stripContentTypeParams('text/html;charset=gbk'), 'text/html');
  assert.equal(stripContentTypeParams(''), '');
  assert.equal(stripContentTypeParams('garbage'), '');

  assert.equal(charsetFromContentType('text/css; charset=GBK'), 'gbk');
  assert.equal(charsetFromContentType('text/css'), '');
});

test('MIME 与 data URI 组装', () => {
  assert.equal(guessMimeFromUrl('https://e.com/a.WOFF2?x=1'), 'font/woff2');
  assert.equal(guessMimeFromUrl('https://e.com/a'), 'application/octet-stream');
  assert.equal(guessMimeFromUrl('https://e.com/a.weird', 'text/plain'), 'text/plain');

  assert.equal(dataUrlFor('image/png', 'AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(dataUrlFor('text/css; charset=utf-8', 'AAAA'), 'data:text/css;base64,AAAA');
  assert.equal(dataUrlFor('', 'AAAA'), 'data:application/octet-stream;base64,AAAA');
});

test('base64：大数组分块编码，且能用标准解码器逐字节还原', () => {
  // 100000 字节跨越分块边界；用 atob 解回来逐字节比对，等价于"随便找个浏览器打开都对"
  const bytes = new Uint8Array(100000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;

  const encoded = bytesToBase64(bytes);
  assert.ok(!/[\s]/.test(encoded), '不得有换行/空白');
  assert.equal(encoded.length % 4, 0);

  const decoded = base64ToBytes(encoded);
  assert.equal(decoded.length, bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    if (decoded[i] !== bytes[i]) assert.fail('第 ' + i + ' 字节不一致');
  }

  assert.equal(bytesToBase64(new Uint8Array([0])), 'AA==');
  assert.equal(bytesToBase64(new Uint8Array(0)), '');
  assert.equal(bytesToBase64(null), '');
});
