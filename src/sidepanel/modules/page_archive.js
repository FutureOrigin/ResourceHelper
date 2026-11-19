/**
 * 整页快照 · 编排（P8，侧边栏侧）
 *
 * 一次归档的完整流水线：
 *
 *   1. 采集：向每一个 frame 要一份"序列化后的文档 + 资源占位符清单"；
 *   2. 样式闭包：`<link>` 与 `<style>` 里的 CSS 抓回来，把 `url()` 换成 data URI，
 *      `@import` 展开（限深度），全部失败也退回绝对地址而不是留个断链；
 *   3. 资源内联：图片/封面/图标按 URL 去重后批量抓取，受单文件与总量预算约束；
 *   4. 装配：先深后浅 —— 子框架先塞进父文档的 srcdoc，再替换父文档的占位符，
 *      顺序反了会把子文档里的 & 转义两遍；
 *   5. 落盘：交给统一末端（download_finalize）写历史、建 blob、调 chrome.downloads。
 *
 * 所有 I/O 都走 `deps`，所以这条流水线可以在 Node 里用假依赖跑完整单测
 * （见 test/unit/page-archive-pipeline.test.mjs）—— 这是它存在的主要理由。
 */

import {
  archiveFilename,
  applyCssReferences,
  buildArchiveDocument,
  classifyResource,
  cssImportRef,
  cssUrlRef,
  describeSkipReason,
  escapeHtmlAttr,
  escapeStyleText,
  normalizeArchiveOptions,
  normalizeResourceUrl,
  replacePlaceholders,
  scanCssReferences
} from '../../core/page-archive.js';
import { dataUrlFor, guessMimeFromUrl } from '../../core/base64.js';
import { buildFrameTree, embedChildFrame, normalizeFrameUrl, planFrameAssembly, revertFramePlaceholder } from '../../core/page-frames.js';
import { finalizeBlobDownload } from './download_finalize.js';

export const COLLECT_MESSAGE = 'RH_ARCHIVE_COLLECT';
export const ARCHIVER_FILE = 'content/page_archiver.js';
/** 单个 frame 最多展开几层（再深就没完没了了） */
const MAX_FRAME_DEPTH = 3;
/** 二进制批量抓取的批大小（一条消息里最多这么大，别让结构化克隆卡住侧边栏） */
const BINARY_BATCH = 4;

const PHASE_RANGES = {
  collect: [0, 12],
  frames: [12, 28],
  css: [28, 55],
  resources: [55, 90],
  assemble: [90, 96],
  download: [96, 100]
};

function percentFor(phase, done, total) {
  const range = PHASE_RANGES[phase] || [0, 100];
  const [start, end] = range;
  const ratio = Number.isFinite(total) && total > 0 && Number.isFinite(done)
    ? Math.min(1, Math.max(0, done / total))
    : 0;
  return Math.round(start + (end - start) * ratio);
}

