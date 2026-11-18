/**
 * ResourceHelper - Background Service Worker
 * 100% Native, Open-Source Stream Sniffer & Download Dispatcher
 * Includes full support for YouTube, Bilibili, and modern streaming architectures
 */

import { pickTargetMedia, buildDownloadPlan } from '../core/decision.js';
import { ensureMediaIdentity, resourceKey, shortId, siteKey } from '../core/identity.js';
import { toMedia } from '../core/graph.js';
import { GraphStore } from '../bg/persist.js';
import { NavigationTracker, attributeMedia } from '../bg/attribution.js';
import { ProbeQueue } from '../bg/enricher.js';
import { loadAdapters } from '../bg/adapters.js';
import { probeResource } from '../core/probe.js';
import { sniffBytes } from '../core/sniff.js';
import { loadSettings, saveSettings } from '../bg/settings.js';
import { clearHistory, loadHistory, recordDownload, updateHistory } from '../bg/history.js';
import { closeOffscreenIfIdle, ensureOffscreen, isSupported as offscreenSupported } from '../bg/offscreen.js';
import { MESSAGE as OFFSCREEN_MESSAGE, normalizeBuildRequest, normalizeProgress } from '../core/offscreen-protocol.js';
import { extractWithAdapter, selectAdapters } from '../core/site-engine.js';
import { variantsToObservations } from '../core/page-observation.js';
import { mediaToObservation } from '../core/observation.js';
import { fetchArchiveResources, listTabFrames } from '../bg/archive-fetch.js';
import {
  STREAM_MIMES,
  hostOfUrl,
  isCandidateUrl,
  isMediaMime,
  isYouTubeUrl
} from '../core/classify.js';

// 图是唯一事实来源；store 负责 chrome.storage.session 快照与 SW 重启恢复（AUDIT C1）
const store = new GraphStore({ storage: chrome.storage && chrome.storage.session });
const nav = new NavigationTracker();
const activeDownloads = new Map();  // downloadId -> { tabId, dlId, mediaHash }

function generationOf(tabId) {
  return nav.generationOf(tabId);
}

function bumpGeneration(tabId, documentId) {
  // 换页后旧的钩子提示不再成立（MSE 编码、blob 播放都可能换掉）
  hookHints.delete(tabId);
  return nav.bump(tabId, documentId);
}

/** 只发给侧边栏/悬浮层，不打扰页面脚本 */
function broadcast(payload) {
  try {
    chrome.runtime.sendMessage(payload).catch(() => {});
  } catch (e) {}
}

/** tabId -> P5 钩子观察到的提示（MSE 编码、blob 播放、只在 JS 里出现的地址） */
const hookHints = new Map();

/** browserDownloadId -> { jobId, blobUrl }：offscreen 建好、还没释放的 blob URL */
const pendingOffscreenBlobs = new Map();

async function releaseOffscreenBlob(browserDownloadId) {
  const pending = pendingOffscreenBlobs.get(browserDownloadId);
  if (!pending) return;
  pendingOffscreenBlobs.delete(browserDownloadId);
  try {
    await chrome.runtime.sendMessage({ type: OFFSCREEN_MESSAGE.RELEASE, jobId: pending.jobId });
  } catch (e) {}
  // 没有别的任务时才关文档
  if (pendingOffscreenBlobs.size === 0) closeOffscreenIfIdle().catch(() => {});
}

function siteKeyForDownload(media) {
  try {
    const url = (media && (media.url || (media.qualities && media.qualities[0] && media.qualities[0].videoUrl))) || '';
    return url ? new URL(url).hostname : '';
  } catch (e) {
    return '';
  }
}

function summarizeHistory(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const stats = { total: list.length, completed: 0, failed: 0, initiated: 0, bytes: 0 };
  for (const item of list) {
    if (!item) continue;
    if (item.status === 'completed') stats.completed += 1;
    else if (item.status === 'failed') stats.failed += 1;
    else stats.initiated += 1;
    if (Number.isFinite(item.size) && item.size > 0) stats.bytes += item.size;
  }
  return stats;
}

function mediaListFor(tabId) {
  return nav.filterByGeneration(store.nodesFor(tabId), tabId)
    .map(toMedia)
    .filter(Boolean);
}

function broadcastMedia(tabId, node) {
  if (!node) return;
  const payload = { type: 'RH_MEDIA_UPSERTED', tab_id: tabId, media: toMedia(node) };
  try {
    chrome.tabs.sendMessage(tabId, payload).catch(() => {});
  } catch (e) {}
  try {
    chrome.runtime.sendMessage(payload).catch(() => {});
  } catch (e) {}
  updateBadge(tabId);
}

/**
 * 探测结果回填：把真实大小 / 容器 / MIME / 文件名合并进对应变体（AUDIT I5）。
 * 只补字段，不改身份，所以 upsert 会走"字段增量合并"而不是新增节点。
 */
function applyProbeResult(meta, result) {
  if (!meta || !result || !result.ok) return;
  const graph = store.graphFor(meta.tabId);
  const observation = {
    key: meta.key,
    groupKey: meta.key,
    scope: meta.scope,
    variant: {
      id: meta.variantId,
      extension: result.extension || undefined,
      sizeBytes: result.totalBytes == null ? undefined : result.totalBytes,
      mime: result.mime || undefined,
      container: result.sniff ? result.sniff.container : undefined,
      filename: result.filename || undefined
    }
  };
  const { node, changed } = graph.upsert(observation);
  if (!changed) return;
  store.scheduleFlush();
  broadcastMedia(meta.tabId, node);
}

