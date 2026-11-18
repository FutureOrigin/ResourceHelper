import test from 'node:test';
import assert from 'node:assert/strict';

import { probeResource, parseContentRange, parseDisposition } from '../../src/core/probe.js';

function bytesOf(fill) {
  return new Uint8Array(fill);
}

function fakeResponse(body, init) {
  const options = init || {};
  return {
    ok: options.ok !== false,
    status: options.status || 200,
    headers: new Headers(options.headers || {}),
    body: options.body === false ? null : new Response(body).body,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  };
}

test('parseContentRange 解析总大小', () => {
  assert.equal(parseContentRange('bytes 0-1023/12345678'), 12345678);
  assert.equal(parseContentRange('bytes 0-1023/*'), null);
  assert.equal(parseContentRange(''), null);
  assert.equal(parseContentRange(null), null);
});

test('parseDisposition 支持普通与 RFC5987 文件名', () => {
  assert.equal(parseDisposition('attachment; filename="movie.mp4"'), 'movie.mp4');
  assert.equal(parseDisposition('inline; filename=plain.mp4'), 'plain.mp4');
  assert.equal(parseDisposition("attachment; filename*=UTF-8''%E7%94%B5%E5%BD%B1.mp4"), '电影.mp4');
  assert.equal(parseDisposition(null), null);
});

test('探测 206 时用 Content-Range 拿真实总大小', async () => {
  const result = await probeResource('https://x/v', {
    fetchImpl: async () => fakeResponse(bytesOf([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), {
      status: 206,
      headers: {
        'content-range': 'bytes 0-11/12345678',
        'content-type': 'video/mp4',
        etag: 'W/"abc"'
      }
    })
  });
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.equal(result.totalBytes, 12345678);
  assert.equal(result.mime, 'video/mp4');
  assert.equal(result.etag, 'W/"abc"');
  assert.equal(result.sniff.kind, 'video');
  assert.equal(result.sniff.container, 'mp4');
  assert.equal(result.extension, 'mp4');
});

test('服务器忽略 Range 返回 200 时按 Content-Length 记大小，但只读前 N 字节', async () => {
  const big = new Uint8Array(5000);
  big.set([0xff, 0xd8, 0xff], 0);
  let cancelled = false;
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': '5000', 'content-type': 'image/jpeg' }),
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: big };
          },
          async cancel() { cancelled = true; }
        };
      }
    }
  };
  const result = await probeResource('https://x/a.jpg', { fetchImpl: async () => response, limit: 64 });
  assert.equal(result.totalBytes, 5000);
  assert.equal(result.bytesRead, 64, '只保留 limit 字节');
  assert.equal(result.sniff.container, 'jpg');
  assert.equal(cancelled, true, '必须主动 cancel，避免偷偷下完整个文件');
});

test('Content-Disposition 文件名覆盖猜测（含 RFC5987 编码）', async () => {
  // 注意：HTTP 头是 latin1，中文文件名只能走 filename*=UTF-8'' 形式
  const result = await probeResource('https://x/download.mp4', {
    fetchImpl: async () => fakeResponse(bytesOf([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]), {
      headers: {
        'content-disposition': "attachment; filename*=UTF-8''%E7%94%B5%E5%BD%B1.mp4",
        'content-type': 'video/mp4'
      }
    })
  });
  assert.equal(result.filename, '电影.mp4');
});

test('HTTP 错误与网络错误都有明确错误码', async () => {
  const notFound = await probeResource('https://x/missing', {
    fetchImpl: async () => fakeResponse(bytesOf([1, 2, 3, 4]), { status: 404, ok: false })
  });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.error, 'HTTP_404');

  const boom = await probeResource('https://x/boom', {
    fetchImpl: async () => { throw new Error('dns'); }
  });
  assert.equal(boom.ok, false);
  assert.equal(boom.error, 'NETWORK');
});

test('非法 URL 直接拒绝，不发请求', async () => {
  let called = false;
  const result = await probeResource('', { fetchImpl: async () => { called = true; } });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'BAD_URL');
  assert.equal(called, false);
});
