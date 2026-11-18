/**
 * 资源身份（I1：身份唯一）
 *
 * 背景（AUDIT B1）：旧实现用 32 位累加哈希当 Map 键，实测 9.1 万个真实 URL
 * 就会出现碰撞，后到的资源静默覆盖先到的——用户既看不到那条资源，也无法再下载。
 *
 * 三级设计：
 *   一级身份 resourceKey = 规范化后的完整 URL 字符串本身（不存在碰撞）
 *   二级身份 contentPrint = mime|大小|etag|首片哈希，用于把"同一内容的不同 URL"合并
 *   显示短 ID shortId    = FNV-1a 64，只用于 DOM dataset 与消息体，不参与去重判断
 */

/**
 * 与"内容身份"无关、只随请求变化的参数。
 * 注意：token / sign / vkey / guid 这类**不**在列表里——它们往往决定服务端返回哪一段内容，
 * 去掉会把不同资源误并成一条。真正需要跨会话合并时交给 contentPrint。
 */
const VOLATILE_PARAMS = new Set([
  'range', 'rn', 'rbuf',            // YouTube / googlevideo 的分块与回滚计数
  '_t', 'ts', 'cb', 'cachebust',    // 缓存击穿参数
  'clen', 'dur', 'mime'             // 由探测重新得到的元信息
]);

/** 规范化 URL：去 hash、去默认端口、host 小写、剔除易变参数、其余参数排序 */
export function normalizeUrl(rawUrl, base) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let url;
  try {
    url = new URL(rawUrl, base || undefined);
  } catch (e) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }

  const kept = [];
  for (const pair of url.searchParams) {
    if (!VOLATILE_PARAMS.has(pair[0].toLowerCase())) kept.push(pair);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  url.search = '';
  for (const pair of kept) url.searchParams.append(pair[0], pair[1]);
  return url.href;
}

/** 一级身份。拿不到可解析 URL 时退回原始字符串（保证总有一个稳定键） */
export function resourceKey(rawUrl, base) {
  const normalized = normalizeUrl(rawUrl, base);
  if (normalized) return normalized;
  return typeof rawUrl === 'string' ? rawUrl.trim() : '';
}

/** 显示用短 ID：FNV-1a 64，确定性、无需 async */
export function shortId(text) {
  const str = String(text == null ? '' : text);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return 'r' + hash.toString(16).padStart(16, '0');
}

/** 二级身份：同一内容的不同 URL 会得到同一个指纹 */
/**
 * 注意：当前**没有**任何调用方。按内容合并需要在探测阶段拿到稳定哈希，
 * 仅用 size+mime 判别会把不同视频误并成一条（比重复更糟），因此有意保留未接入。
 * 详见 README「已知限制」第 2 条。
 */
export function contentPrint(hints) {
  const h = hints || {};
  return [
    h.mime || '?',
    h.totalBytes == null ? '?' : String(h.totalBytes),
    h.etag || '',
    h.firstChunkHash || ''
  ].join('|');
}

/**
 * 给一条媒体补齐全身份字段。内容脚本没有模块系统，无法自己算 key，
 * 所以后台在收口处统一兜底（AUDIT B1）。
 */
export function ensureMediaIdentity(media) {
  if (!media) return null;
  if (!media.key) media.key = resourceKey(media.url);
  if (!media.hash) media.hash = shortId(media.key);
  return media;
}

/** 站点已经给了稳定 ID 时（YouTube videoId、B 站 bvid），直接用站点身份，别去猜 URL */
export function siteKey(site, ...parts) {
  return String(site || 'site') + ':' + parts
    .map((p) => String(p == null ? '' : p))
    .filter((p) => p.length > 0)
    .join(':');
}