// 探测队列：限并发、按 URL 去重、失败不重试（AUDIT E3）
const enricher = new ProbeQueue({
  probe: (url) => probeResource(url),
  concurrency: 3,
  maxEntries: 300,
  onResult: applyProbeResult
});

/** 只有"还缺信息"的资源才值得花一次请求 */
function maybeProbe(tabId, observation, node) {
  const variant = observation && observation.variant;
  if (!variant || !variant.url || !node) return;
  if (variant.sizeBytes != null) return;
  if (variant.extension === 'm3u8' || variant.extension === 'mpd') return;
  if (String(variant.type || '').includes('stream')) return;
  enricher.request(variant.url, {
    tabId: tabId,
    key: observation.key,
    variantId: variant.id,
    scope: observation.scope
  });
}

/**
 * tabId -> { title, url }：抓包路径要的是"同步拿到标题"（AUDIT E9）。
 *
 * webRequest 回调里不能 await chrome.tabs.get()——回调结束后 SW 可能被判空闲而终止，
 * 尾部逻辑会丢。所以标题由 tabs.onUpdated 维护在这里，冷启动时用 tabs.get 异步补一次。
 */
const tabMeta = new Map();

function titleOf(tabId) {
  const meta = tabId ? tabMeta.get(tabId) : null;
  return (meta && meta.title) || '';
}

function rememberTab(tabId, patch) {
  if (!tabId || tabId < 0) return;
  const previous = tabMeta.get(tabId) || {};
  tabMeta.set(tabId, Object.assign({}, previous, patch));
}

function ensureTabMeta(tabId) {
  if (!tabId || tabId < 0 || tabMeta.has(tabId)) return;
  try {
    chrome.tabs.get(tabId).then((tab) => {
      if (tab) rememberTab(tabId, { title: tab.title || '', url: tab.url || '' });
    }).catch(() => {});
  } catch (e) {}
}

/** YouTube 的分块播放地址 -> 可下载的媒体描述（同步，标题取 tabMeta 缓存） */
function parseYouTubePlayback(rawUrl, tabId) {
  try {
    const urlObj = new URL(rawUrl);
    const itag = urlObj.searchParams.get('itag') || '';
    const mime = urlObj.searchParams.get('mime') || '';
    const clen = urlObj.searchParams.get('clen');
    const dur = urlObj.searchParams.get('dur');
    const mediaId = urlObj.searchParams.get('id') || '';

    // CRITICAL: Strip buffer chunk range so the URL downloads the entire stream
    urlObj.searchParams.delete('range');
    const fullStreamUrl = urlObj.href;

    const ITAG_MAP = {
      '18': { label: '360P (音视频合流)', ext: 'mp4', isAudio: false, height: 360 },
      '22': { label: '720P 原画 (音视频合流)', ext: 'mp4', isAudio: false, height: 720 },
      '137': { label: '1080P 高清视频轨', ext: 'mp4', isAudio: false, height: 1080 },
      '248': { label: '1080P WebM视频轨', ext: 'webm', isAudio: false, height: 1080 },
      '136': { label: '720P 视频轨', ext: 'mp4', isAudio: false, height: 720 },
      '247': { label: '720P WebM视频轨', ext: 'webm', isAudio: false, height: 720 },
      '135': { label: '480P 视频轨', ext: 'mp4', isAudio: false, height: 480 },
      '140': { label: '128K AAC 高保真音频', ext: 'm4a', isAudio: true, height: null },
      '251': { label: '160K Opus 极高质量音频', ext: 'webm', isAudio: true, height: null },
      '250': { label: '70K Opus 音频', ext: 'webm', isAudio: true, height: null },
      '249': { label: '50K Opus 音频', ext: 'webm', isAudio: true, height: null }
    };

    const itagInfo = ITAG_MAP[itag] || {
      label: mime.startsWith('audio/') ? 'YouTube 音频' : (mime.includes('webm') ? 'WebM 流' : 'MP4 流'),
      ext: mime.startsWith('audio/') ? 'm4a' : 'mp4',
      isAudio: mime.startsWith('audio/'),
      height: null
    };

    let title = 'YouTube 视频';
    const tabTitle = titleOf(tabId);
    if (tabTitle) {
      title = tabTitle.replace(/\s*[-_—|]\s*YouTube.*$/i, '').trim() || title;
    }

    const key = siteKey('youtube', mediaId || resourceKey(fullStreamUrl), itag || '0');

    return {
      key,
      hash: shortId(key),
      url: fullStreamUrl,
      title: `${title} [${itagInfo.label}]`,
      type: itagInfo.isAudio ? 'audio' : 'video',
      extension: itagInfo.ext,
      is_audio: itagInfo.isAudio,
      duration: dur ? parseFloat(dur) : null,
      size: clen ? parseInt(clen, 10) : null,
      has_drm: false,
      qualities: [
        {
          index: 0,
          label: itagInfo.label,
          width: null,
          height: itagInfo.height,
          bitrate: null,
          demuxer: itagInfo.ext,
          videoUrl: itagInfo.isAudio ? '' : fullStreamUrl,
          audioUrl: itagInfo.isAudio ? fullStreamUrl : ''
        }
      ]
    };
  } catch (err) {
    console.warn('[Background] parseYouTubePlayback error:', err);
    return null;
  }
}

