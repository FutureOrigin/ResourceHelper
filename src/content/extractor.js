/**
 * Universal Image & Deep Resource Extractor Content Script
 * Handles DOM scanning, Shadow DOM recursion, CSS background-image extraction,
 * and PerformanceObserver dynamic network request sniffing.
 */
(function initResourceExtractor() {
  if (window.__snifferExtractorInitialized) return;
  window.__snifferExtractorInitialized = true;

  const dynamicNetworkImages = new Set();

  // Setup PerformanceObserver to capture images loaded dynamically via fetch/xhr/tags
  try {
    if (typeof PerformanceObserver !== 'undefined') {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const name = entry.name;
          if (!name || typeof name !== 'string') continue;

          const initiator = entry.initiatorType;
          const isImgInitiator = initiator === 'img' || initiator === 'css' || initiator === 'image';
          const isImgExt = /\.(jpg|jpeg|png|webp|gif|avif|svg|bmp)(\?.*)?$/i.test(name);
          const isImgQuery = /[?&](format|fmt|wx_fmt)=(jpg|jpeg|png|webp|gif)/i.test(name);

          if (isImgInitiator || isImgExt || isImgQuery) {
            if (!name.startsWith('data:') && name.length > 5) {
              dynamicNetworkImages.add(name);
            }
          }
        }
      });
      observer.observe({ type: 'resource', buffered: true });
    }
  } catch (e) {
    console.warn('[Sniffer Extractor] PerformanceObserver error:', e);
  }

  function normalizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const trimmed = rawUrl.trim();
    if (trimmed.startsWith('data:image/svg') || trimmed.length < 5) return null;
    try {
      const resolved = new URL(trimmed, window.location.href).href;
      return resolved;
    } catch (e) {
      return null;
    }
  }

  function addCandidate(resultsMap, rawUrl, width, height, alt, meta) {
    const url = normalizeUrl(rawUrl);
    if (!url) return;
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    const existing = resultsMap.get(url);
    if (!existing) {
      resultsMap.set(url, {
        src: url,
        width: w,
        height: h,
        alt: (alt || '').slice(0, 100),
        fromStylesheet: Boolean(meta && meta.fromStylesheet),
        fromNetwork: Boolean(meta && meta.fromNetwork),
        fromSrcsetMax: Boolean(meta && meta.fromSrcsetMax)
      });
      return;
    }
    if (w > existing.width) existing.width = w;
    if (h > existing.height) existing.height = h;
    if (alt && !existing.alt) existing.alt = alt.slice(0, 100);
    if (meta && meta.fromSrcsetMax) existing.fromSrcsetMax = true;
    if (meta && meta.fromNetwork) existing.fromNetwork = true;
  }

  /** 解析 srcset，返回按描述符降序的候选（最大的在最前） */
  function parseSrcsetValue(value) {
    if (!value) return [];
    return String(value)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part, index) => {
        const pieces = part.split(/\s+/);
        const descriptor = pieces[1] || '';
        const width = descriptor.endsWith('w') ? Number.parseInt(descriptor, 10) : 0;
        const density = descriptor.endsWith('x') ? Number.parseFloat(descriptor) : 0;
        return { url: pieces[0], width: width, density: density, index: index };
      })
      .sort((a, b) => (b.width - a.width) || (b.density - a.density));
  }

  /**
   * 从样式表里收集背景图（零布局成本）。
   * 旧实现对每个 div/section/article/header/a/figure 调一次 getComputedStyle，
   * 在几千个节点的页面上会强制样式重算，单次扫描数百毫秒（AUDIT E4）。
   */
  function collectStylesheetUrls(resultsMap) {
    let sheets = [];
    try {
      sheets = Array.from(document.styleSheets || []);
    } catch (e) {
      return;
    }
    for (const sheet of sheets) {
      let rules;
      try {
        rules = sheet && sheet.cssRules;
      } catch (e) {
        continue; // 跨域样式表读取会抛安全错误，跳过
      }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        const text = rule && rule.cssText;
        if (!text || text.indexOf('url(') === -1) continue;
        const pattern = /url\((["']?)([^"')]+)\1\)/g;
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const raw = match[2];
          if (!raw || raw.startsWith('data:')) continue;
          addCandidate(resultsMap, raw, 0, 0, '', { fromStylesheet: true });
        }
      }
    }
  }

  function scanNodeImages(rootNode, resultsMap) {
    if (!rootNode || !rootNode.querySelectorAll) return;

    // 1. <img>（含懒加载属性与 srcset）
    rootNode.querySelectorAll('img').forEach((img) => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      const alt = img.alt || img.title || '';

      [img.currentSrc, img.src, img.getAttribute('data-src'), img.getAttribute('data-original'),
        img.getAttribute('data-url'), img.getAttribute('data-lazy-src'), img.getAttribute('data-actualsrc')]
        .forEach((src) => { if (src) addCandidate(resultsMap, src, w, h, alt); });

      const srcset = img.srcset || img.getAttribute('data-srcset');
      const candidates = parseSrcsetValue(srcset);
      candidates.forEach((candidate, index) => {
        addCandidate(resultsMap, candidate.url, w, h, alt, { fromSrcsetMax: index === 0 && candidates.length > 1 });
      });
    });

    // 2. <picture><source>
    rootNode.querySelectorAll('picture source').forEach((source) => {
      const candidates = parseSrcsetValue(source.srcset || source.getAttribute('data-srcset'));
      candidates.forEach((candidate, index) => {
        addCandidate(resultsMap, candidate.url, 0, 0, '', { fromSrcsetMax: index === 0 && candidates.length > 1 });
      });
    });

    // 3. SVG <image>
    rootNode.querySelectorAll('svg image').forEach((svgImg) => {
      const href = svgImg.getAttribute('href') || svgImg.getAttribute('xlink:href');
      if (href) addCandidate(resultsMap, href, 0, 0, '');
    });

    // 4. 视频封面
    rootNode.querySelectorAll('video[poster]').forEach((video) => {
      const poster = video.getAttribute('poster');
      if (poster) addCandidate(resultsMap, poster, 0, 0, '视频封面');
    });

    // 5. OpenGraph / Twitter 卡片
    if (rootNode === document) {
      document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]')
        .forEach((meta) => {
          const content = meta.getAttribute('content');
          if (content) addCandidate(resultsMap, content, 0, 0, '网页封面大图');
        });
    }

    // 6. 内联 style 上的背景图（只查带 background 的元素，代价极低）
    rootNode.querySelectorAll('[style*="background"]').forEach((node) => {
      const styleText = node.getAttribute('style') || '';
      const pattern = /url\((["']?)([^"')]+)\1\)/g;
      let match;
      while ((match = pattern.exec(styleText)) !== null) {
        if (!match[2] || match[2].startsWith('data:')) continue;
        const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : { width: 0, height: 0 };
        addCandidate(resultsMap, match[2], Math.round(rect.width), Math.round(rect.height), '');
      }
    });

    // 7. 递归穿透 Shadow DOM
    rootNode.querySelectorAll('*').forEach((node) => {
      if (node.shadowRoot) scanNodeImages(node.shadowRoot, resultsMap);
    });
  }

  /** 评分：已知尺寸的优先，其次动态网络图，最后只有样式表里出现过的 */
  function candidateRank(item) {
    const area = (item.width || 0) * (item.height || 0);
    const known = area > 0 ? 1 : 0;
    const network = item.fromNetwork ? 1 : 0;
    return known * 1e12 + network * 1e9 + area;
  }

  function shouldKeepCandidate(item) {
    const w = item.width || 0;
    const h = item.height || 0;
    const minEdge = Number.isFinite(imageMinSize) ? imageMinSize : 100;
    if (w === 1 && h === 1) return false;                      // 1×1 埋点
    if (item.fromNetwork) return true;                          // 动态加载的图，尺寸未知也要
    if (item.fromSrcsetMax) return true;                        // srcset 的最大项
    if (minEdge > 0 && w > 0 && h > 0 && w * h < minEdge * minEdge) return false; // 小图标/表情
    if (w === 0 && h === 0 && item.fromStylesheet) return false; // 只有样式表里的无名 url，噪声太大
    return true;
  }

  function performFullScan() {
    const resultsMap = new Map();

    scanNodeImages(document, resultsMap);
    collectStylesheetUrls(resultsMap);

    for (const netUrl of dynamicNetworkImages) {
      const clean = normalizeUrl(netUrl);
      if (clean && !resultsMap.has(clean)) {
        resultsMap.set(clean, {
          src: clean,
          width: 0,
          height: 0,
          alt: '网络动态资源',
          fromStylesheet: false,
          fromNetwork: true,
          fromSrcsetMax: false
        });
      } else if (clean && resultsMap.has(clean)) {
        resultsMap.get(clean).fromNetwork = true;
      }
    }

    return Array.from(resultsMap.values())
      .filter(shouldKeepCandidate)
      .sort((a, b) => candidateRank(b) - candidateRank(a));
  }

  // Message listener for Side Panel commands
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || !request.type) return false;

    if (request.type === 'SNIFFER_SCAN_IMAGES') {
      const images = performFullScan();
      sendResponse({
        success: true,
        count: images.length,
        images: images
      });
      return true;
    }

    return false;
  });

  
  /* ------------------------------------------------------------------
   * 内联脚本 JSON 解析工具
   *
   * 不能用 /({.+?})/ 这类惰性正则去截取页面内联脚本里的 JSON：
   * 惰性量词会在**第一个** '}' 处就收尾，而 B 站 __playinfo__ 的第一个 '}'
   * 正好出现在第一条视频轨对象的末尾，于是 JSON.parse 抛
   * "Expected ',' or '}' after property value"（位置随视频数据长度浮动）。
   * 这里按括号配对扫描，并跳过字符串内部与转义字符，取出完整对象字面量。
   * ------------------------------------------------------------------ */

  function sliceBalancedJson(text, openIndex) {
    if (typeof text !== 'string' || openIndex < 0 || text[openIndex] !== '{') return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = openIndex; i < text.length; i++) {
      const ch = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === '{' || ch === '[') {
        depth++;
      } else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) return text.slice(openIndex, i + 1);
        if (depth < 0) return null;
      }
    }

    return null; // 脚本被截断（页面还没写完）时返回 null，交给调用方跳过
  }

  /**
   * 解析 `NAME = { ... }` 形式的赋值，失败返回 null。
   * assignPattern 需匹配到对象字面量之前，例如 `__playinfo__\s*=\s*` 这样的赋值前缀；
   * 会对所有匹配点逐个尝试，避免字符串里恰好出现同名标识符时误判。
   */
  function readAssignedJson(scriptText, assignPattern) {
    if (typeof scriptText !== 'string' || !scriptText) return null;

    const flags = assignPattern.flags.indexOf('g') === -1 ? assignPattern.flags + 'g' : assignPattern.flags;
    const pattern = new RegExp(assignPattern.source, flags);

    let assign;
    while ((assign = pattern.exec(scriptText)) !== null) {
      let start = assign.index + assign[0].length;
      while (start < scriptText.length && /\s/.test(scriptText[start])) start++;

      const jsonText = sliceBalancedJson(scriptText, start);
      if (!jsonText) continue;

      try {
        return JSON.parse(jsonText);
      } catch (e) {
        // 该匹配点不是合法 JSON，继续尝试下一个
      }
    }

    return null;
  }

  /**
   * 用"事件 + 防抖"代替定时轮询（AUDIT E6）。
   * 旧实现每 3/6/8 秒无条件跑一次站点扫描，页面开着就一直烧 CPU；
   * 现在只在 DOM 变化 / 前进后退 / 标签页重新可见时才可能触发，且 800ms 合并。
   */
  function watchPageChanges(callback) {
    let timer = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (document.visibilityState === 'hidden') return;
        try {
          callback();
        } catch (e) {
          warnOnce('watch', '[Sniffer Extractor] 页面变化回调失败:', e);
        }
      }, 800);
    };

    try {
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'childList' && record.addedNodes && record.addedNodes.length > 0) return schedule();
          if (record.type === 'attributes') return schedule();
        }
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'content']
      });
    } catch (e) {}

    window.addEventListener('popstate', schedule, { passive: true });
    window.addEventListener('hashchange', schedule, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') schedule();
    });
    return schedule;
  }

  // 同一类错误只提示一次，避免 B 站 SPA 路由切换时刷屏
  // 设置里的"图片最小边长"，默认 100；读取失败不影响扫描
  let imageMinSize = 100;
  try {
    const pending = chrome.runtime.sendMessage({ type: 'RH_GET_SETTINGS' });
    if (pending && typeof pending.then === 'function') {
      pending.then((response) => {
        const value = response && response.settings && response.settings.imageMinSize;
        if (Number.isFinite(value)) imageMinSize = value;
      }).catch(() => {});
    }
  } catch (e) {}

  const warnedKeys = new Set();
  function warnOnce(key, ...args) {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    console.warn(...args);
  }

  /* ------------------------------------------------------------------ *
   * 页面数据采集（P4）
   *
   * 内容脚本只负责"在页面里找到数据"，怎么解释交给后台的声明式适配器。
   * 这样加一个站点只需要写 sites/*.json，不用改这里的代码。
   * ------------------------------------------------------------------ */

  // 需要从内联脚本里捞的全局变量（适配器按名字取用）
  const INLINE_JSON_GLOBALS = ['ytInitialPlayerResponse', '__playinfo__'];

  /** 粗略体量，用来在多个候选中挑"信息最全"的那个 */
  function sizeOfJson(value) {
    try {
      return JSON.stringify(value).length;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 从内联脚本里读出 JSON 赋值（括号配对扫描，避免惰性正则截断）。
   *
   * 同一页往往出现多次同名赋值：先是占位的 {"code":-404}，后面才是完整的播放数据。
   * 这里不猜哪个"看起来对"，而是收集所有候选、取体量最大的——站点无关且稳定。
   */
  function collectInlineJson() {
    const found = {};

    for (const name of INLINE_JSON_GLOBALS) {
      const candidates = [];

      const direct = window[name];
      if (direct && typeof direct === 'object') candidates.push(direct);

      let scripts = [];
      try {
        scripts = Array.from(document.querySelectorAll('script'));
      } catch (e) {
        scripts = [];
      }

      for (const script of scripts) {
        const text = script && script.textContent;
        if (!text || text.length > 8 * 1024 * 1024) continue;
        if (text.indexOf(name) === -1) continue;
        const parsed = readAssignedJson(text, new RegExp(name + '\\s*=\\s*'));
        if (parsed) candidates.push(parsed);
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) => sizeOfJson(b) - sizeOfJson(a));
        found[name] = candidates[0];
      }
    }

    return found;
  }

  /** DOM 里真实存在的媒体元素（通用采集；站点差异交给适配器判断） */
  function collectDomMedia() {
    const list = [];
    const seen = new Set();

    const push = (node, kind) => {
      const src = node.currentSrc || node.src || '';
      if (!src || seen.has(src)) return;
      if (src.startsWith('blob:') || src.startsWith('data:') || src.startsWith('mediasource:')) return;
      seen.add(src);

      const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : { width: 0, height: 0 };
      const path = src.split('#')[0].split('?')[0];
      const match = path.match(/\.([a-zA-Z0-9]{2,5})$/);

      list.push({
        src: src,
        kind: kind,
        ext: match ? match[1].toLowerCase() : '',
        width: Math.round(rect.width || 0),
        height: Math.round(rect.height || 0),
        duration: Number.isFinite(node.duration) ? node.duration : null,
        drm: kind === 'video' ? Boolean(node.mediaKeys || node.webkitKeys) : false
      });
    };

    try {
      document.querySelectorAll('video').forEach((node) => push(node, 'video'));
      document.querySelectorAll('audio').forEach((node) => push(node, 'audio'));
    } catch (e) {}

    return list;
  }

  let lastPageDataSignature = '';

  /**
   * 把"页面里有什么"发给后台。去重靠签名：URL + 标题 + 媒体地址集合 + 是否有内联 JSON。
   * 这样 DOM 抖动不会造成消息风暴，但换了集/换了歌一定会重新上报。
   */
  function publishPageData(force) {
    try {
      const domMedia = collectDomMedia();
      const inline = collectInlineJson();
      const json = inline.ytInitialPlayerResponse || inline.__playinfo__ || null;

      const signature = [
        window.location.href,
        document.title,
        domMedia.map((item) => item.src).join('|'),
        json ? 'json:' + (inline.ytInitialPlayerResponse ? 'yt' : 'bili') : ''
      ].join('::');

      if (!force && signature === lastPageDataSignature) return;
      lastPageDataSignature = signature;

      // 页面里什么都没有时不要白发一条消息（否则每个空白页都会打一次运行时消息）
      if (!json && domMedia.length === 0) return;

      chrome.runtime.sendMessage({
        type: 'ON_PAGE_DATA',
        payload: {
          url: window.location.href,
          title: document.title,
          media: domMedia,
          json: json
        }
      }).catch(() => {});
    } catch (e) {
      warnOnce('page-data', '[Sniffer Extractor] 页面数据采集失败:', e);
    }
  }

  publishPageData(true);
  window.addEventListener('play', () => publishPageData(false), true);
  window.addEventListener('loadedmetadata', () => publishPageData(false), true);
  window.addEventListener('canplay', () => publishPageData(false), true);
  watchPageChanges(() => publishPageData(false));

  console.log('[Sniffer Extractor] Content script initialized on', window.location.hostname);
})();
