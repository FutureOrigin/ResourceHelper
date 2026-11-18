/**
 * 二进制与文本的边界（整页快照用）
 *
 * data URI 是"单文件网页"的底座：图片、字体、样式表全部要变成 data: 串。
 * 这里只放两件容易写错、又值得单测的事：
 *   1. 大数组转 base64 —— 直接 String.fromCharCode(...bytes) 会爆栈（超过约 64K 参数），
 *      必须分块；
 *   2. Content-Type 的清洗 —— 带 charset 的 `text/css; charset=utf-8` 不能原样塞进
 *      data: 前缀（分号会截断 mediatype），必须先剥参数。
 *
 * 零依赖、纯函数、不碰 chrome API。
 */

/** 每次喂给 String.fromCharCode 的字节数：65536 太大，32K 是安全又快的折中 */
const CHUNK_SIZE = 0x8000;

/**
 * Uint8Array -> 标准 base64（无换行、无 data: 前缀）。
 * @param {Uint8Array|ArrayBuffer|ArrayLike<number>} input
 * @returns {string}
 */
export function bytesToBase64(input) {
  if (input == null) return '';
  let bytes;
  if (input instanceof Uint8Array) {
    bytes = input;
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else if (ArrayBuffer.isView(input)) {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else if (typeof input.length === 'number') {
    bytes = Uint8Array.from(input);
  } else {
    return '';
  }

  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const slice = bytes.subarray(offset, offset + CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

/**
 * base64 -> Uint8Array。
 *
 * 产品代码里用不到它，但编码器必须有一个独立的解码器来证明自己不是"看起来像 base64"：
 * 单测拿 10 万字节做往返比对（见 test/unit/archive-fetch.test.mjs）。
 *
 * @param {string} text
 * @returns {Uint8Array}
 */
export function base64ToBytes(text) {
  const raw = atob(String(text || ''));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** `text/css; charset=utf-8` -> `text/css`（data: 前缀里只能放纯 mime） */export function stripContentTypeParams(value) {
  const raw = String(value == null ? '' : value);
  const head = raw.split(';')[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(head) ? head : '';
}

/** 从 Content-Type 里取字符集（没有就返回空串） */
export function charsetFromContentType(value) {
  const match = /charset\s*=\s*"?([a-z0-9_.:-]+)"?/i.exec(String(value == null ? '' : value));
  return match ? match[1].toLowerCase() : '';
}

const MIME_BY_EXTENSION = {
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  cur: 'image/x-icon',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  xml: 'application/xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav'
};

/** 从 URL 路径后缀猜 MIME；猜不到用 fallback（默认 application/octet-stream） */
export function guessMimeFromUrl(url, fallback) {
  const target = String(fallback || 'application/octet-stream');
  let pathname = '';
  try {
    pathname = new URL(String(url || ''), 'https://placeholder.invalid/').pathname;
  } catch (e) {
    pathname = String(url || '').split(/[?#]/)[0];
  }
  const match = /\.([a-z0-9]{1,8})$/i.exec(pathname);
  if (!match) return target;
  return MIME_BY_EXTENSION[match[1].toLowerCase()] || target;
}

/** 组装 data URI；mime 缺省时按二进制处理（不要瞎猜成 text/plain） */
export function dataUrlFor(mime, base64) {
  const type = stripContentTypeParams(mime) || 'application/octet-stream';
  return 'data:' + type + ';base64,' + String(base64 == null ? '' : base64);
}