/** 普通地址 -> 媒体描述：后缀 > Content-Type > host 判定；分片（.ts/.m4s）直接丢弃 */
function parseMediaUrl(url, mimeType = '', headers = {}, tabId = null) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('chrome-extension://') || url.startsWith('blob:') || url.startsWith('data:')) return null;

  let ext = '';
  const urlPath = url.split('?')[0];
  const match = urlPath.match(/\.([a-zA-Z0-9]{2,5})$/);
  if (match) {
    ext = match[1].toLowerCase();
  } else if (mimeType) {
    const sub = mimeType.split('/')[1]?.split(';')[0]?.toLowerCase();
    if (sub === 'vnd.apple.mpegurl' || sub === 'x-mpegurl') ext = 'm3u8';
    else if (sub === 'dash+xml') ext = 'mpd';
    else if (sub) ext = sub;
  }

  // Suppress individual chunk slices (.ts, .m4s) so they do not pollute the video list with 500KB fragments
  if (ext === 'ts' || ext === 'm4s') return null;

  const isStream = ext === 'm3u8' || ext === 'mpd';
  const isAudioPlatform = url.includes('music.126.net') || url.includes('music.163.com') || url.includes('qqmusic.qq.com') || url.includes('kugou.com') || url.includes('kuwo.cn');
  const isAudio = ['mp3', 'm4a', 'aac', 'flac', 'ogg', 'wav', 'opus'].includes(ext) || mimeType.startsWith('audio/') || isAudioPlatform;
  const isVideo = !isAudio && (['mp4', 'webm', 'flv', 'mkv', 'mov'].includes(ext) || isStream || mimeType.startsWith('video/'));

  if (!isStream && !isAudio && !isVideo) return null;

  let filename = 'media';
  const tabTitle = titleOf(tabId);
  if (tabTitle) {
    const clean = tabTitle.trim()
      .replace(/\s*[-_—|]\s*QQ音乐.*$/i, '')
      .replace(/\s*[-_—|]\s*单曲\s*[-_—|]\s*网易云音乐.*$/i, '')
      .replace(/\s*[-_—|]\s*网易云音乐.*$/i, '')
      .replace(/\s*[-_—|]\s*酷狗音乐.*$/i, '')
      .replace(/\s*[-_—|]\s*酷我音乐.*$/i, '')
      .replace(/\s*[-_—|]\s*哔哩哔哩.*$/i, '')
      .replace(/\s*[-_—|]\s*YouTube.*$/i, '')
      .replace(/\s*[-_—|]\s*腾讯视频.*$/i, '');
    if (clean) filename = clean.slice(0, 70);
  }
  if (filename === 'media') filename = urlPath.split('/').pop() || 'media';
  try {
    filename = decodeURIComponent(filename);
  } catch (e) {}

  const key = resourceKey(url);
  const label = isStream ? ext.toUpperCase() + ' 流媒体' : ext.toUpperCase() + ' 原画';

  return {
    key,
    hash: shortId(key),
    url,
    title: filename,
    type: isStream ? `${ext}_stream` : (isAudio ? 'audio' : 'video'),
    extension: ext || (isAudio ? 'mp3' : 'mp4'),
    is_audio: isAudio,
    duration: null,
    has_drm: false,
    headers,
    qualities: [
      {
        index: 0,
        label: label,
        width: null,
        height: null,
        bitrate: null,
        demuxer: ext || (isAudio ? 'mp3' : 'mp4'),
        videoUrl: isAudio ? '' : url,
        audioUrl: isAudio ? url : ''
      }
    ]
  };
}

/**
 * 把抓到的 media 观测翻译成图的一次 upsert。
 * 这里只做字段搬运，不做判断——判断留在 core/graph.js 与 core/decision.js。
 */
function addDiscoveredMedia(tabId, media) {
  if (!tabId || tabId < 0 || !media) return;
  ensureMediaIdentity(media);

  const observation = mediaToObservation(media, tabId, generationOf(tabId));
  const result = store.graphFor(tabId).upsert(observation);
  // 已存在且无字段变化时不做任何广播（AUDIT E3：避免每条观测都触发全量重取）
  if (!result.node || !result.changed) return;
  store.scheduleFlush();

  broadcastMedia(tabId, result.node);
  maybeProbe(tabId, observation, result.node);
}

function updateBadge(tabId) {
  const count = mediaListFor(tabId).length;
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count), tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#0284c7', tabId });
    chrome.action.setBadgeTextColor({ color: '#ffffff', tabId }).catch(() => {});
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }
}


