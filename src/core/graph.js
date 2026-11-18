/**
 * 资源图（I2 逻辑唯一 / I3 依赖闭合）
 *
 * 现状问题（AUDIT B2）：每条网络流都是一张卡。YouTube 一条视频的 6 个 itag
 * 会变成 6 张同名卡片；B 站每个分辨率一张、音频又是另一张。用户看到的"资源"
 * 和浏览器里真实存在的"资源"不是一一对应的。
 *
 * 这里把"逻辑媒体"和"具体变体"分开：
 *   node   = 一条逻辑媒体（groupKey 决定），带 title / scope / completeness
 *   variant = 一个可下载的具体流（itag、分辨率、音轨…），挂在该 node 下
 *
 * 纯数据、无 chrome API、可单测。UI 兼容层是 toMedia()。
 */

import { shortId } from './identity.js';
import { pairVariants } from './pair.js';

const MUXED_EXTENSIONS = new Set(['mp4', 'webm', 'mkv', 'mov', 'flv', 'f4v', 'avi', 'wmv', 'ogv']);
const PROVENANCE_RANK = { 'page-json': 3, dom: 2, webRequest: 1 };

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

function isLikelyMuxed(extension) {
  return MUXED_EXTENSIONS.has(String(extension || '').toLowerCase());
}

/** 单个变体是否能独立播放（缺音轨/缺 init 的都不算） */
export function isVariantPlayable(variant) {
  if (!variant) return false;
  if (variant.drm) return false;
  if (variant.isAudio) return Boolean(variant.url);
  const videoUrl = variant.videoUrl || variant.url || '';
  if (!videoUrl) return false;
  if (variant.audioUrl && variant.audioUrl !== videoUrl) return true;
  if (variant.pairedAudioId) return true;            // 配对引擎已经在节点内找到了音轨
  if (variant.videoOnly) return false;
  return isLikelyMuxed(variant.extension);
}

function computeCompleteness(node) {
  const variants = node.variants || [];
  if (variants.some((v) => v.drm)) return 'drm';
  if (variants.some(isVariantPlayable)) return 'complete';
  if (variants.some((v) => v.url || v.videoUrl)) return 'video-only';
  return 'unknown';
}

function makeNode(groupKey, observation, now) {
  return {
    key: groupKey,
    id: shortId(groupKey),          // 只用于 DOM dataset 与消息体，短且稳定
    groupKey: groupKey,
    kind: observation.kind || 'media',
    title: observation.title || '',
    titleRank: PROVENANCE_RANK[observation.provenance] || 0,
    site: observation.site || hostOf(observation.variant && observation.variant.url),
    scope: observation.scope || { tabId: null, frameId: 0, documentId: '', generation: 0 },
    provenance: observation.provenance ? [observation.provenance] : ['webRequest'],
    duration: observation.duration == null ? null : observation.duration,
    variants: [],
    completeness: 'unknown',
    firstSeenAt: now,
    lastSeenAt: now
  };
}

function mergeVariant(existing, incoming) {
  let changed = false;
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'id') continue;              // id 是变体身份，不能被后来的观测改写
    if (value == null || value === '') continue;
    if (existing[key] === value) continue;
    // 音频地址一旦确认就不回退成空；其余字段以最新观测为准
    existing[key] = value;
    changed = true;
  }
  return changed;
}

export class ResourceGraph {
  constructor(options) {
    const opts = options || {};
    this.nodes = new Map();
    this.ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : 30 * 60 * 1000;
    // 上限保护：x.com 这类无限滚动页面会持续产出新图片，没有上限最终会拖垮侧边栏
    this.maxNodes = Number.isFinite(opts.maxNodes) && opts.maxNodes > 0 ? opts.maxNodes : 800;
    this.evicted = 0;
    // URL -> groupKey：同一个流只能属于一个逻辑媒体，否则同一支视频会出现两张卡
    this.urlIndex = new Map();
    this.clock = typeof opts.now === 'function' ? opts.now : () => Date.now();
  }

  /**
   * 超过上限时按"最久没被看到"淘汰。
   * 优先淘汰没有可播放变体的（大多是噪声），同等情况再看 lastSeenAt。
   */
  evictIfNeeded() {
    if (this.nodes.size <= this.maxNodes) return [];
    const list = Array.from(this.nodes.values()).sort((a, b) => {
      const playableA = (a.variants || []).some(isVariantPlayable) ? 1 : 0;
      const playableB = (b.variants || []).some(isVariantPlayable) ? 1 : 0;
      if (playableA !== playableB) return playableA - playableB;   // 不可播放的先淘汰
      return a.lastSeenAt - b.lastSeenAt;                          // 再按最久未见
    });
    const removed = [];
    const overflow = this.nodes.size - this.maxNodes;
    for (let i = 0; i < overflow && i < list.length; i += 1) {
      this.forgetUrls(list[i]);
      this.nodes.delete(list[i].key);
      removed.push(list[i].key);
    }
    this.evicted += removed.length;
    return removed;
  }

