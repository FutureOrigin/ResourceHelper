/**
 * 整页快照的抓取端（P8，后台侧）
 *
 * 归档要抓的东西和媒体嗅探不一样：图片、字体、样式表散落在各种 CDN 上，
 * 页面里的 `<img>` 能显示，不代表扩展能读 —— 所以必须由后台带 host 权限去取
 * （扩展 fetch 不受 CORS 限制），并且带上页面 cookie（`credentials: 'include'`）。
 *
 * 两个现实问题：
 *   1. 有的图床/字体站校验 Referer，直接取会 403。这里对失败项做一次
 *      "临时挂上页面 Referer 再试"的重试（用 declarativeNetRequest 的会话规则，
 *      只作用于没有标签页归属的请求，也就是扩展自己发的请求），用完立刻删。
 *   2. 单张图可能几十 MB。必须边读边计数，超过上限就中断，而不是先读进内存再判断。
 *
 * 本模块只在 service worker 里跑；纯数据部分（规则形状、可重试判定、文本解码）
 * 被抽成可直接单测的函数。
 */

import { bytesToBase64, charsetFromContentType, stripContentTypeParams } from '../core/base64.js';
import { isFetchableUrl } from '../core/page-archive.js';

/** 单个资源的默认上限（字节）：4 MiB，与设置页的默认值对齐 */
export const DEFAULT_MAX_RESOURCE_BYTES = 4 * 1024 * 1024;
/** 单次 fetch 的墙钟上限 */
const FETCH_TIMEOUT_MS = 20000;
/** 并发数：太多会打满连接池，反而让页面自己的请求变慢 */
const CONCURRENCY = 4;
const RETRY_CONCURRENCY = 2;
/** 会话规则 id 从这里开始，避开其它地方用的 1..8 */
const RULE_ID_BASE = 900000;
/** 每个批次预留一段 id：两个标签页同时归档时不会撞号 */
const RULE_ID_STRIDE = 32;
let ruleIdCursor = RULE_ID_BASE;

function nextRuleIdBase() {
  const base = ruleIdCursor;
  ruleIdCursor += RULE_ID_STRIDE;
  if (ruleIdCursor > RULE_ID_BASE + 6000) ruleIdCursor = RULE_ID_BASE;
  return base;
}

/** 需要"带上页面 Referer 再试一次"的状态：403/401 是防盗链的典型回复 */
const RETRYABLE_STATUS = new Set([401, 403, 406, 412, 451]);

export function isFetchable(url) {
  return isFetchableUrl(url);
}

/** 失败结果是否需要重试（只重试"可能被防盗链拦了"的情况） */
export function isRefererRetryable(result) {
  if (!result || result.ok) return false;
  if (Number(result.status) > 0) return RETRYABLE_STATUS.has(Number(result.status));
  return true; // status 为 0：网络层失败，也值得带 Referer 再试一次
}

/** 从一组 URL 里提取去重后的 host（用于生成 Referer 规则） */
export function uniqueHosts(urls) {
  const seen = new Map();
  for (const url of Array.isArray(urls) ? urls : []) {
    try {
      const host = new URL(String(url)).hostname.toLowerCase();
      if (host) seen.set(host, true);
    } catch (e) {
      // 非绝对地址：忽略
    }
  }
  return Array.from(seen.keys()).sort();
}

/**
 * 生成"给扩展请求补 Referer"的会话规则。
 * `tabIds: [-1]` 是 DNR 里表示"没有标签页归属的请求"的写法 ——
 * 扩展 service worker 自己发的请求正是这一类，因此不会影响用户正在浏览的页面。
 *
 * @param {string} pageUrl 作为 Referer 的页面地址
 * @param {string[]} hosts
 * @param {number} [baseId]
 */
export function planRefererRules(pageUrl, hosts, baseId) {
  const referer = String(pageUrl || '');
  if (!/^https?:\/\//i.test(referer)) return [];
  const idBase = Number.isFinite(baseId) ? baseId : RULE_ID_BASE;
  const list = Array.isArray(hosts) ? hosts : [];
  return list.slice(0, 20).map((host, offset) => ({
    id: idBase + offset,
    priority: 2,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'referer', operation: 'set', value: referer }]
    },
    condition: {
      urlFilter: '||' + String(host) + '^',
      tabIds: [-1],
      resourceTypes: ['xmlhttprequest', 'image', 'font', 'media', 'other', 'stylesheet', 'script', 'object']
    }
  }));
}

/**
 * 文本解码：按响应头里的 charset 来，未知 charset 退回 UTF-8。
 * 只用于 CSS —— 解码错了会得到一堆替换字符，所以失败要如实报出来。
 */
export function decodeTextBytes(bytes, charset) {
  const label = String(charset || 'utf-8').toLowerCase();
  const attempt = (name) => {
    try {
      return new TextDecoder(name, { fatal: false }).decode(bytes);
    } catch (e) {
      return null;
    }
  };
  const decoded = attempt(label);
  if (decoded != null) return decoded;
  const fallback = attempt('utf-8');
  if (fallback != null) return fallback;
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * 读响应体，超过上限立刻中断。
 * @returns {Promise<{bytes?:Uint8Array, exceeded?:boolean, size:number}>}
 */
export async function readBodyWithLimit(response, maxBytes) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_RESOURCE_BYTES;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    return { exceeded: true, size: declared };
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > limit) return { exceeded: true, size: buffer.byteLength };
    return { bytes: new Uint8Array(buffer), size: buffer.byteLength };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    const chunk = step.value;
    total += chunk.length;
    if (total > limit) {
      try { await reader.cancel(); } catch (e) {}
      return { exceeded: true, size: total };
    }
    chunks.push(chunk);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes: merged, size: total };
}