// 0. Declarative Net Request Rules to bypass CDN anti-hotlinking (Referer Protection)
async function initRefererRules() {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) return;
  const RULES = [
    {
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.bilibili.com/' },
          { header: 'Origin', operation: 'set', value: 'https://www.bilibili.com' }
        ]
      },
      condition: {
        urlFilter: 'bilivideo.',
        resourceTypes: ['xmlhttprequest', 'media', 'other']
      }
    },
    {
      id: 2,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://v.qq.com/' },
          { header: 'Origin', operation: 'set', value: 'https://v.qq.com' }
        ]
      },
      condition: {
        urlFilter: 'tc.qq.com',
        resourceTypes: ['xmlhttprequest', 'media', 'other']
      }
    },
    {
      id: 3,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.douyin.com/' }
        ]
      },
      condition: {
        urlFilter: 'douyinvod.com',
        resourceTypes: ['xmlhttprequest', 'media', 'other']
      }
    },
    {
      id: 4,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' }
        ]
      },
      condition: {
        urlFilter: 'googlevideo.com',
        resourceTypes: ['xmlhttprequest', 'media', 'other']
      }
    },
    {
      id: 5,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://music.163.com/' },
          { header: 'Origin', operation: 'set', value: 'https://music.163.com' }
        ]
      },
      condition: {
        urlFilter: 'music.126.net',
        resourceTypes: ['xmlhttprequest', 'media', 'other']
      }
    },
    {
      id: 6,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://y.qq.com/' },
          { header: 'Origin', operation: 'set', value: 'https://y.qq.com' }
        ]
      },
      condition: {
        urlFilter: 'qqmusic.qq.com',
        resourceTypes: ['xmlhttprequest', 'media', 'other']
      }
    },
    {
      id: 7,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.kugou.com/' }
        ]
      },
      condition: {
        urlFilter: 'kugou.com',
        resourceTypes: ['xmlhttprequest', 'media', 'other']
      }
    },
    {
      id: 8,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.kuwo.cn/' }
        ]
      },
      condition: {
        urlFilter: 'kuwo.cn',
        resourceTypes: ['xmlhttprequest', 'media', 'other']
      }
    }
  ];

  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existing.map(r => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingIds,
      addRules: RULES
    });
    console.log('[ResourceHelper] Declarative anti-hotlinking rules active.');
  } catch (err) {
    console.warn('[ResourceHelper] updateDynamicRules error:', err);
  }
}

initRefererRules();

/**
 * 只监听可能承载媒体的请求类型（AUDIT E1）。
 * 旧实现不限类型，图片/脚本/样式/字体的每个请求都会进 JS 回调；
 * 加上这一条就能砍掉绝大部分事件量。
 */
const WEBREQUEST_FILTER = {
  urls: ['<all_urls>'],
  types: ['media', 'xmlhttprequest', 'object', 'other']
};

// 1. Sniff requests via WebRequest API
if (chrome.webRequest && chrome.webRequest.onSendHeaders) {
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      if (details.tabId < 0) return;
      const url = details.url;
      const host = hostOfUrl(url);
      if (!isYouTubeUrl(url, host) && !isCandidateUrl(url, host)) return;
      ensureTabMeta(details.tabId);

      if (isYouTubeUrl(url, host)) {
        const media = parseYouTubePlayback(url, details.tabId);
        if (media) addDiscoveredMedia(details.tabId, attributeMedia(media, details));
        return;
      }

      const headers = {};
      if (details.requestHeaders) {
        for (const h of details.requestHeaders) {
          if (['referer', 'origin', 'user-agent'].includes(h.name.toLowerCase())) {
            headers[h.name] = h.value;
          }
        }
      }
      const media = parseMediaUrl(url, '', headers, details.tabId);
      if (media) addDiscoveredMedia(details.tabId, attributeMedia(media, details));
    },
    WEBREQUEST_FILTER,
    ['requestHeaders', 'extraHeaders'].filter(Boolean)
  );
}

if (chrome.webRequest && chrome.webRequest.onHeadersReceived) {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.tabId < 0) return;
      const url = details.url;
      const host = hostOfUrl(url);
      const youTube = isYouTubeUrl(url, host);

      let contentType = '';
      if (details.responseHeaders) {
        for (const h of details.responseHeaders) {
          if (h.name.toLowerCase() === 'content-type') {
            contentType = h.value.toLowerCase();
            break;
          }
        }
      }

      // 响应头这一层能用 MIME 兜住"没有后缀、域名也不认识"的媒体
      const isMediaMime = Boolean(contentType) && STREAM_MIMES.some(m => contentType.includes(m));
      if (!youTube && !isMediaMime && !isCandidateUrl(url, host)) return;
      ensureTabMeta(details.tabId);

      if (youTube) {
        const media = parseYouTubePlayback(url, details.tabId);
        if (media) addDiscoveredMedia(details.tabId, attributeMedia(media, details));
        return;
      }

      const media = parseMediaUrl(url, contentType, {}, details.tabId);
      if (media) addDiscoveredMedia(details.tabId, attributeMedia(media, details));
    },
    WEBREQUEST_FILTER,
    ['responseHeaders', 'extraHeaders'].filter(Boolean)
  );
}

// 2. Manage tab lifecycle
chrome.tabs.onRemoved.addListener((tabId) => {
  store.drop(tabId);
  // 标签页没了，标题缓存也要跟着走，否则 SW 一生都在攒过期条目
  tabMeta.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // 标题/地址缓存供抓包路径同步读取（避免每条媒体一次 chrome.tabs.get，AUDIT E3）
  const patch = {};
  if (changeInfo.title) patch.title = changeInfo.title;
  if (changeInfo.url) patch.url = changeInfo.url;
  if (Object.keys(patch).length > 0) rememberTab(tabId, patch);
  if (changeInfo.title) store.touch(tabId);
});

if (chrome.webNavigation) {
  // 整页导航：新文档，旧资源不再有意义
  if (chrome.webNavigation.onCommitted) {
    chrome.webNavigation.onCommitted.addListener((details) => {
      if (details.frameId !== 0) return;
      bumpGeneration(details.tabId, details.documentId);
      store.drop(details.tabId);
      updateBadge(details.tabId);
      chrome.runtime.sendMessage({ type: 'RH_MEDIA_CLEARED', tab_id: details.tabId }).catch(() => {});
    });
  }
  // 前端路由（pushState）：同一个文档换了内容，只换代不删数据
  if (chrome.webNavigation.onHistoryStateUpdated) {
    chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
      if (details.frameId !== 0) return;
      bumpGeneration(details.tabId, details.documentId);
      updateBadge(details.tabId);
      chrome.runtime.sendMessage({ type: 'RH_MEDIA_CLEARED', tab_id: details.tabId }).catch(() => {});
    });
  }
}