  /**
   * 写入一次观测。
   * observation: { key, groupKey?, kind?, title?, site?, scope?, provenance?, duration?, variant{} }
   * 返回 { node, created, changed }，changed 为 false 时调用方可以跳过广播。
   */
  upsert(observation) {
    if (!observation || !observation.key) return { node: null, created: false, changed: false };
    const now = this.clock();
    const groupKey = observation.groupKey || observation.key;
    let node = this.nodes.get(groupKey);
    let created = false;
    let changed = false;

    if (!node) {
      node = makeNode(groupKey, observation, now);
      this.nodes.set(groupKey, node);
      created = true;
      changed = true;
    }

    node.lastSeenAt = now;

    // 标题：可信来源优先；同等来源下取更长的（通常是完整标题而不是文件名/域名）
    if (observation.title) {
      const rank = PROVENANCE_RANK[observation.provenance] || 0;
      const better = !node.title
        || rank > (node.titleRank || 0)
        || (rank === (node.titleRank || 0) && observation.title.length > node.title.length);
      if (better) {
        node.title = observation.title;
        node.titleRank = rank;
        changed = true;
      }
    }
    if (observation.site && !node.site) {
      node.site = observation.site;
      changed = true;
    }
    if (observation.duration != null && node.duration == null) {
      node.duration = observation.duration;
      changed = true;
    }
    if (observation.provenance && !node.provenance.includes(observation.provenance)) {
      const incomingRank = PROVENANCE_RANK[observation.provenance] || 0;
      const bestKnown = node.provenance.reduce((best, p) => Math.max(best, PROVENANCE_RANK[p] || 0), 0);
      node.provenance.push(observation.provenance);
      if (incomingRank > bestKnown && node.provenance.length > 1) {
        node.provenance.sort((a, b) => (PROVENANCE_RANK[b] || 0) - (PROVENANCE_RANK[a] || 0));
      }
      changed = true;
    }
    if (observation.scope) {
      // 作用域以最新一次为准（同一 groupKey 只可能来自同一文档）
      node.scope = Object.assign({}, node.scope, observation.scope);
    }

    const variant = observation.variant;
    if (variant && (variant.id || variant.url)) {
      const variantId = variant.id || variant.url;
      const variantUrl = variant.url || variant.videoUrl || '';
      // 先按 id 找，再按 URL 找：同一个流被不同来源（网络抓包 / 页面数据 / 适配器）
      // 以不同 id 发现时，必须合并成一条，否则画质下拉里会出现重复项
      let existing = node.variants.find((v) => v.id === variantId)
        || (variantUrl ? node.variants.find((v) => (v.url || v.videoUrl) === variantUrl) : null);

      // 该地址已经登记在别的节点下（页面数据 / DOM 采集 / 抓包都可能重复发现同一个流）：
      // 不在这里重复登记，避免同一个流同时出现在两张卡里（I2 逻辑唯一）
      const owner = variantUrl ? this.urlIndex.get(variantUrl) : null;
      const ownedByOther = Boolean(owner) && owner !== groupKey && !existing;

      if (!existing && !ownedByOther) {
        existing = { id: variantId, firstSeenAt: now };
        mergeVariant(existing, variant);
        existing.lastSeenAt = now;
        node.variants.push(existing);
        if (variantUrl) this.urlIndex.set(variantUrl, groupKey);
        changed = true;
      } else if (existing) {
        if (mergeVariant(existing, variant)) changed = true;
        existing.lastSeenAt = now;
      }
      // 变体数变化会改变"封面"选择，一并视为变化
      node.variants.sort((a, b) => variantRank(b) - variantRank(a));
    }

    // 配对：给每条视频变体找一个音轨变体（I3）。
    // 每次 upsert 都重算，因为音轨可能晚于视频到达。
    const pairs = pairVariants(node.variants).pairs;
    for (const item of node.variants) {
      const audio = pairs.get(item.id) || null;
      const nextId = audio ? audio.id : null;
      if (item.pairedAudioId !== nextId) {
        item.pairedAudioId = nextId;
        changed = true;
      }
    }

    const nextCompleteness = computeCompleteness(node);
    if (node.completeness !== nextCompleteness) {
      node.completeness = nextCompleteness;
      changed = true;
    }

    // 新建的节点如果一条变体都没落下来（全是别的节点已经拥有的 URL），就地撤销
    if (created && node.variants.length === 0) {
      this.nodes.delete(groupKey);
      return { node: null, created: false, changed: false };
    }

    // 新增节点可能把总数顶过上限，这里立刻淘汰，避免图无限增长
    if (created) this.evictIfNeeded();

    const current = this.nodes.get(groupKey);
    return { node: current || node, created, changed };
  }

  get(groupKey) {
    return this.nodes.get(groupKey) || null;
  }

  list(filter) {
    const f = filter || {};
    const out = [];
    for (const node of this.nodes.values()) {
      const scope = node.scope || {};
      if (f.generation != null && scope.generation !== f.generation) continue;
      // 默认只看主框架（iframe 广告/挂件不应污染列表）；显式 includeFrames 才放开
      if (f.includeFrames !== true) {
        if (scope.frameId !== 0) continue;
      } else if (f.frameId != null && scope.frameId !== f.frameId) {
        continue;
      }
      if (f.kind && node.kind !== f.kind) continue;
      out.push(node);
    }
    out.sort((a, b) => b.firstSeenAt - a.firstSeenAt);
    return out;
  }

