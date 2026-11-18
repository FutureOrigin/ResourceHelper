/**
 * 请求分类（AUDIT E2）
 *
 * 旧实现是"1 条正则 + 18 次 String.includes"，两个问题：
 *   1) 误伤：notkugou.com / kugou.com.evil.cn 这类域名也会命中；
 *   2) 浪费：每个请求都要跑 18 次子串查找，而绝大多数请求和媒体无关。
 *
 * 现在按 host 精确匹配后缀（一次 URL 解析 + 短路循环），并且只匹配已知媒体 CDN。
 */

export const STREAM_EXTS = /\.(m3u8|mpd|mp4|webm|flv|f4v|ts|m4s|mp3|m4a|aac|flac|ogg|wav|opus)(\?.*)?$/i;

export const STREAM_HOST_SUFFIXES = Object.freeze([
  'googlevideo.com', 'youtube.com',
  'bilivideo.com', 'bilivideo.cn', 'mcdn.bilivideo.cn',
  'tc.qq.com', 'video.qq.com', 'v.qq.com', 'vod.myqcloud.com',
  'bytevcloud.com', 'douyinvod.com', 'video.twimg.com',
  'music.126.net', 'music.163.com',
  'qqmusic.qq.com', 'stream.qqmusic.qq.com',
  'kugou.com', 'kuwo.cn'
]);

export const STREAM_MIMES = Object.freeze([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/dash+xml',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'audio/wav'
]);

export function hostOfUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

/** 域名必须整体等于后缀，或是其后缀的子域；避免 evil-kugou.com 被当成 kugou.com */
export function isKnownMediaHost(host) {
  if (!host) return false;
  const target = String(host).toLowerCase();
  for (const suffix of STREAM_HOST_SUFFIXES) {
    if (target === suffix || target.endsWith('.' + suffix)) return true;
  }
  return false;
}

/** 单个请求的快速分类：后缀优先（零解析），再退回 host */
export function isCandidateUrl(url, host) {
  if (!url || typeof url !== 'string') return false;
  if (STREAM_EXTS.test(url)) return true;
  return isKnownMediaHost(host == null ? hostOfUrl(url) : host);
}

export function isMediaMime(contentType) {
  if (!contentType) return false;
  const lowered = String(contentType).toLowerCase();
  return STREAM_MIMES.some((mime) => lowered.includes(mime));
}

/** YouTube 的分块播放地址：同为 googlevideo 域，靠 videoplayback 路径区分 */
export function isYouTubeUrl(url, host) {
  if (!url || typeof url !== 'string' || !url.includes('videoplayback')) return false;
  const target = host == null ? hostOfUrl(url) : host;
  if (!target) return false;
  return target === 'googlevideo.com' || target.endsWith('.googlevideo.com') || target.endsWith('.youtube.com');
}