// 3. Message dispatcher for Sidepanel and Content Scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || !request.type) return false;
  // 监听器必须同步注册；真正的处理是异步的（要先等快照恢复），所以统一返回 true 保持通道
  handleMessage(request, sender, sendResponse).catch((err) => {
    console.warn('[ResourceHelper] message handler failed:', err);
    try { sendResponse({ success: false, error: 'INTERNAL_ERROR' }); } catch (e) {}
  });
  return true;
});

async function handleMessage(request, sender, sendResponse) {
  // SW 可能刚被唤醒：等一次 storage.session 快照恢复，避免"刚重启就空列表"（AUDIT C1）
  await store.ready;
  const tabId = (sender.tab && sender.tab.id) ? sender.tab.id : (request.tabId || null);

  if (request.type === 'ON_DISCOVERED_MEDIA' && request.media) {
    const targetTabId = tabId || request.media.tab_id;
    if (targetTabId) addDiscoveredMedia(targetTabId, request.media);
    sendResponse({ success: true });
    return true;
  }

  if (request.type === 'ON_HOOK_EVENT' && request.event && request.event.kind) {
    if (!tabId) {
      sendResponse({ success: false, error: 'NO_TAB' });
      return true;
    }
    const hookSettings = await loadSettings();
    // 深度模式关闭时丢弃钩子事件：脚本仍然注入（manifest 声明式，无法条件注入），
    // 但不上报、不入库，等价于"没开"
    if (!hookSettings.deepCapture) {
      sendResponse({ success: true, ignored: true });
      return true;
    }
    const event = request.event;
    const hint = hookHints.get(tabId) || {
      mseMimeTypes: new Set(),
      mseAppends: 0,
      container: '',
      blobSource: false,
      hookUrls: new Set()
    };

    if (event.kind === 'mse' && event.mimeType) {
      hint.mseMimeTypes.add(String(event.mimeType).slice(0, 120));
    } else if (event.kind === 'mse-append') {
      hint.mseAppends = Math.max(hint.mseAppends, Number(event.index) || 0);
      if (!hint.container && Array.isArray(event.head) && event.head.length > 0) {
        try {
          const sniffed = sniffBytes(new Uint8Array(event.head));
          if (sniffed && sniffed.kind) hint.container = sniffed.kind;
        } catch (e) {}
      }
    } else if (event.kind === 'mse-object-url') {
      hint.blobSource = true;
    } else if (event.kind === 'blob-src') {
      hint.blobSource = true;
    } else if ((event.kind === 'fetch' || event.kind === 'xhr') && event.url) {
      const url = String(event.url);
      if (!hint.hookUrls.has(url) && hint.hookUrls.size < 40) {
        hint.hookUrls.add(url);
        // 只在 JS 里出现过的地址往往抓包抓不到，值得直接进资源图
        const key = resourceKey(url);
        const extensionMatch = url.split('?')[0].match(/.([a-zA-Z0-9]{2,5})$/);
        addDiscoveredMedia(tabId, {
          key: key,
          hash: shortId(key),
          url: url,
          title: '',
          type: 'video',
          extension: extensionMatch ? extensionMatch[1].toLowerCase() : 'mp4',
          is_audio: /.(mp3|m4a|aac|ogg|opus|wav|flac)$/i.test(url.split('?')[0]),
          provenance: 'dom'
        });
      }
    }

    hookHints.set(tabId, hint);
    if (!hookSettings.showHookHint) {
      sendResponse({ success: true });
      return true;
    }
    broadcast({
      type: 'RH_HOOK_HINT',
      tab_id: tabId,
      hint: {
        mseMimeTypes: Array.from(hint.mseMimeTypes),
        mseAppends: hint.mseAppends,
        container: hint.container,
        blobSource: hint.blobSource,
        hookUrlCount: hint.hookUrls.size
      }
    });
    sendResponse({ success: true });
    return true;
  }

  // ---- offscreen 构建（P3c）：把耗时的拉流/拼装搬出侧边栏 ----
  if (request.type === OFFSCREEN_MESSAGE.BUILD) {
    const job = normalizeBuildRequest(request);
    if (!job) {
      sendResponse({ success: true, ok: false, reason: 'INVALID_JOB' });
      return true;
    }
    const available = await ensureOffscreen();
    if (!available) {
      sendResponse({ success: true, ok: false, reason: offscreenSupported() ? 'CREATE_FAILED' : 'UNSUPPORTED' });
      return true;
    }

    const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    try {
      await chrome.runtime.sendMessage({ type: OFFSCREEN_MESSAGE.JOB_START, job: Object.assign({ jobId: jobId }, job) });
      sendResponse({ success: true, ok: true, jobId: jobId });
    } catch (e) {
      await closeOffscreenIfIdle();
      sendResponse({ success: true, ok: false, reason: 'DISPATCH_FAILED' });
    }
    return true;
  }

  if (request.type === OFFSCREEN_MESSAGE.PROGRESS) {
    const progress = normalizeProgress(request);
    broadcast({ type: OFFSCREEN_MESSAGE.PROGRESS, job_id: progress.jobId, percent: progress.percent, text: progress.text });
    sendResponse({ success: true });
    return true;
  }

  if (request.type === OFFSCREEN_MESSAGE.RESULT) {
    // 构建失败：告诉侧边栏回去本地跑，并把原因带上
    broadcast({
      type: OFFSCREEN_MESSAGE.RESULT,
      job_id: String(request.jobId || ''),
      ok: Boolean(request.ok),
      error: typeof request.error === 'string' ? request.error : ''
    });
    closeOffscreenIfIdle().catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  if (request.type === OFFSCREEN_MESSAGE.READY) {
    const jobId = String(request.jobId || '');
    const blobUrl = String(request.blobUrl || '');
    const directUrl = String(request.directUrl || '');
    const filename = String(request.filename || '');
    const meta = request.meta && typeof request.meta === 'object' ? request.meta : {};

    if (!jobId || (!blobUrl.startsWith('blob:') && !directUrl)) {
      sendResponse({ success: false, error: 'BAD_READY' });
      return true;
    }

    try {
      const browserDownloadId = await chrome.downloads.download({
        url: blobUrl || directUrl,
        filename: filename || undefined,
        saveAs: false
      });

      if (Number.isFinite(browserDownloadId)) {
        activeDownloads.set(browserDownloadId, { tabId: tabId || 0, dlId: 'dl_' + browserDownloadId, mediaHash: '' });
        // blob URL 必须等下载真的结束后再释放，否则浏览器可能拿不到数据
        if (blobUrl) pendingOffscreenBlobs.set(browserDownloadId, { jobId: jobId, blobUrl: blobUrl });
        recordDownload({
          id: 'b' + browserDownloadId,
          browserDownloadId: browserDownloadId,
          title: meta.title || '',
          url: meta.url || directUrl || '',
          audioUrl: meta.audioUrl || '',
          filename: filename,
          mode: meta.mode || 'stream',
          site: meta.site || '',
          ts: Date.now()
        }).then((entries) => {
          broadcast({ type: 'RH_HISTORY_CHANGED', entries: entries, stats: summarizeHistory(entries) });
        }).catch(() => {});
      }

      broadcast({ type: OFFSCREEN_MESSAGE.RESULT, job_id: jobId, ok: true, download_id: browserDownloadId });
      sendResponse({ success: true, download_id: browserDownloadId });
    } catch (error) {
      broadcast({ type: OFFSCREEN_MESSAGE.RESULT, job_id: jobId, ok: false, error: (error && error.message) || '下载启动失败' });
      if (blobUrl) {
        try {
          await chrome.runtime.sendMessage({ type: OFFSCREEN_MESSAGE.RELEASE, jobId: jobId });
        } catch (e) {}
      }
      sendResponse({ success: false, error: 'DOWNLOAD_FAILED' });
    }
    return true;
  }

  if (request.type === 'RH_GET_HISTORY') {
    const entries = await loadHistory(true);
    sendResponse({ success: true, entries: entries, stats: summarizeHistory(entries) });
    return true;
  }

  if (request.type === 'RH_CLEAR_HISTORY') {
    const entries = await clearHistory();
    broadcast({ type: 'RH_HISTORY_CHANGED', entries: entries, stats: summarizeHistory(entries) });
    sendResponse({ success: true });
    return true;
  }

  if (request.type === 'RH_DOWNLOAD_STARTED' && request.entry) {
    // 引擎路径（HLS / DASH / 合流）在侧边栏启动下载后回报，统一记录到历史
    const entries = await recordDownload(request.entry);
    broadcast({ type: 'RH_HISTORY_CHANGED', entries: entries, stats: summarizeHistory(entries) });
    sendResponse({ success: true });
    return true;
  }

  if (request.type === 'RH_GET_SETTINGS') {
    sendResponse({ success: true, settings: await loadSettings() });
    return true;
  }

  if (request.type === 'RH_SET_SETTINGS') {
    sendResponse({ success: true, settings: await saveSettings(request.patch || {}) });
    return true;
  }

  // ---- 整页快照（P8）：带页面凭证抓资源、列出 frame ----
  if (request.type === 'RH_ARCHIVE_FETCH') {
    const archiveSettings = await loadSettings();
    const requestedMax = Number(request.maxBytes);
    const maxBytes = Number.isFinite(requestedMax) && requestedMax > 0
      ? Math.round(requestedMax)
      : Math.round(archiveSettings.archiveMaxResourceMB * 1024 * 1024);
    // refererRetry 只能由设置关闭，不能由消息打开：这是隐私开关，不该被页面内容影响
    const refererRetry = archiveSettings.archiveRefererRetry !== false;
    const payload = await fetchArchiveResources({
      requests: Array.isArray(request.requests) ? request.requests : [],
      pageUrl: typeof request.pageUrl === 'string' ? request.pageUrl : '',
      maxBytes: maxBytes,
      refererRetry: refererRetry
    });
    sendResponse({ success: true, results: payload.results });
    return true;
  }

  if (request.type === 'RH_ARCHIVE_FRAMES') {
    const requestedTab = Number(request.tabId);
    const targetTabId = Number.isFinite(requestedTab) && requestedTab > 0 ? requestedTab : tabId;
    const frames = targetTabId ? await listTabFrames(targetTabId) : [];
    sendResponse({ success: true, frames: frames });
    return true;
  }

  if (request.type === 'ON_PAGE_DATA' && request.payload && request.payload.json) {
    if (!tabId) {
      sendResponse({ success: false, error: 'NO_TAB' });
      return true;
    }
    const pageUrl = request.payload.url || '';
    const adapters = await loadAdapters();
    const matched = selectAdapters(adapters, pageUrl);
    if (matched.length === 0) {
      sendResponse({ success: true, count: 0, reason: 'NO_ADAPTER' });
      return true;
    }

    const context = {
      data: request.payload.json || {},
      media: Array.isArray(request.payload.media) ? request.payload.media : [],
      doc: { title: request.payload.title || '', url: pageUrl },
      url: pageUrl
    };

    // 所有匹配的适配器都跑一遍再合并：站点适配器给页面数据里的流，
    // generic-dom 给 DOM 里真实在放的流；重复的 URL 由资源图合并。
    let total = 0;
    const used = [];
    for (const adapter of matched) {
      const extracted = extractWithAdapter(adapter, context);
      if (!extracted.matched || extracted.variants.length === 0) continue;

      const observations = variantsToObservations({
        adapterId: adapter.id,
        mediaId: extracted.id,
        title: extracted.title || request.payload.title || '',
        variants: extracted.variants,
        scope: {
          tabId: tabId,
          frameId: Number.isInteger(sender.frameId) ? sender.frameId : 0,
          documentId: sender.documentId || '',
          generation: generationOf(tabId)
        },
        provenance: 'page-json',
        headers: adapter.headers || null
      });

      for (const observation of observations) addDiscoveredMedia(tabId, observation);
      total += observations.length;
      used.push(adapter.id);
    }

    sendResponse({ success: true, count: total, adapters: used });
    return true;
  }

  if (request.type === 'RH_GET_MEDIA') {
    if (!tabId) {
      sendResponse({ success: false, error: 'No tab id', media: [] });
      return true;
    }
    const viewSettings = await loadSettings();
    const mediaList = mediaListFor(tabId).slice(0, viewSettings.maxMediaPerTab);
    const hint = viewSettings.showHookHint ? hookHints.get(tabId) : null;
    sendResponse({
      success: true,
      count: mediaList.length,
      media: mediaList,
      // 侧边栏可能在钩子事件之后才打开，这里把当前提示一起带过去
      hint: hint ? {
        mseMimeTypes: Array.from(hint.mseMimeTypes),
        mseAppends: hint.mseAppends,
        container: hint.container,
        blobSource: hint.blobSource,
        hookUrlCount: hint.hookUrls.size
      } : null
    });
    return true;
  }

  if (request.type === 'RH_DOWNLOAD') {
    if (!tabId) {
      sendResponse({ success: false, error: 'No tab id' });
      return true;
    }
    const mediaList = mediaListFor(tabId);

    // 精确命中才继续：不存在"取列表第一条"的兜底（AUDIT B5）
    const picked = pickTargetMedia(mediaList, {
      mediaKey: request.media_key,
      mediaHash: request.media_hash,
      url: request.url
    });
    if (!picked.ok) {
      sendResponse({ success: false, error: picked.code, message: picked.message });
      return true;
    }
    const targetMedia = picked.media;

    // 下载计划由纯函数生成：模式、URL、扩展名、文件名一次定死（AUDIT A5/A7）
    const downloadSettings = await loadSettings();
    const plan = buildDownloadPlan(targetMedia, {
      playlistIndex: request.playlist_index,
      audioOnly: !!request.audio_only,
      audioUrl: request.audio_url,
      filenameTemplate: downloadSettings.filenameTemplate,
      date: new Date().toISOString().slice(0, 10).replace(/-/g, '')
    });
    if (!plan.ok) {
      sendResponse({ success: false, error: plan.code, message: plan.message });
      return true;
    }

    const vUrl = plan.mode === 'direct' ? plan.url : (plan.videoUrl || plan.url);
    const aUrl = plan.audioUrl || '';

    // Check for separated DASH / Bilibili / YouTube stream requiring muxing
    if (plan.mode === 'mux') {
      const muxDlId = `mux_${Date.now()}`;
      chrome.runtime.sendMessage({
        type: 'START_SEPARATED_MUX_DOWNLOAD',
        download_id: muxDlId,
        tab_id: tabId,
        videoUrl: vUrl,
        audioUrl: aUrl,
        title: targetMedia.title
      }).catch(() => {});

      sendResponse({
        success: true,
        is_mux: true,
        download_id: muxDlId,
        message: '音画分离流已就绪，正在侧边栏执行极速并发合流'
      });
      return true;
    }

    // If target media is an M3U8 stream, delegate to stream downloader in Sidepanel
    if (plan.mode === 'stream') {
      const m3u8DlId = `m3u8_${Date.now()}`;
      // Broadcast task to sidepanel
      chrome.runtime.sendMessage({
        type: 'START_STREAM_DOWNLOAD',
        download_id: m3u8DlId,
        tab_id: tabId,
        media: targetMedia,
        audio_only: !!request.audio_only
      }).catch(() => {});

      sendResponse({
        success: true,
        is_m3u8: true,
        download_id: m3u8DlId,
        message: 'M3U8流式切片下载已就绪，正在侧边栏执行极速并发拼装'
      });
      return true;
    }

    if (plan.mode === 'dash') {
      const dashDlId = `dash_${Date.now()}`;
      chrome.runtime.sendMessage({
        type: 'START_DASH_DOWNLOAD',
        download_id: dashDlId,
        tab_id: tabId,
        media: targetMedia
      }).catch(() => {});

      sendResponse({
        success: true,
        is_dash: true,
        download_id: dashDlId,
        message: 'DASH 流已就绪，正在侧边栏下载并合流'
      });
      return true;
    }

    chrome.downloads.download({
      url: plan.url,
      filename: plan.filename,
      saveAs: false
    }, (browserDownloadId) => {
      if (chrome.runtime.lastError || !browserDownloadId) {
        sendResponse({ success: false, error: chrome.runtime.lastError?.message || '下载启动失败' });
        return;
      }

      const dlId = `dl_${browserDownloadId}`;
      activeDownloads.set(browserDownloadId, { tabId, dlId, mediaHash: targetMedia.hash });

      recordDownload({
        id: 'b' + browserDownloadId,
        browserDownloadId: browserDownloadId,
        title: targetMedia.title || plan.basename || '',
        url: plan.url,
        filename: plan.filename,
        mode: plan.mode,
        site: siteKeyForDownload(targetMedia),
        ts: Date.now()
      }).then((entries) => {
        broadcast({ type: 'RH_HISTORY_CHANGED', entries: entries, stats: summarizeHistory(entries) });
      }).catch(() => {});

      sendResponse({
        success: true,
        download_id: dlId,
        browser_download_id: browserDownloadId,
        basename: plan.basename,
        extension: plan.extension,
        // 降级提示（分片流无法合流等）：UI 会以 info toast 呈现，避免"悄悄下成无声"
        warning: plan.warnings && plan.warnings.includes('AUDIO_NOT_MUXABLE') ? (plan.message || '') : ''
      });
    });

    return true;
  }

  return false;
}

// 4. Track download progress
if (chrome.downloads && chrome.downloads.onChanged) {
  chrome.downloads.onChanged.addListener(async (delta) => {
    // 历史状态先更新：即使不是本扩展发起的下载，只要是我们记录过的也要跟着变
    // 下载结束（无论成败）后释放 offscreen 建好的 blob URL
    if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
      await releaseOffscreenBlob(delta.id);
    }

    try {
      let patch = null;
      if (delta.state && delta.state.current === 'complete') patch = { status: 'completed' };
      else if (delta.state && delta.state.current === 'interrupted') patch = { status: 'failed' };
      else if (delta.error) patch = { status: 'failed' };

      if (patch && delta.totalBytes && delta.totalBytes.current > 0) {
        patch.size = delta.totalBytes.current;
      }
      if (patch) {
        const entries = await updateHistory({ browserDownloadId: delta.id }, patch);
        if (Array.isArray(entries) && entries.length > 0) {
          broadcast({ type: 'RH_HISTORY_CHANGED', entries: entries, stats: summarizeHistory(entries) });
        }
      }
    } catch (e) {}

    const info = activeDownloads.get(delta.id);
    if (!info) return;

    let progress = null;
    if (delta.state && delta.state.current === 'complete') {
      progress = { percent: 100, status: 'completed' };
      activeDownloads.delete(delta.id);
    } else if (delta.error) {
      progress = { percent: 0, status: 'error', error: delta.error.current };
      activeDownloads.delete(delta.id);
    } else if (delta.bytesReceived && delta.totalBytes && delta.totalBytes.current > 0) {
      const pct = Math.round((delta.bytesReceived.current / delta.totalBytes.current) * 100);
      progress = { percent: pct, status: 'downloading' };
    }

    if (progress) {
      try {
        chrome.tabs.sendMessage(info.tabId, {
          type: 'RH_DOWNLOAD_PROGRESS',
          download_id: info.dlId,
          progress
        }).catch(() => {});
      } catch (e) {}

      try {
        chrome.runtime.sendMessage({
          type: 'RH_DOWNLOAD_PROGRESS',
          download_id: info.dlId,
          tab_id: info.tabId,
          progress
        }).catch(() => {});
      } catch (e) {}
    }
  });
}

