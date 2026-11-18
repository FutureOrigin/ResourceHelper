/**
 * 资源图持久化（AUDIT C1）
 *
 * MV3 的 service worker 空闲约 30 秒就会被回收，而资源图此前只活在内存里：
 * 用户切个标签页、或者只是点了别处，再回来面板就是空的——"必须先打开面板、
 * 再触发一次播放、再点下载"的脆弱链路就是这么来的。
 *
 * 这里用 chrome.storage.session（10MB，内存态、不落盘、不产生隐私痕迹）保存快照，
 * 并在 SW 启动时恢复。存储后端是可注入的，便于单测。
 */

import { ResourceGraph } from '../core/graph.js';

export const STORAGE_KEY = 'rh.graphs.v1';
export const SNAPSHOT_VERSION = 1;

export class GraphStore {
  constructor(options) {
    const opts = options || {};
    this.Graph = opts.Graph || ResourceGraph;
    this.storage = opts.storage || (typeof chrome !== 'undefined' ? chrome.storage.session : null);
    this.debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : 200;
    this.maxTabs = Number.isFinite(opts.maxTabs) ? opts.maxTabs : 12;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.graphs = new Map();
    this.lastUsed = new Map();
    this.timer = null;
    this.inflight = null;
    this.ready = this.restore();
  }

  graphFor(tabId) {
    let graph = this.graphs.get(tabId);
    if (!graph) {
      graph = new this.Graph({ now: this.now });
      this.graphs.set(tabId, graph);
    }
    this.lastUsed.set(tabId, this.now());
    return graph;
  }

  nodesFor(tabId) {
    const graph = this.graphs.get(tabId);
    if (!graph) return [];
    this.lastUsed.set(tabId, this.now());
    return graph.list();
  }

  touch(tabId) {
    this.lastUsed.set(tabId, this.now());
  }

  drop(tabId) {
    const had = this.graphs.delete(tabId);
    this.lastUsed.delete(tabId);
    if (had) this.scheduleFlush();
    return had;
  }

  /** 合并短时间内的多次变更，避免每条观测都写一次 storage */
  scheduleFlush() {
    if (!this.storage) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, this.debounceMs);
  }

  buildPayload() {
    const tabIds = Array.from(this.graphs.keys());
    tabIds.sort((a, b) => (this.lastUsed.get(b) || 0) - (this.lastUsed.get(a) || 0));
    const kept = tabIds.slice(0, this.maxTabs);
    return {
      version: SNAPSHOT_VERSION,
      savedAt: this.now(),
      tabs: kept.map((tabId) => ({
        tabId: tabId,
        lastUsed: this.lastUsed.get(tabId) || 0,
        snapshot: this.graphs.get(tabId).snapshot()
      }))
    };
  }

  async flush() {
    if (!this.storage) return false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const payload = this.buildPayload();
    this.inflight = this.storage.set({ [STORAGE_KEY]: payload });
    try {
      await this.inflight;
      return true;
    } finally {
      this.inflight = null;
    }
  }

  async restore() {
    if (!this.storage || typeof this.storage.get !== 'function') return false;
    let stored;
    try {
      const got = await this.storage.get(STORAGE_KEY);
      stored = got ? got[STORAGE_KEY] : null;
    } catch (e) {
      return false;
    }
    if (!stored || !Array.isArray(stored.tabs)) return false;
    for (const entry of stored.tabs) {
      if (!entry || entry.tabId == null) continue;
      const graph = this.Graph.load(entry.snapshot, { now: this.now });
      graph.expire();                       // 恢复时顺手清理超期节点
      if (graph.size() === 0) continue;
      this.graphs.set(entry.tabId, graph);
      this.lastUsed.set(entry.tabId, entry.lastUsed || this.now());
    }
    return true;
  }

  async clear() {
    this.graphs.clear();
    this.lastUsed.clear();
    if (this.storage) await this.storage.remove(STORAGE_KEY).catch(() => {});
  }
}
