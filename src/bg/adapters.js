/**
 * 站点适配器加载（P4）
 *
 * 适配器是 sites/*.json，后台按需 fetch 一次并缓存。
 * 之所以不在编译期 import：将来要做"远程规则 + 本地覆盖"，运行时加载是同一条路。
 */

const ADAPTER_FILES = ['sites/bilibili.json', 'sites/youtube.json', 'sites/generic-dom.json'];

let cached = null;
let loading = null;

export async function loadAdapters() {
  if (cached) return cached;
  if (loading) return loading;

  loading = Promise.all(ADAPTER_FILES.map(async (relative) => {
    try {
      const response = await fetch(chrome.runtime.getURL(relative));
      if (!response.ok) return null;
      return await response.json();
    } catch (e) {
      return null;
    }
  })).then((list) => {
    cached = list.filter(Boolean);
    loading = null;
    return cached;
  });

  return loading;
}

/** 测试用：重置缓存 */
export function resetAdapterCache() {
  cached = null;
  loading = null;
}
