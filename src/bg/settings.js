/**
 * 设置的读写（后台侧）
 *
 * 存在 chrome.storage.sync（跨设备），读的时候一律过 normalizeSettings，
 * 保证"别人手改 storage 也不会把扩展弄坏"。
 */

import { DEFAULT_SETTINGS, diffSettings, normalizeSettings } from '../core/settings.js';

const STORAGE_KEY = 'settings';

let cache = null;
let loading = null;

export async function loadSettings(force) {
  if (cache && !force) return cache;
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const stored = await chrome.storage.sync.get(STORAGE_KEY);
      cache = normalizeSettings(stored && stored[STORAGE_KEY]);
    } catch (e) {
      cache = Object.assign({}, DEFAULT_SETTINGS);
    }
    loading = null;
    return cache;
  })();
  return loading;
}

export async function saveSettings(patch) {
  const next = normalizeSettings(Object.assign({}, await loadSettings(), patch));
  cache = next;
  try {
    // 只存与默认值不同的项
    await chrome.storage.sync.set({ [STORAGE_KEY]: diffSettings(next) });
  } catch (e) {}
  return next;
}

/** 设置变化时回调（多个扩展实例之间也会同步） */
export function watchSettings(callback) {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes[STORAGE_KEY]) return;
      cache = normalizeSettings(changes[STORAGE_KEY].newValue);
      callback(cache);
    });
  } catch (e) {}
}

/** 测试用 */
export function resetSettingsCache() {
  cache = null;
  loading = null;
}

export { DEFAULT_SETTINGS };
