/**
 * 下载历史的持久化（P6）
 *
 * 存在 chrome.storage.local（不是 sync：体积大、且没必要跨设备）。
 * 写入去抖，避免一个下载产生多次写；读取时统一裁剪过期记录。
 */

import { addEntry, patchByBrowserId, patchEntry, pruneHistory } from '../core/history.js';

export const HISTORY_STORAGE_KEY = 'downloadHistory';
const FLUSH_DELAY = 400;

let cache = null;
let loading = null;
let flushTimer = null;

async function readStored() {
  try {
    const stored = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
    return Array.isArray(stored && stored[HISTORY_STORAGE_KEY]) ? stored[HISTORY_STORAGE_KEY] : [];
  } catch (e) {
    return [];
  }
}

export async function loadHistory(force) {
  if (cache && !force) return cache;
  if (loading && !force) return loading;
  loading = (async () => {
    // 还有没落盘的变更时先落盘，否则重新读 storage 会把刚记下的条目丢掉
    if (flushTimer) await flushHistoryNow();
    const stored = await readStored();
    cache = pruneHistory(stored, { now: Date.now() });
    loading = null;
    return cache;
  })();
  return loading;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    try {
      await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: cache || [] });
    } catch (e) {}
  }, FLUSH_DELAY);
}

/** 记录一次下载发起 */
export async function recordDownload(entry) {
  const list = await loadHistory();
  cache = addEntry(list, entry);
  scheduleFlush();
  return cache;
}

/** 按任务 id 或浏览器下载 id 更新状态 */
export async function updateHistory(patchSelector, patch) {
  const list = await loadHistory();
  const selector = patchSelector || {};
  const next = Number.isFinite(Number(selector.browserDownloadId))
    ? patchByBrowserId(list, Number(selector.browserDownloadId), patch)
    : patchEntry(list, String(selector.id || ''), patch);

  // 没有匹配项时（例如用户在别处触发的下载）不做任何写入
  if (next === list) return cache;
  cache = next;
  scheduleFlush();
  return cache;
}

export async function clearHistory() {
  cache = [];
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  try {
    await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: [] });
  } catch (e) {}
  return cache;
}

/** 测试用 */
export function resetHistoryCache() {
  cache = null;
  loading = null;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
}

/** 测试用：立刻落盘 */
export async function flushHistoryNow() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  try {
    await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: cache || [] });
  } catch (e) {}
}