  remove(groupKey) {
    const node = this.nodes.get(groupKey);
    if (node) this.forgetUrls(node);
    return this.nodes.delete(groupKey);
  }

  /** 节点消失时把它的地址从索引里摘掉，避免索引越积越大 */
  forgetUrls(node) {
    for (const variant of node.variants || []) {
      const url = variant.url || variant.videoUrl || '';
      if (url && this.urlIndex.get(url) === node.key) this.urlIndex.delete(url);
    }
  }

  /** 清理超期节点，返回被移除的 key 列表 */
  expire(now) {
    const at = now == null ? this.clock() : now;
    const removed = [];
    for (const [key, node] of this.nodes) {
      if (at - node.lastSeenAt > this.ttlMs) {
        this.forgetUrls(node);
        this.nodes.delete(key);
        removed.push(key);
      }
    }
    return removed;
  }

  /** 清理某次导航之前的节点（保留 generation 相同的） */
  clearStale(generation) {
    const removed = [];
    for (const [key, node] of this.nodes) {
      const nodeGeneration = node.scope ? node.scope.generation : 0;
      if (nodeGeneration !== generation) {
        this.forgetUrls(node);
        this.nodes.delete(key);
        removed.push(key);
      }
    }
    return removed;
  }

  size() {
    return this.nodes.size;
  }

  snapshot() {
    return { version: 1, savedAt: this.clock(), nodes: Array.from(this.nodes.values()) };
  }

  static load(snapshot, options) {
    const graph = new ResourceGraph(options);
    const nodes = snapshot && Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
    for (const node of nodes) {
      if (!node || !node.key) continue;
      graph.nodes.set(node.key, node);
      for (const variant of node.variants || []) {
        const url = variant.url || variant.videoUrl || '';
        if (url) graph.urlIndex.set(url, node.key);
      }
    }
    return graph;
  }
}

function pairedAudioContainer(variant, byId) {
  if (!variant || !variant.pairedAudioId) return '';
  const audio = byId.get(variant.pairedAudioId);
  return (audio && audio.container) || '';
}

function resolvePairedUrl(variant, byId) {
  if (!variant || !variant.pairedAudioId) return '';
  const audio = byId.get(variant.pairedAudioId);
  if (!audio) return '';
  return audio.url || audio.audioUrl || '';
}

/** 变体排序：能独立播放的优先，其次分辨率高的，再次码率高的 */
export function variantRank(variant) {
  if (!variant) return 0;
  const playable = isVariantPlayable(variant) ? 100000000 : 0;
  const height = Number(variant.height) || 0;
  const bitrate = Number(variant.bitrate) || 0;
  return playable + height * 1000 + bitrate / 1000;
}

/**
 * 兼容层：把 node 投影成 UI 现有的 media 契约。
 * 等 P4 的声明式 UI 落地后，这里可以删掉，UI 直接消费 node。
 */
export function toMedia(node) {
  if (!node) return null;
  const variants = (node.variants || []).slice();
  const byId = new Map(variants.map((v) => [v.id, v]));
  const audioList = variants.filter((v) => v.isAudio);
  const variantList = variants.filter((v) => !v.isAudio);
  const primary = variantList.find(isVariantPlayable) || variantList[0] || audioList[0] || {};
  return {
    key: node.key,
    hash: node.id,
    title: node.title,
    site: node.site,
    type: primary.type || 'video',
    extension: primary.extension || 'mp4',
    is_audio: Boolean(primary.isAudio),
    has_drm: node.completeness === 'drm',
    duration: node.duration,
    size: primary.sizeBytes == null ? null : primary.sizeBytes,
    mime: primary.mime || '',
    filename: primary.filename || '',
    url: primary.url,
    headers: primary.headers || null,
    completeness: node.completeness,
    provenance: node.provenance,
    scope: node.scope,
    // 视频变体进 qualities；音轨单独放 audio_qualities。
    // 注意：音轨与视频的"配对"要到 P2/P3 才启用（合流器修复前绑定只会产出坏文件），
    // 现在音轨只作为"可单独下载的音频流"暴露。
    qualities: variantList.map((variant, index) => ({
      index,
      label: variant.label || variant.extension || '原画',
      width: variant.width == null ? null : variant.width,
      height: variant.height == null ? null : variant.height,
      bitrate: variant.bitrate == null ? null : variant.bitrate,
      demuxer: variant.extension || 'mp4',
      container: variant.container || '',
      sizeBytes: variant.sizeBytes == null ? null : variant.sizeBytes,
      videoUrl: variant.videoUrl || variant.url || '',
      audioUrl: variant.audioUrl || resolvePairedUrl(variant, byId),
      audioContainer: pairedAudioContainer(variant, byId)
    })),
    audio_qualities: audioList.map((variant, index) => ({
      index,
      label: variant.label || variant.extension || '音频',
      demuxer: variant.extension || 'm4a',
      audioUrl: variant.url || ''
    }))
  };
}
