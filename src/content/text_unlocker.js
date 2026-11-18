/**
 * Universal Text Unlocker & Semantic Content Extractor
 * Neutralizes anti-copy mechanisms (events, CSS user-select, transparent masks)
 * and extracts structured Markdown articles from complex DOM / Shadow DOM structures.
 *
 * 两个世界分工（AUDIT F5）：
 *   · 隔离世界（本文件）：CSS、捕获阶段的事件拦截、DOM 内联属性清理、正文提取；
 *   · 主世界（page_hooks.js）：window / document 上由页面 JS 挂的事件处理器属性。
 * 两者用 window.postMessage 通信。绝不创建 <script> 节点——严格 CSP 的站点
 * （script-src 'self' 且无 unsafe-inline）会直接拦掉，解锁会静默失效。
 */
(function initTextUnlocker() {
  // 版本化守卫：扩展升级后重新注入时要能覆盖旧实例，否则老标签页永远拿不到新能力
  const VERSION = 2;
  if ((window.__snifferTextUnlockerVersion || 0) >= VERSION) return;
  window.__snifferTextUnlockerVersion = VERSION;
  window.__snifferTextUnlockerInitialized = true;

  let isCurrentlyUnlocked = false;
  let mutationObserver = null;

  const STYLE_ID = '__sniffer_universal_unlock_css__';

  function applyUnlockStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        *, *::before, *::after, html, body, div, p, span, article, section, pre, code, blockquote, table, tr, td, th {
          -webkit-user-select: text !important;
          -moz-user-select: text !important;
          -ms-user-select: text !important;
          user-select: text !important;
          pointer-events: auto !important;
        }
        ::selection {
          background-color: rgba(56, 189, 248, 0.4) !important;
          color: inherit !important;
        }
        ::-moz-selection {
          background-color: rgba(56, 189, 248, 0.4) !important;
          color: inherit !important;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }
  }

  function suppressDefensiveEvents() {
    const blockedEvents = ['cut', 'contextmenu', 'selectstart', 'selectionchange', 'dragstart'];

    // 复制走自己的处理器：先把私用区码位换成真字（若已拿到字体映射），
    // 再把事件吞掉，避免页面把剪贴板改回乱码或塞广告尾巴。
    const copyHandler = (e) => {
      if (copyMap.size) {
        try {
          const selection = window.getSelection();
          const raw = selection ? String(selection) : '';
          if (raw && hasPrivateUse(raw) && e.clipboardData) {
            e.clipboardData.setData('text/plain', applyCopyMap(raw));
            e.preventDefault();
          }
        } catch (err) {}
      }
      e.stopImmediatePropagation();
    };

    window.addEventListener('copy', copyHandler, true);
    document.addEventListener('copy', copyHandler, true);
    window.addEventListener('beforecopy', copyHandler, true);
    document.addEventListener('beforecopy', copyHandler, true);

    const eventHandler = (e) => {
      e.stopImmediatePropagation();
    };

    blockedEvents.forEach((evtName) => {
      window.addEventListener(evtName, eventHandler, true);
      document.addEventListener(evtName, eventHandler, true);
    });

    // Neutralize keyboard restrictions (e.g. blocking Ctrl+C, Ctrl+A, F12)
    const keyHandler = (e) => {
      if ((e.ctrlKey || e.metaKey) && ['c', 'a', 'x', 'u', 's'].includes(e.key.toLowerCase())) {
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', keyHandler, true);
    document.addEventListener('keydown', keyHandler, true);
  }

  /**
   * DOM 内联属性（<body oncopy="return false">）由隔离世界清就行：属性是共享的 DOM，
   * 但 window / document 上由页面 JS 赋值的处理器只存在于主世界，那边单独处理。
   */
  function clearInlineHandlers(rootNode = document) {
    const props = ['oncopy', 'oncut', 'oncontextmenu', 'onselectstart', 'ondragstart', 'onkeydown', 'onkeyup'];
    props.forEach((prop) => {
      try {
        if (rootNode[prop] !== undefined) rootNode[prop] = null;
        if (document[prop] !== undefined) document[prop] = null;
        if (document.body && document.body[prop] !== undefined) document.body[prop] = null;
        if (window[prop] !== undefined) window[prop] = null;
      } catch (e) {}
    });
  }

  function removeTransparentMasks() {
    document.querySelectorAll('div, section').forEach((el) => {
      const style = window.getComputedStyle(el);
      const zIndex = parseInt(style.zIndex, 10);
      if (zIndex > 100 && (style.opacity === '0' || style.backgroundColor === 'transparent' || style.backgroundColor === 'rgba(0, 0, 0, 0)')) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 200 && rect.height > 200) {
          el.style.pointerEvents = 'none';
        }
      }
    });
  }

  // 主世界的握手标记，必须与 page_hooks.js 里的 MARK 保持一致
  const MAIN_WORLD_MARK = '__resourceHelperHooks';

  /**
   * 请求主世界清掉复制拦截（AUDIT F5）。
   *
   * 以前这里插入一个内联 <script>，在 script-src 'self' 的站点上会被 CSP 直接拦掉：
   * "Executing inline script violates the following Content Security Policy directive"。
   * 现在改为给已经声明在 MAIN world 的 page_hooks.js 发一条指令：不造脚本节点，
   * 也就没有 CSP 这回事。
   */
  function requestMainWorldUnlock() {
    try {
      window.postMessage({ [MAIN_WORLD_MARK]: 'cmd', action: 'unlock-text' }, '*');
    } catch (e) {}
  }

  function forceUnlockAll() {
    applyUnlockStyles();
    suppressDefensiveEvents();
    clearInlineHandlers();
    removeTransparentMasks();
    requestMainWorldUnlock();

    if (!mutationObserver) {
      mutationObserver = new MutationObserver((records) => {
        applyUnlockStyles();
        clearInlineHandlers();
        // 页面可能把 oncopy 这类内联属性又挂回来；只有这类变化才值得再敲一次主世界，
        // style/class 的高频变动不应该产生额外消息。
        const handlerChanged = (records || []).some((record) =>
          record.type === 'attributes' && String(record.attributeName || '').startsWith('on')
        );
        if (handlerChanged) requestMainWorldUnlock();
      });
      mutationObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'class', 'oncopy', 'oncontextmenu', 'onselectstart'],
        childList: true,
        subtree: true
      });
    }

    isCurrentlyUnlocked = true;
    return true;
  }

  // === 字体反爬：私用区码位 + 自绘字体 ===
  //
  // 这类站点不去禁用复制，而是把常用字换成私用区码位（U+E000–U+F8FF），
  // 再挂一份随机命名的子集字体把码位画成真字。页面上看着正常，复制出来的
  // 却是普通字体里没有字形的码位——所以"解禁"永远治不好它，只能换字。
  let copyMap = new Map();

  function isPrivateUse(cp) {
    return (cp >= 0xE000 && cp <= 0xF8FF)
      || (cp >= 0xF0000 && cp <= 0xFFFFD)
      || (cp >= 0x100000 && cp <= 0x10FFFD);
  }

  function collectPrivateUse(text) {
    const distinct = new Set();
    let total = 0;
    for (const ch of String(text || '')) {
      const cp = ch.codePointAt(0);
      if (!isPrivateUse(cp)) continue;
      total++;
      distinct.add(ch);
    }
    return { total, distinct: [...distinct] };
  }

  function hasPrivateUse(text) {
    for (const ch of String(text || '')) {
      if (isPrivateUse(ch.codePointAt(0))) return true;
    }
    return false;
  }

  function applyCopyMap(text) {
    let out = '';
    for (const ch of String(text || '')) {
      out += copyMap.get(ch.codePointAt(0)) || ch;
    }
    return out;
  }

  /** 侧边栏解码成功后把映射推下来，页面里的 Ctrl+C 才能直接拿到真字 */
  function installCopyMap(entries) {
    const next = new Map();
    for (const item of entries || []) {
      if (Array.isArray(item) && typeof item[0] === 'number' && typeof item[1] === 'string') {
        next.set(item[0], item[1]);
      }
    }
    copyMap = next;
    return copyMap.size;
  }

  function extractFontUrls(srcText) {
    const urls = [];
    const re = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
    const base = (document.baseURI || location.href || '');
    let match;
    while ((match = re.exec(srcText))) {
      const raw = match[1].trim();
      if (!raw || /^data:/i.test(raw)) continue;
      // 浏览器里没有 brotli 解压接口，woff2 解析不了；其余都要
      if (/\.woff2(\?|#|$)/i.test(raw)) continue;
      // 侧边栏要按扩展自身的地址去取，所以这里必须先补成绝对地址
      let url = raw;
      try {
        url = new URL(raw, base).href;
      } catch (err) {
        continue;
      }
      if (!/^https?:/i.test(url) && !/^chrome-extension:/i.test(url)) continue;
      urls.push(url);
    }
    const rank = (u) => (/\.otf(\?|#|$)/i.test(u) ? 0
      : /\.ttf(\?|#|$)/i.test(u) ? 1
      : /\.woff(\?|#|$)/i.test(u) ? 2 : 3);
    return urls.sort((a, b) => rank(a) - rank(b) || a.length - b.length).slice(0, 6);
  }

  function collectFontFaces() {
    const faces = new Map();
    const remember = (family, srcText) => {
      if (!family || !srcText) return;
      const key = String(family).replace(/^["']|["']$/g, '').trim();
      if (!key) return;
      const urls = extractFontUrls(srcText);
      if (!urls.length) return;
      const list = faces.get(key) || [];
      for (const url of urls) if (!list.includes(url)) list.push(url);
      faces.set(key, list);
    };
    for (const sheet of Array.from(document.styleSheets || [])) {
      let rules = null;
      try {
        rules = sheet.cssRules;
      } catch (err) {
        // 跨域样式表读不到规则，交给下面的兜底
        rules = null;
      }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (!rule || !rule.style || typeof rule.style.getPropertyValue !== 'function') continue;
        remember(rule.style.getPropertyValue('font-family'), rule.style.getPropertyValue('src'));
      }
    }
    return faces;
  }

  /**
   * 找出正文实际用的那份自绘字体。
   * family 名是随机的（如 DNMrHsV173Pd4pgy），不能按名字猜，
   * 只能：定位含私用区字符的文本节点 → 读它的 computed font-family → 对回 @font-face。
   */
  function findObfuscationFont() {
    const faces = collectFontFaces();
    if (!faces.size) return null;
    const root = document.body || document.documentElement;
    if (!root || !document.createTreeWalker) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node = walker.nextNode();
    let visited = 0;
    while (node && visited < 5000) {
      visited++;
      if (node.nodeValue && hasPrivateUse(node.nodeValue)) {
        const el = node.parentElement;
        if (el) {
          const families = (window.getComputedStyle(el).fontFamily || '')
            .split(',')
            .map((item) => item.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
          for (const family of families) {
            const urls = faces.get(family);
            if (urls && urls.length) return { family, urls };
          }
        }
      }
      node = walker.nextNode();
    }
    if (faces.size === 1) {
      const [family] = faces.keys();
      return { family, urls: faces.get(family) };
    }
    return null;
  }

  // === Semantic Content Extractor ===
  function extractSemanticContent() {
    let title = (document.title || '提取文档').trim();
    // Clean common site suffixes from title
    title = title.replace(/\s*[-_—|]\s*(知乎|百度百科|CSDN|简书|掘金|微信公众平台|哔哩哔哩|搜狐|新浪|腾讯网).*$/i, '');

    // Identify best candidate container
    const candidateSelectors = [
      'article',
      '[class*="article-content"]',
      '[class*="post-content"]',
      '[class*="entry-content"]',
      '[class*="main-content"]',
      '[class*="rich_media_content"]', // WeChat articles
      '.article',
      '.content',
      'main'
    ];

    let bestElement = null;
    let maxScore = 0;

    candidateSelectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        const text = el.innerText || '';
        const len = text.length;
        const pCount = el.querySelectorAll('p').length;
        const linkCount = el.querySelectorAll('a').length;
        // Score formula: rewards paragraph count and text length, penalizes excessive link density
        const score = len + pCount * 80 - linkCount * 40;
        if (score > maxScore && len > 150) {
          maxScore = score;
          bestElement = el;
        }
      });
    });

    if (!bestElement) {
      bestElement = document.body;
    }

    // Traverse and format to Markdown
    const blocks = [];
    const visitedNodes = new Set();

    function traverse(node) {
      if (!node || visitedNodes.has(node)) return;
      visitedNodes.add(node);

      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node;
        const tag = el.tagName.toLowerCase();

        // Exclude unwanted segments
        if (['script', 'style', 'noscript', 'iframe', 'svg', 'nav', 'footer', 'aside'].includes(tag)) return;
        if (el.closest('nav, footer, aside, .comment, .sidebar, .ad, .advertisement')) return;

        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;

        // Handle Shadow DOM if encapsulated
        if (el.shadowRoot) {
          traverse(el.shadowRoot);
        }

        if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
          const level = tag[1];
          const prefix = '#'.repeat(parseInt(level, 10));
          const text = el.innerText.trim();
          if (text) blocks.push(`${prefix} ${text}\n`);
          return;
        }

        if (tag === 'pre') {
          const codeText = el.innerText.trim();
          if (codeText) blocks.push(`\`\`\`\n${codeText}\n\`\`\`\n`);
          return;
        }

        if (tag === 'blockquote') {
          const quoteText = el.innerText.trim();
          if (quoteText) blocks.push(`> ${quoteText.replace(/\n/g, '\n> ')}\n`);
          return;
        }

        if (tag === 'li') {
          const liText = el.innerText.trim();
          if (liText) blocks.push(`- ${liText}`);
          return;
        }

        if (tag === 'p') {
          const pText = el.innerText.trim();
          if (pText) blocks.push(`${pText}\n`);
          return;
        }

        // Continue downwards
        for (let i = 0; i < el.childNodes.length; i++) {
          traverse(el.childNodes[i]);
        }
      } else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        for (let i = 0; i < node.childNodes.length; i++) {
          traverse(node.childNodes[i]);
        }
      }
    }

    traverse(bestElement);

    const finalMarkdown = blocks.join('\n\n').trim();
    return {
      title: title,
      content: finalMarkdown,
      charCount: finalMarkdown.length
    };
  }

  // Message listener for Side Panel commands
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || !request.type) return false;

    if (request.type === 'SNIFFER_UNLOCK_TEXT') {
      const ok = forceUnlockAll();
      sendResponse({ success: ok, unlocked: true });
      return true;
    }

    if (request.type === 'SNIFFER_GET_UNLOCK_STATUS') {
      sendResponse({ success: true, unlocked: isCurrentlyUnlocked });
      return true;
    }

    if (request.type === 'SNIFFER_EXTRACT_CONTENT' || request.type === 'SNIFFER_EXTRACT_CONTENT_V2') {
      const data = extractSemanticContent();
      const pua = collectPrivateUse(data.content);
      sendResponse({
        success: true,
        ...data,
        pua: { total: pua.total, distinct: pua.distinct.length },
        font: pua.total ? findObfuscationFont() : null,
        copyMapSize: copyMap.size,
        unlockerVersion: VERSION
      });
      return true;
    }

    if (request.type === 'SNIFFER_SET_COPY_MAP') {
      const size = installCopyMap(request.mappings);
      sendResponse({ success: size > 0, size });
      return true;
    }

    return false;
  });

  console.log('[Sniffer Text Unlocker] Content script initialized on', window.location.hostname);
})();