/**
 * 抓一个资源。
 * @param {{url:string, kind?:string}} request kind='css' 时返回文本，否则返回 base64
 * @param {{maxBytes?:number}} [options]
 */
export async function fetchOne(request, options) {
  const opts = options || {};
  const url = String((request && request.url) || '');
  const kind = (request && request.kind) || 'binary';
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_RESOURCE_BYTES;

  if (!isFetchable(url)) {
    return { url: url, ok: false, status: 0, error: 'UNSUPPORTED_SCHEME', bytes: 0 };
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;

  try {
    const response = await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      signal: controller ? controller.signal : undefined
    });

    const mime = stripContentTypeParams(response.headers.get('content-type'));
    const charset = charsetFromContentType(response.headers.get('content-type'));

    if (!response.ok) {
      // 失败也要把体积读干净，否则连接不会复用
      try { await response.arrayBuffer(); } catch (e) {}
      return {
        url: url,
        finalUrl: response.url || url,
        ok: false,
        status: response.status,
        mime: mime,
        bytes: 0,
        error: 'HTTP_' + response.status
      };
    }

    const body = await readBodyWithLimit(response, maxBytes);
    if (body.exceeded) {
      return {
        url: url,
        finalUrl: response.url || url,
        ok: false,
        status: response.status,
        mime: mime,
        bytes: body.size,
        error: 'TOO_LARGE'
      };
    }

    const result = {
      url: url,
      finalUrl: response.url || url,
      ok: true,
      status: response.status,
      mime: mime,
      bytes: body.size
    };

    if (kind === 'css') {
      const text = decodeTextBytes(body.bytes, charset);
      result.text = text;
      result.charset = charset || 'utf-8';
    } else {
      result.base64 = bytesToBase64(body.bytes);
    }
    return result;
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || /aborted/i.test(String(error.message || '')));
    return {
      url: url,
      ok: false,
      status: 0,
      bytes: 0,
      error: aborted ? 'TIMEOUT' : 'NETWORK'
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 小并发池：保持结果顺序，不吞异常（单条失败不影响其它条） */
async function runPool(items, concurrency, worker) {
  const queue = items.slice();
  const width = Math.max(1, Math.min(concurrency, queue.length));
  const runners = [];
  for (let i = 0; i < width; i++) {
    runners.push((async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        try {
          await worker(item);
        } catch (e) {
          // worker 内部已经产出失败结果；这里只保证池子不中断
        }
      }
    })());
  }
  await Promise.all(runners);
}

/**
 * 批量抓取，失败项带上页面 Referer 重试一次。
 *
 * @param {{requests:Array<{url:string,kind?:string}>, pageUrl?:string, maxBytes?:number, refererRetry?:boolean}} input
 * @returns {Promise<{results:Array}>} 与 requests 一一对应
 */
export async function fetchArchiveResources(input) {
  const opts = input || {};
  const requests = Array.isArray(opts.requests) ? opts.requests.slice(0, 64) : [];
  const pageUrl = String(opts.pageUrl || '');
  const refererRetry = opts.refererRetry !== false;
  const maxBytes = opts.maxBytes;

  const results = new Array(requests.length).fill(null);
  const items = requests.map((request, index) => ({ index: index, request: request }));

  await runPool(items, CONCURRENCY, async (item) => {
    results[item.index] = await fetchOne(item.request, { maxBytes: maxBytes });
  });

  const retryTargets = items.filter((item) => isRefererRetryable(results[item.index]));
  if (refererRetry && retryTargets.length > 0 && /^https?:\/\//i.test(pageUrl) && chrome.declarativeNetRequest) {
    const hosts = uniqueHosts(retryTargets.map((item) => item.request.url));
    const rules = planRefererRules(pageUrl, hosts, nextRuleIdBase());
    if (rules.length > 0) {
      let added = [];
      try {
        await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });
        added = rules.map((rule) => rule.id);
        await runPool(retryTargets, RETRY_CONCURRENCY, async (item) => {
          const retried = await fetchOne(item.request, { maxBytes: maxBytes });
          if (retried && retried.ok) {
            retried.viaReferer = true;
            results[item.index] = retried;
          } else if (retried) {
            // 保留第一次的错误码（用户更容易据此判断是 403 还是超时）
            retried.refererRetryFailed = true;
          }
        });
      } catch (error) {
        // 规则加不上就算了：归档缺几张图，好过整个流程失败
        console.warn('[ResourceHelper] referer retry unavailable:', error);
      } finally {
        if (added.length > 0) {
          try {
            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: added });
          } catch (e) {}
        }
      }
    }
  }

  return { results: results };
}

/** 当前标签页的 frame 列表（用于把 iframe 逐个抓回来） */
export async function listTabFrames(tabId) {
  try {
    if (!chrome.webNavigation || typeof chrome.webNavigation.getAllFrames !== 'function') return [];
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tabId });
    return (frames || []).map((frame) => ({
      frameId: Number(frame.frameId),
      parentFrameId: Number(frame.parentFrameId),
      url: typeof frame.url === 'string' ? frame.url : ''
    })).filter((frame) => Number.isFinite(frame.frameId));
  } catch (e) {
    return [];
  }
}