// 5. 入口：侧边栏优先；没有 sidePanel 的内核退化为独立弹窗
//    - 不再设置 action.setPopup（那会让点图标永远开 popup，侧边栏形同虚设，AUDIT C4）
//    - sidePanel.open 需要用户手势，只能在命令/点击回调里调用（AUDIT C3）
const HAS_SIDE_PANEL = Boolean(chrome.sidePanel && typeof chrome.sidePanel.open === 'function');
const PANEL_PAGE = 'sidepanel/index.html';
let fallbackWindowId = null;

async function openUiForTab(tabId) {
  if (HAS_SIDE_PANEL) {
    try {
      await chrome.sidePanel.open(tabId ? { tabId } : { windowId: chrome.windows.WINDOW_ID_CURRENT });
      return true;
    } catch (e) {
      console.warn('[ResourceHelper] sidePanel.open 失败，退化为独立窗口:', e);
    }
  }
  try {
    if (fallbackWindowId !== null) {
      await chrome.windows.update(fallbackWindowId, { focused: true });
      return true;
    }
  } catch (e) { fallbackWindowId = null; }
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(PANEL_PAGE),
      type: 'popup',
      width: 420,
      height: 640
    });
    fallbackWindowId = win && win.id != null ? win.id : null;
    return true;
  } catch (e) {
    console.warn('[ResourceHelper] 无法打开界面:', e);
    return false;
  }
}

if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === fallbackWindowId) fallbackWindowId = null;
  });
}

if (HAS_SIDE_PANEL && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener((tab) => { openUiForTab(tab && tab.id); });
}

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command !== 'open-panel') return;
    chrome.tabs.query({ active: true, currentWindow: true })
      .then((tabs) => openUiForTab(tabs && tabs[0] ? tabs[0].id : null))
      .catch(() => {});
  });
}

console.log('[ResourceHelper] Native Service Worker with YouTube streaming support initialized.');