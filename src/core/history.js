/**
 * 下载历史（P6 第二步）
 *
 * 目的：让用户能回答"我刚才下的是什么、下到哪去了、失败的是哪一条"。
 * 纯函数：只处理数据形状与裁剪，不碰 chrome API。
 */

export const HISTORY_LIMIT = 300;

/** 允许的状态：initiated -> completed / failed */
export const HISTORY_STATES = Object.freeze({
  INITIATED: 'initiated',
  COMPLETED: 'completed',
  FAILED: 'failed'
});

function toTime(value) {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? Math.floor(time) : 0;
}

/**
 * 规整一条历史记录；字段不全或没有标题/地址的直接丢弃（返回 null）。
 * @param {Object} raw
 * @returns {Object|null}
 */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = typeof raw.url === 'string' ? raw.url : '';
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!url && !title) return null;

  const status = Object.values(HISTORY_STATES).includes(raw.status) ? raw.status : HISTORY_STATES.INITIATED;
  const size = Number(raw.size);

  return {
    id: String(raw.id || '') || ('h_' + toTime(raw.ts) + '_' + Math.random().toString(36).slice(2, 8)),
    title: title || url.split('/').pop() || '未命名资源',
    url: url,
    filename: typeof raw.filename === 'string' ? raw.filename : '',
    // 合流路径重下时还需要音轨地址
    audioUrl: typeof raw.audioUrl === 'string' ? raw.audioUrl : '',
    mode: typeof raw.mode === 'string' ? raw.mode : 'direct',
    site: typeof raw.site === 'string' ? raw.site : '',
    size: Number.isFinite(size) && size > 0 ? size : null,
    status: status,
    browserDownloadId: Number.isFinite(Number(raw.browserDownloadId)) ? Number(raw.browserDownloadId) : null,
    ts: toTime(raw.ts) || Date.now()
  };
}

/**
 * 插入一条记录：同一个 id 覆盖旧记录，最新的排最前，超出上限截断。
 */
export function addEntry(list, entry, limit) {
  const normalized = normalizeEntry(entry);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : HISTORY_LIMIT;
  const array = Array.isArray(list) ? list.slice() : [];
  if (!normalized) return array;

  const index = array.findIndex((item) => item && item.id === normalized.id);
  if (index >= 0) array.splice(index, 1);
  array.unshift(normalized);
  return array.slice(0, cap);
}

/** 更新状态/浏览器下载 id 等字段；找不到就原样返回 */
export function patchEntry(list, id, patch) {
  const array = Array.isArray(list) ? list : [];
  const index = array.findIndex((item) => item && item.id === id);
  if (index < 0) return array;   // 没变化时返回原引用，调用方据此跳过落盘
  const next = array.slice();
  next[index] = Object.assign({}, next[index], patch || {});
  return next;
}

/** 按浏览器下载 id 更新（下载完成后由 downloads.onChanged 驱动） */
export function patchByBrowserId(list, browserDownloadId, patch) {
  const array = Array.isArray(list) ? list : [];
  const target = Number(browserDownloadId);
  const index = array.findIndex((item) => item && item.browserDownloadId === target);
  if (index < 0) return array;
  const next = array.slice();
  next[index] = Object.assign({}, next[index], patch || {});
  return next;
}

/**
 * 裁剪：去掉超期的，并按上限截断。默认保留 30 天。
 */
export function pruneHistory(list, options) {
  const opts = options || {};
  const cap = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : HISTORY_LIMIT;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxAgeMs = (Number.isFinite(opts.maxAgeDays) ? opts.maxAgeDays : 30) * 24 * 60 * 60 * 1000;
  const array = Array.isArray(list) ? list : [];

  return array
    .filter((item) => item && now - toTime(item.ts) <= maxAgeMs)
    .slice(0, cap);
}

/** 统计：给设置页/历史页头部用 */
export function summarize(list) {
  const array = Array.isArray(list) ? list.filter(Boolean) : [];
  const stats = { total: array.length, completed: 0, failed: 0, initiated: 0, bytes: 0 };
  for (const item of array) {
    if (item.status === HISTORY_STATES.COMPLETED) stats.completed += 1;
    else if (item.status === HISTORY_STATES.FAILED) stats.failed += 1;
    else stats.initiated += 1;
    if (Number.isFinite(item.size) && item.size > 0) stats.bytes += item.size;
  }
  return stats;
}

/** 相对时间文案（侧边栏与历史页共用） */
export function formatRelativeTime(ts, now) {
  const time = toTime(ts);
  if (!time) return '';
  const diff = Math.max(0, (Number.isFinite(now) ? now : Date.now()) - time);
  const minute = 60 * 1000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return Math.floor(diff / minute) + ' 分钟前';
  if (diff < 24 * 60 * minute) return Math.floor(diff / (60 * minute)) + ' 小时前';
  return Math.floor(diff / (24 * 60 * minute)) + ' 天前';
}
