/**
 * 资源探测（I5：保真）
 *
 * 一次 Range 请求换六个字段：状态码、真实大小、Content-Type、Content-Disposition、
 * ETag、首 1KB 魔数（AUDIT §4.1）。比"先 HEAD 再 GET"省一半请求。
 *
 * 关键安全点：有些服务器忽略 Range 直接返回 200 + 整个文件。所以必须流式读前 N 字节
 * 后立刻 cancel，绝不把整部影片读进内存。
 */

import { sniffBytes, sniffExtension } from './sniff.js';

export const DEFAULT_PROBE_LIMIT = 1024;

/** 'bytes 0-1023/12345678' -> 12345678；'bytes 0-1023/*' -> null */
export function parseContentRange(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(/bytes\s+\d+-\d+\/(\d+)/i);
  if (!match) return null;
  const total = Number.parseInt(match[1], 10);
  return Number.isFinite(total) ? total : null;
}

/** 从 Content-Disposition 里取文件名（支持 filename* 的 UTF-8 形式） */
export function parseDisposition(value) {
  if (!value || typeof value !== 'string') return null;
  const star = value.match(/filename\*\s*=\s*([^;]+)/i);
  if (star) {
    const raw = star[1].trim().replace(/^["']|["']$/g, '');
    const parts = raw.split("''");
    const encoded = parts.length > 1 ? parts[1] : raw;
    try {
      return decodeURIComponent(encoded);
    } catch (e) {
      return encoded;
    }
  }
  const plain = value.match(/filename\s*=\s*("([^"]*)"|([^;]+))/i);
  if (!plain) return null;
  const name = (plain[2] || plain[3] || '').trim();
  return name || null;
}

async function readPrefix(response, limit) {
  if (!response || !response.body || typeof response.body.getReader !== 'function') {
    if (response && typeof response.arrayBuffer === 'function') {
      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer).slice(0, limit);
    }
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (received < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      chunks.push(chunk);
      received += chunk.length;
      if (received >= limit) break;
    }
  } finally {
    // 服务器忽略 Range 时必须主动断开，否则等于偷偷下整部文件
    try { await reader.cancel(); } catch (e) {}
  }
  const out = new Uint8Array(Math.min(received, limit));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.length) break;
    const take = Math.min(chunk.length, out.length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

/**
 * @param {string} url
 * @param {{fetchImpl?: Function, limit?: number, headers?: Object}} options
 * @returns {Promise<Object>} 探测结果；失败时返回 { ok:false, error }
 */
export async function probeResource(url, options) {
  const opts = options || {};
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return { ok: false, error: 'NO_FETCH' };
  if (!url || typeof url !== 'string') return { ok: false, error: 'BAD_URL' };

  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_PROBE_LIMIT;
  const headers = Object.assign({ Range: 'bytes=0-' + (limit - 1) }, opts.headers || {});

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: headers,
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow'
    });
  } catch (e) {
    return { ok: false, error: 'NETWORK', detail: String(e && e.message) };
  }

  if (!response || !response.ok) {
    return { ok: false, error: 'HTTP_' + (response ? response.status : '?') };
  }

  const headerGet = (name) => {
    try { return response.headers && response.headers.get ? response.headers.get(name) : null; } catch (e) { return null; }
  };

  let bytes = new Uint8Array(0);
  try {
    bytes = await readPrefix(response, limit);
  } catch (e) {
    // 读不到字节不致命：至少还能拿到响应头
  }

  const contentRange = headerGet('content-range');
  const contentLength = Number.parseInt(headerGet('content-length') || '', 10);
  const partial = response.status === 206 || Boolean(contentRange);
  const totalBytes = parseContentRange(contentRange)
    || (Number.isFinite(contentLength) ? contentLength : null);

  const sniffed = sniffBytes(bytes);

  return {
    ok: true,
    status: response.status,
    partial: partial,
    totalBytes: totalBytes,
    mime: (headerGet('content-type') || '').split(';')[0].trim().toLowerCase(),
    filename: parseDisposition(headerGet('content-disposition')),
    etag: headerGet('etag') || '',
    sniff: sniffed,
    extension: sniffExtension(sniffed),
    bytesRead: bytes.length
  };
}