/** 真正的扩展环境依赖（单测里换成假货） */
export function createDefaultDeps() {
  return {
    sendToTab(tabId, message, options) {
      return chrome.tabs.sendMessage(tabId, message, options);
    },
    async inject(tabId, frameId) {
      const target = Number.isFinite(frameId) && frameId > 0
        ? { tabId: tabId, frameIds: [frameId] }
        : { tabId: tabId, allFrames: true };
      try {
        await chrome.scripting.executeScript({ target: target, files: [ARCHIVER_FILE] });
        return true;
      } catch (error) {
        // allFrames 里只要有一个 frame 不允许注入，整次调用就会失败：
        // 退回到只注入主框架，用户至少能存到主文档
        if (target.allFrames) {
          try {
            await chrome.scripting.executeScript({ target: { tabId: tabId }, files: [ARCHIVER_FILE] });
            return true;
          } catch (e) {
            return false;
          }
        }
        return false;
      }
    },
    async listFrames(tabId) {
      const response = await chrome.runtime.sendMessage({ type: 'RH_ARCHIVE_FRAMES', tabId: tabId });
      return response && response.success && Array.isArray(response.frames) ? response.frames : [];
    },
    async fetchResources(requests, context) {
      const response = await chrome.runtime.sendMessage({
        type: 'RH_ARCHIVE_FETCH',
        requests: requests,
        pageUrl: (context && context.pageUrl) || '',
        maxBytes: (context && context.maxBytes) || 0
      });
      if (!response || !response.success) throw new Error('抓取服务不可用');
      return Array.isArray(response.results) ? response.results : [];
    },
    finalize(input) {
      return finalizeBlobDownload(input);
    },
    now() {
      return Date.now();
    }
  };
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch (e) {
    return '';
  }
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function needsInjection(response) {
  if (!response) return true;
  if (response.success) return false;
  const code = String(response.reason || response.error || '').toLowerCase();
  return code === 'no_receiver' || /receiving end does not exist|could not establish connection/.test(code);
}

/**
 * 向一个 frame 要它的序列化文档；内容脚本不在（扩展刚更新/受限页面）时先注入再重试。
 */
async function collectFrame(context, frameId) {
  const message = { type: COLLECT_MESSAGE, options: context.collectOptions };
  // 必须显式带 frameId：不传时 chrome.tabs.sendMessage 会广播给所有 frame，
  // 子框架可能抢答，拿到的就不是主文档了
  const targetFrame = Number.isFinite(Number(frameId)) ? Number(frameId) : 0;
  const target = { frameId: targetFrame };

  const ask = async () => {
    try {
      return await context.deps.sendToTab(context.tabId, message, target);
    } catch (error) {
      return { success: false, error: 'NO_RECEIVER', reason: 'no_receiver', message: (error && error.message) || '' };
    }
  };

  let response = await ask();
  if (!response || !response.success) {
    if (needsInjection(response)) {
      const injected = await Promise.resolve(context.deps.inject(context.tabId, frameId)).catch(() => false);
      if (injected) response = await ask();
    }
  }

  if (!response || !response.success) {
    return {
      ok: false,
      frameId: frameId,
      error: (response && response.error) || 'NO_RECEIVER',
      message: (response && response.message) || ''
    };
  }

  return Object.assign({ ok: true }, response, { frameId: frameId });
}

/**
 * 跑一次整页归档。
 *
 * @param {Object} input
 * @param {number} input.tabId
 * @param {string} [input.pageUrl]
 * @param {Object} [input.options] 见 core/page-archive.js 的 normalizeArchiveOptions
 * @param {Object} [input.settings] 设置快照（filenameTemplate / archive* 字段）
 * @param {Function} [input.onProgress]
 * @param {Object} [input.deps]
 * @returns {Promise<Object>} { ok, filename, bytes, downloadId, stats, skipped, frames }
 */
export async function archivePage(input) {
  const opts = input || {};
  const options = normalizeArchiveOptions(opts.options);
  const settings = opts.settings && typeof opts.settings === 'object' ? opts.settings : {};
  const deps = opts.deps || createDefaultDeps();
  const tabId = Number(opts.tabId);
  const pageUrl = typeof opts.pageUrl === 'string' ? opts.pageUrl : '';
  const limits = options.limits;

  const report = (phase, text, done, total) => {
    if (typeof opts.onProgress !== 'function') return;
    try {
      opts.onProgress({ phase: phase, text: text, done: done, total: total, percent: percentFor(phase, done, total) });
    } catch (e) {}
  };

  if (!Number.isFinite(tabId) || tabId <= 0) {
    return { ok: false, error: 'NO_TAB', message: '没有可保存的标签页' };
  }

  const stats = {
    images: 0,
    fonts: 0,
    styles: 0,
    other: 0,
    skipped: 0,
    frames: 0,
    scriptsRemoved: 0,
    canvas: 0,
    bytesUsed: 0,
    binaryCount: 0,
    cssCount: 0,
    resources: 0,
    skips: []
  };

  const skip = (url, reason) => {
    stats.skipped++;
    if (stats.skips.length < 200) stats.skips.push({ url: url, reason: reason, message: describeSkipReason(reason) });
  };

  try {
    /* ---------------- 1. 采集 ---------------- */
    report('collect', '正在读取页面结构…');
    const context = {
      tabId: tabId,
      pageUrl: pageUrl,
      deps: deps,
      collectOptions: {
        inlineImages: options.inlineImages,
        removeScripts: options.removeScripts,
        embedFrames: options.embedFrames,
        onlySelection: options.onlySelection,
        maxFrames: limits.maxFrames
      }
    };

    const top = await collectFrame(context, 0);
    if (!top.ok) {
      // NO_RECEIVER 的原始报错是 "Receiving end does not exist"，对用户毫无意义，
      // 换成"可能是什么、该怎么做"的说法
      const isSilent = String(top.error || '').toUpperCase() === 'NO_RECEIVER';
      return {
        ok: false,
        error: top.error,
        message: isSilent ? skipMessage('NO_RECEIVER') : (top.message || skipMessage(top.error))
      };
    }

    const collected = [top];

    /* ---------------- 2. 子框架 ---------------- */
    let frameSkipped = 0;
    const topDescriptors = Array.isArray(top.frames) ? top.frames : [];
    if (options.embedFrames && topDescriptors.length > 0) {
      report('frames', '正在整理 iframe…', 0, topDescriptors.length);
      const liveFrames = await Promise.resolve(deps.listFrames(tabId)).catch(() => []);
      const tree = buildFrameTree(liveFrames);
      const wanted = tree.deepestFirst
        .filter((frameId) => frameId !== 0)
        .filter((frameId) => {
          const node = tree.byId.get(frameId);
          return node && node.depth <= MAX_FRAME_DEPTH;
        })
        .slice(0, limits.maxFrames);

      for (let i = 0; i < wanted.length; i++) {
        report('frames', '正在整理 iframe…', i, wanted.length);
        const frameId = wanted[i];
        const node = tree.byId.get(frameId);
        const result = await collectFrame(context, frameId);
        if (result.ok) {
          result.parentFrameId = node ? node.parentFrameId : -1;
          collected.push(result);
        }
        // 采不到的框架不在这里计数：装配阶段会以"父文档里的描述符"为准统一统计，
        // 否则一个失败的 iframe 会被算两次
      }
      report('frames', '正在整理 iframe…', wanted.length, wanted.length);
    }

    for (const frame of collected) {
      if (!frame.stats) continue;
      if (Number.isFinite(frame.stats.scripts)) stats.scriptsRemoved += frame.stats.scripts;
      if (Number.isFinite(frame.stats.canvas)) stats.canvas = (stats.canvas || 0) + frame.stats.canvas;
    }

    /* ---------------- 3. 样式闭包 ---------------- */
    const allResources = [];
    for (const frame of collected) {
      const list = Array.isArray(frame.resources) ? frame.resources : [];
      for (const resource of list) {
        allResources.push({
          frameId: frame.frameId,
          token: frame.token || '',
          index: Number(resource.index),
          kind: resource.kind,
          url: typeof resource.url === 'string' ? resource.url : '',
          base: typeof resource.base === 'string' ? resource.base : (frame.base || pageUrl),
          context: resource.context || 'attribute',
          text: typeof resource.text === 'string' ? resource.text : ''
        });
      }
    }
    stats.resources = allResources.length;

    const cache = createResourceCache({ deps: deps, pageUrl: pageUrl, options: options, limits: limits, stats: stats, skip: skip });
    const cssValues = new Map(); // `${frameId}:${index}` -> 最终 CSS 文本

    const cssResources = allResources.filter((resource) => resource.kind === 'css-link' || resource.kind === 'css-text');
    if (cssResources.length > 0) {
      report('css', '正在内联样式表…', 0, cssResources.length);
      for (let i = 0; i < cssResources.length; i++) {
        const resource = cssResources[i];
        report('css', '正在内联样式表…', i, cssResources.length);
        let cssText = '';
        if (resource.kind === 'css-text') {
          cssText = await cache.processCss(resource.text, resource.base, 0);
        } else {
          const loaded = await cache.loadCss(resource.url);
          if (!loaded.ok) {
            skip(resource.url, loaded.error || 'FETCH_FAILED');
          } else {
            cssText = await cache.processCss(loaded.text, loaded.url || resource.url, 0);
          }
        }
        stats.styles++;
        cssValues.set(resource.frameId + ':' + resource.index,
          resource.context === 'css-attribute' ? escapeHtmlAttr(cssText) : escapeStyleText(cssText));
      }
      report('css', '正在内联样式表…', cssResources.length, cssResources.length);
    }

    /* ---------------- 4. 二进制资源 ---------------- */
    const binaryResources = allResources.filter((resource) => resource.kind === 'binary');
    const pendingUrls = [];
    const seen = new Set();
    for (const resource of binaryResources) {
      if (!resource.url || seen.has(resource.url)) continue;
      seen.add(resource.url);
      pendingUrls.push(resource.url);
    }

    if (pendingUrls.length > 0 && options.inlineImages) {
      report('resources', '正在内联资源…', 0, pendingUrls.length);
      let done = 0;
      for (const batch of chunk(pendingUrls, BINARY_BATCH)) {
        await cache.inlineBinaryBatch(batch);
        done += batch.length;
        report('resources', '正在内联资源…', Math.min(done, pendingUrls.length), pendingUrls.length);
      }
    } else if (pendingUrls.length > 0) {
      // 用户关了"内联图片"：保留在线地址即可，不需要抓
      for (const url of pendingUrls) cache.markExternal(url);
    }

    stats.bytesUsed = cache.bytesUsed();

    /* ---------------- 5. 装配 ---------------- */
    report('assemble', '正在拼装单文件…');
    const frameValues = new Map();
    for (const frame of collected) {
      const values = [];
      const list = Array.isArray(frame.resources) ? frame.resources : [];
      for (const resource of list) {
        const index = Number(resource.index);
        if (resource.kind === 'css-link' || resource.kind === 'css-text') {
          values[index] = cssValues.get(frame.frameId + ':' + index) || '';
          continue;
        }
        const url = typeof resource.url === 'string' ? resource.url : '';
        const inlined = cache.valueFor(url);
        values[index] = inlined != null ? inlined : escapeHtmlAttr(url);
      }
      frameValues.set(frame.frameId, values);
    }

    const assembly = planFrameAssembly(collected);
    const collectedById = new Map(collected.map((frame) => [frame.frameId, frame]));
    const claimed = new Set([0]);

    // 从最深开始：先把子文档塞进父文档，父文档再整体作为属性值被更上一层转义
    for (const frameId of assembly.order) {
      const frame = collectedById.get(frameId);
      if (!frame) continue;
      let html = typeof frame.html === 'string' ? frame.html : '';
      const descriptors = Array.isArray(frame.frames) ? frame.frames : [];

      for (const descriptor of descriptors) {
        const wanted = normalizeFrameUrl(descriptor.src);
        const child = collected.find((candidate) => {
          if (candidate.frameId === frameId || claimed.has(candidate.frameId)) return false;
          if (candidate.parentFrameId !== frame.frameId) return false;
          return normalizeFrameUrl(candidate.url || '') === wanted;
        });

        if (child && typeof child.html === 'string') {
          html = embedChildFrame(html, frame.token, Number(descriptor.index), child.html);
          claimed.add(child.frameId);
          stats.frames++;
        } else {
          html = revertFramePlaceholder(html, frame.token, Number(descriptor.index), descriptor.src);
          frameSkipped++;
        }
      }

      const values = frameValues.get(frameId) || [];
      html = replacePlaceholders(html, frame.token, (index) => (values[index] == null ? '' : values[index]));
      frame.html = html;
    }

    const finalHtml = (collectedById.get(0) || top).html || '';
    const createdAt = new Date(deps.now ? deps.now() : Date.now());
    const document_ = buildArchiveDocument({
      html: finalHtml,
      sourceUrl: pageUrl,
      createdAt: createdAt.toISOString(),
      generator: 'ResourceHelper'
    });

    /* ---------------- 6. 落盘 ---------------- */
    report('download', '正在写入文件…', 0, 1);
    const title = (top.title || '').trim() || '网页快照';
    const filename = archiveFilename({
      title: title,
      site: hostOf(pageUrl),
      template: settings.filenameTemplate,
      date: createdAt.toISOString().slice(0, 10).replace(/-/g, '')
    });
    const blob = new Blob([document_], { type: 'text/html;charset=utf-8' });
    const downloadId = await deps.finalize({
      blob: blob,
      filename: filename,
      meta: {
        title: title,
        url: pageUrl,
        mode: 'page',
        site: hostOf(pageUrl),
        size: blob.size
      }
    });

    report('download', '已保存', 1, 1);

    return {
      ok: true,
      filename: filename,
      bytes: blob.size,
      downloadId: downloadId,
      stats: Object.assign({}, stats, { framesFailed: frameSkipped }),
      skipped: stats.skips.slice(0, 20),
      frames: { collected: collected.length - 1, failed: frameSkipped }
    };
  } catch (error) {
    return {
      ok: false,
      error: 'ARCHIVE_FAILED',
      message: (error && error.message) || String(error)
    };
  }
}

function skipMessage(code) {
  switch (String(code || '')) {
    case 'NO_RECEIVER': return '页面没有响应内容脚本，可能是浏览器内部页面或扩展刚更新（刷新后再试）';
    case 'NOT_HTML': return '当前文档不是 HTML，无法整页归档';
    case 'MUTATING': return '页面在保存过程中变化，请重试';
    default: return '页面采集失败';
  }
}

/* ------------------------------------------------------------------ *
 * 资源缓存 / CSS 闭包
 * ------------------------------------------------------------------ */

function createResourceCache(input) {
  const opts = input || {};
  const deps = opts.deps;
  const pageUrl = opts.pageUrl || '';
  const options = opts.options || {};
  const limits = opts.limits || {};
  const stats = opts.stats;
  const skip = opts.skip || (() => {});

  /** url -> { ok, value, bytes, error } —— value 是 data URI 或原始绝对地址 */
  const binary = new Map();
  /** url -> { ok, text, url, error } 样式表正文 */
  const css = new Map();
  let bytesUsed = 0;

  const maxPerResource = Number(limits.maxResourceBytes) || 4 * 1024 * 1024;
  const maxTotal = Number(limits.maxTotalBytes) || 40 * 1024 * 1024;
  const maxResources = Number(limits.maxResources) || 400;
  const maxCss = Number(limits.maxCssResources) || 60;
  const maxCssDepth = Number(limits.maxCssDepth) || 3;

  function budgetLeft() {
    return bytesUsed < maxTotal;
  }

  /**
   * 这条资源实际占多少字节。
   *
   * 后台会给 bytes；万一没给（自造数据源、或头部缺 Content-Length 且没记账），
   * 就按 base64 长度反推 —— 预检与记账必须用同一个口径，否则"预算"只是摆设：
   * 预检看到 0 字节就会把所有大图都放进来。
   */
  function payloadSize(result) {
    const bytes = Number(result && result.bytes);
    if (Number.isFinite(bytes) && bytes > 0) return bytes;
    const base64 = result && typeof result.base64 === 'string' ? result.base64 : '';
    return base64 ? Math.floor((base64.length * 3) / 4) : 0;
  }

  function storeBinary(url, result) {
    if (!result || !result.ok) {
      const reason = result && result.error === 'TOO_LARGE' ? 'TOO_LARGE'
        : result && result.error === 'UNSUPPORTED_SCHEME' ? 'SCHEME'
          : 'FETCH_FAILED';
      skip(url, reason);
      binary.set(url, { ok: false, error: reason });
      return url;
    }
    const base64 = typeof result.base64 === 'string' ? result.base64 : '';
    if (!base64) {
      // 200 但身体是空的：写成 data:image/png;base64, 会得到一个"坏图"，
      // 不如退回在线地址，至少联网时还能显示
      skip(url, 'NO_CONTENT');
      binary.set(url, { ok: false, error: 'NO_CONTENT' });
      return url;
    }
    // 后台会给 bytes；万一没给，按 base64 长度反推 —— 口径必须与预检一致
    const size = payloadSize(result);
    bytesUsed += size;
    const value = dataUrlFor(result.mime || guessMimeFromUrl(url), base64);
    binary.set(url, { ok: true, value: value, bytes: size });
    stats.binaryCount++;
    const bucket = classifyResource(url);
    if (bucket === 'font') stats.fonts++;
    else if (bucket === 'image') stats.images++;
    else stats.other++;
    return value;
  }

  async function inlineBinaryBatch(urls) {
    const list = Array.isArray(urls) ? urls : [];
    const missing = [];
    for (const url of list) {
      if (!url || binary.has(url)) continue;
      if (!options.inlineImages) { binary.set(url, { ok: false, error: 'DISABLED' }); continue; }
      if (stats.binaryCount + missing.length >= maxResources) {
        skip(url, 'COUNT');
        binary.set(url, { ok: false, error: 'COUNT' });
        continue;
      }
      if (!budgetLeft()) {
        skip(url, 'BUDGET');
        binary.set(url, { ok: false, error: 'BUDGET' });
        continue;
      }
      missing.push(url);
    }

    // 一批不要发太大：单个资源上限 4 MiB，一条消息里塞 50 张图会让结构化克隆卡住侧边栏
    for (const batch of chunk(missing, BINARY_BATCH)) {
      let results = [];
      try {
        results = await deps.fetchResources(
          batch.map((url) => ({ url: url, kind: 'binary' })),
          { pageUrl: pageUrl, maxBytes: maxPerResource }
        );
      } catch (error) {
        results = [];
      }

      for (let i = 0; i < batch.length; i++) {
        const url = batch[i];
        const result = results && results[i];
        if (!result) {
          skip(url, 'FETCH_FAILED');
          binary.set(url, { ok: false, error: 'FETCH_FAILED' });
          continue;
        }
        if (result.ok && bytesUsed + payloadSize(result) > maxTotal) {
          skip(url, 'BUDGET');
          binary.set(url, { ok: false, error: 'BUDGET' });
          continue;
        }
        storeBinary(url, result);
      }
    }
  }

  async function loadCss(url) {
    if (css.has(url)) return css.get(url);
    if (stats.cssCount >= maxCss) {
      const full = { ok: false, error: 'COUNT', url: url };
      css.set(url, full);
      return full;
    }
    stats.cssCount++;
    let result;
    try {
      const results = await deps.fetchResources([{ url: url, kind: 'css' }], { pageUrl: pageUrl, maxBytes: maxPerResource });
      result = results && results[0];
    } catch (error) {
      result = null;
    }
    const entry = result && result.ok
      ? { ok: true, text: String(result.text || ''), url: result.finalUrl || url }
      : { ok: false, error: (result && result.error) || 'FETCH_FAILED', url: url };
    css.set(url, entry);
    return entry;
  }

  /** 把一个 CSS 文本里的引用全部就地解决（url() 内联，@import 展开） */
  async function processCss(text, baseUrl, depth) {
    const source = typeof text === 'string' ? text : '';
    const references = scanCssReferences(source);
    if (references.length === 0) return source;

    const replacements = new Map();

    const urlRefs = [];
    for (const ref of references) {
      if (ref.kind !== 'url') continue;
      const normalized = normalizeResourceUrl(ref.value, baseUrl);
      if (!normalized.ok) continue;
      urlRefs.push({ ref: ref, url: normalized.url });
    }

    if (urlRefs.length > 0) {
      const wanted = Array.from(new Set(urlRefs.map((item) => item.url)));
      await inlineBinaryBatch(wanted);
      for (const item of urlRefs) {
        const hit = binary.get(item.url);
        const value = hit && hit.ok ? hit.value : item.url;
        replacements.set(item.ref, cssUrlRef(value));
      }
    }

    for (const ref of references) {
      if (ref.kind !== 'import') continue;
      const normalized = normalizeResourceUrl(ref.value, baseUrl);
      if (!normalized.ok) continue;
      if (depth + 1 > maxCssDepth || stats.cssCount >= maxCss) {
        replacements.set(ref, cssImportRef(normalized.url, ref.media));
        continue;
      }
      const loaded = await loadCss(normalized.url);
      if (!loaded.ok) {
        skip(normalized.url, loaded.error === 'COUNT' ? 'COUNT' : 'FETCH_FAILED');
        replacements.set(ref, cssImportRef(normalized.url, ref.media));
        continue;
      }
      const nested = await processCss(loaded.text, loaded.url || normalized.url, depth + 1);
      replacements.set(ref, ref.media ? '@media ' + ref.media + ' {\n' + nested + '\n}' : nested);
    }

    return applyCssReferences(source, references, (ref) => {
      return replacements.has(ref) ? replacements.get(ref) : null;
    }).css;
  }

  /** 样式表里出现过、但 HTML 里没有的地址（例如 @font-face 的字体） */
  return {
    inlineBinaryBatch: inlineBinaryBatch,
    loadCss: loadCss,
    processCss: processCss,
    valueFor(url) {
      const hit = binary.get(url);
      if (!hit) return null;
      return hit.ok ? hit.value : escapeHtmlAttr(url);
    },
    markExternal(url) {
      binary.set(url, { ok: false, error: 'DISABLED' });
    },
    bytesUsed() {
      return bytesUsed;
    }
  };
}
