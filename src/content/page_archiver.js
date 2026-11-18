/**
 * 整页快照 · 页面侧（P8）
 *
 * 只做 DOM 层面的事：把当前文档克隆一份，把"要内联的地址"换成占位符，
 * 把"离线无意义的东西"（脚本、CSP、refresh 跳转、preload 提示）去掉，
 * 然后把 html 字符串与资源清单交回侧边栏。
 *
 * 这里**不做** CSS 解析、不抓网络、不拼字节：那些都在侧边栏用
 * core/page-archive.js 的纯函数完成，可以单测。内容脚本保持"薄"，
 * 是因为它没有可注入的测试环境，代码越少越不容易腐坏。
 *
 * 内容脚本是经典脚本（不能 import），所以下面这几个小工具是
 * 与 core 层有意重复的最小实现，且只有这几行（占位符格式、绝对化判定）。
 */

(() => {
  if (window.__rhPageArchiverInstalled) return;
  window.__rhPageArchiverInstalled = true;

  const API_VERSION = 1;
  /** 与 core/page-archive.js 的 ARCHIVE_SCHEME / FRAME_SCHEME 必须一致（有守卫测试） */
  const RESOURCE_SCHEME = 'rhres';
  const FRAME_SCHEME = 'rhframe';

  /** 懒加载兜底：只有当主地址是 data:/空 时才看这些属性 */
  const LAZY_IMAGE_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-echo'];
  /** 这些 rel 的 <link> 在离线文件里没有意义 */
  const DROP_LINK_RELS = new Set([
    'preload', 'prefetch', 'preconnect', 'dns-prefetch', 'modulepreload',
    'prerender', 'manifest', 'prefetch-src'
  ]);
  const ICON_RELS = new Set(['icon', 'shortcut', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon']);
  /** 会在打开时改变文档行为/来源的 meta */
  const DROP_META_EQUIV = new Set([
    'content-security-policy', 'content-security-policy-report-only',
    'refresh', 'content-encoding', 'content-language', 'set-cookie'
  ]);

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || !request.type) return false;

    if (request.type === 'RH_ARCHIVE_COLLECT') {
      try {
        sendResponse(collect(request.options || {}, sender));
      } catch (error) {
        sendResponse({
          success: false,
          error: 'COLLECT_FAILED',
          message: (error && error.message) || String(error)
        });
      }
      return true;
    }

    return false;
  });

  /** 与 core 层一致的占位符格式 */
  function placeholderOf(scheme, token, index) {
    return scheme + '://' + token + '/' + index;
  }

  /** 绝对化：只接受 http(s)；返回空串表示"这个地址不进归档" */
  function absolutize(raw, base) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return '';
    // 文档内锚点（#top）保持原样：改成绝对地址会毁掉页内跳转
    if (value.startsWith('#')) return '';
    let parsed;
    try {
      parsed = new URL(value, base || undefined);
    } catch (e) {
      return '';
    }
    const scheme = parsed.protocol.replace(':', '').toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return '';
    parsed.hash = '';
    return parsed.href;
  }

  function randomToken() {
    let token = '';
    while (token.length < 10) {
      token += Math.floor(Math.random() * 36 ** 2).toString(36).padStart(2, '0');
    }
    return token.slice(0, 10);
  }

  /* ------------------------------------------------------------------ *
   * 采集
   * ------------------------------------------------------------------ */

  function collect(rawOptions, sender) {
    const options = {
      inlineImages: rawOptions.inlineImages !== false,
      removeScripts: rawOptions.removeScripts !== false,
      embedFrames: rawOptions.embedFrames !== false,
      onlySelection: rawOptions.onlySelection === true,
      maxFrames: Number.isFinite(Number(rawOptions.maxFrames)) ? Number(rawOptions.maxFrames) : 20,
      maxNodes: Number.isFinite(Number(rawOptions.maxNodes)) ? Number(rawOptions.maxNodes) : 40000
    };

    if (document.contentType && document.contentType !== 'text/html' && document.contentType !== 'application/xhtml+xml') {
      return {
        success: false,
        error: 'NOT_HTML',
        message: '当前文档不是 HTML（' + document.contentType + '），无法整页归档'
      };
    }

    const token = randomToken();
    const base = document.baseURI || location.href;
    const state = {
      token: token,
      base: base,
      options: options,
      resources: [],
      frames: [],
      binaryIndex: new Map(),
      stats: { images: 0, assets: 0, styles: 0, frames: 0, scripts: 0, skipped: 0, nodes: 0, canvas: 0 }
    };

    const snapshot = buildSnapshot(options);
    if (!snapshot.ok) return snapshot;

    state.stats.nodes = snapshot.pairs ? snapshot.pairs.length : 0;
    if (state.stats.nodes > options.maxNodes) {
      return {
        success: false,
        error: 'TOO_MANY_NODES',
        message: 'DOM 节点 ' + state.stats.nodes + ' 个，超过上限 ' + options.maxNodes + '，为避免标签页卡死已停止'
      };
    }

    walk(snapshot, state);

    return {
      success: true,
      apiVersion: API_VERSION,
      token: token,
      base: base,
      title: document.title || '',
      url: location.href,
      html: snapshot.root.outerHTML,
      resources: state.resources,
      frames: state.frames,
      stats: state.stats,
      frameId: Number.isFinite(sender && sender.frameId) ? sender.frameId : 0
    };
  }

  /**
   * 建立"克隆节点 ↔ 活节点"的对应关系。
   * 两份数组必须结构一致；不一致说明页面在我们克隆的过程中重排了 DOM，
   * 此时任何按索引的映射都是错的，只能如实报错让调用方重试。
   */
  function buildSnapshot(options) {
    if (options.onlySelection) {
      const selection = window.getSelection && window.getSelection();
      if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        const fragment = selection.getRangeAt(0).cloneContents();
        const root = document.createElement('div');
        root.setAttribute('data-rh-selection', '');
        root.appendChild(fragment);
        return { ok: true, root: root, pairs: null };
      }
      // 没有选中内容时退回整页：用户点的是"保存整页"，不该因为没选中而失败
    }

    const liveNodes = [document.documentElement].concat(
      Array.prototype.slice.call(document.documentElement.querySelectorAll('*'))
    );
    const cloneRoot = document.documentElement.cloneNode(true);
    const cloneNodes = [cloneRoot].concat(
      Array.prototype.slice.call(cloneRoot.querySelectorAll('*'))
    );

    if (liveNodes.length !== cloneNodes.length) {
      return {
        success: false,
        error: 'MUTATING',
        message: '页面在保存过程中发生了变化（节点数 ' + liveNodes.length + ' → ' + cloneNodes.length + '），请重试'
      };
    }
    for (let i = 0; i < liveNodes.length; i++) {
      if (liveNodes[i].localName !== cloneNodes[i].localName) {
        return {
          success: false,
          error: 'MUTATING',
          message: '页面在保存过程中发生了变化（第 ' + i + ' 个节点结构不一致），请重试'
        };
      }
    }

    const pairs = new Array(cloneNodes.length);
    for (let i = 0; i < cloneNodes.length; i++) pairs[i] = { node: cloneNodes[i], live: liveNodes[i] };
    return { ok: true, root: cloneRoot, pairs: pairs };
  }

  function walk(snapshot, state) {
    const pairs = snapshot.pairs;

    // 选择模式没有活节点可对照，只能按属性处理（currentSrc 这种运行时信息拿不到）
    if (!pairs) {
      const nodes = [snapshot.root].concat(
        Array.prototype.slice.call(snapshot.root.querySelectorAll('*'))
      );
      for (const node of nodes) handleElement(node, null, state);
      return;
    }

    for (const pair of pairs) handleElement(pair.node, pair.live, state);
  }

  function handleElement(node, live, state) {
    const tag = node.localName ? node.localName.toLowerCase() : '';
    const options = state.options;

    // 扩展自己的悬浮层不该被存进归档
    if (node.classList && node.classList.contains('rh-inpage-overlay-root')) {
      node.remove();
      return;
    }

    // 任何元素的内联 style 里都可能带背景图（先处理，避免被下面的分支提前 return 掉）
    handleStyleAttribute(node, state);

    if (options.removeScripts) {
      stripActiveAttributes(node);
      if (tag === 'script') {
        state.stats.scripts++;
        node.remove();
        return;
      }
    }

    switch (tag) {
      case 'script':
        absolutizeAttribute(node, 'src', state.base);
        return;

      case 'base':
        node.remove();
        return;

      case 'meta': {
        const equiv = String(node.getAttribute('http-equiv') || '').toLowerCase();
        if (equiv && DROP_META_EQUIV.has(equiv)) node.remove();
        return;
      }

      case 'link':
        handleLink(node, state);
        return;

      case 'style':
        handleStyleElement(node, state);
        return;

      case 'img':
      case 'input':
        if (tag === 'input' && String(node.getAttribute('type') || '').toLowerCase() !== 'image') return;
        handleImage(node, live, state);
        return;

      case 'picture':
        // <source> 会盖过我们内联的 <img src>，必须拿掉
        for (const source of Array.prototype.slice.call(node.querySelectorAll('source'))) source.remove();
        return;

      case 'source':
        if (node.closest && node.closest('picture')) { node.remove(); return; }
        absolutizeAttribute(node, 'src', state.base);
        return;

      case 'video':
        absolutizeAttribute(node, 'src', state.base);
        handlePoster(node, state);
        return;

      case 'audio':
        absolutizeAttribute(node, 'src', state.base);
        return;

      case 'track':
        absolutizeAttribute(node, 'src', state.base);
        return;

      case 'iframe':
      case 'frame':
        handleFrame(node, state);
        return;

      case 'a':
      case 'area':
        absolutizeAttribute(node, 'href', state.base);
        return;

      case 'form':
        absolutizeAttribute(node, 'action', state.base);
        return;

      case 'object':
        absolutizeAttribute(node, 'data', state.base);
        return;

      case 'embed':
        absolutizeAttribute(node, 'src', state.base);
        return;

      case 'canvas':
        // toDataURL 会被跨域图片污染，且大量站点用它做实时绘制：不猜、不糊，如实跳过
        state.stats.canvas++;
        return;

      case 'image': {
        // SVG <image>：老站点写 xlink:href，新写法是 href
        const attribute = node.hasAttribute('href') ? 'href' : (node.hasAttribute('xlink:href') ? 'xlink:href' : 'href');
        inlineInto(node, [attribute], node.getAttribute(attribute) || '', state, 'assets');
        return;
      }

      default:
        break;
    }
  }

  /** 去掉会执行脚本的属性（onclick= / href="javascript:" 等） */
  function stripActiveAttributes(node) {
    const attributes = node.attributes;
    if (!attributes || attributes.length === 0) return;
    const names = [];
    for (let i = 0; i < attributes.length; i++) names.push(attributes[i].name);
    for (const name of names) {
      const lower = name.toLowerCase();
      // 只认 onload/onclick 这类事件属性，别把 once="x" 这种普通属性也误删
      if (/^on[a-z]+$/.test(lower)) {
        node.removeAttribute(name);
        continue;
      }
      if (lower === 'href' || lower === 'src' || lower === 'action' || lower === 'formaction') {
        const value = String(node.getAttribute(name) || '').trim().toLowerCase();
        if (value.startsWith('javascript:')) node.removeAttribute(name);
      }
    }
  }

  function absolutizeAttribute(node, name, base) {
    const raw = node.getAttribute(name);
    if (raw == null) return;
    const absolute = absolutize(raw, base);
    if (absolute) node.setAttribute(name, absolute);
  }

  function handleLink(node, state) {
    const rel = String(node.getAttribute('rel') || '').toLowerCase().split(/\s+/).filter(Boolean);
    const href = node.getAttribute('href') || '';

    if (rel.includes('stylesheet')) {
      // alternate / disabled 样式表本来就不生效，留着只会让离线文件多加载一次网络
      if (rel.includes('alternate') || node.hasAttribute('disabled')) {
        node.remove();
        return;
      }
      const placeholder = registerCssLink(state, href);
      if (!placeholder) {
        node.remove();
        return;
      }
      const style = document.createElement('style');
      const media = node.getAttribute('media');
      if (media) style.setAttribute('media', media);
      const absolute = absolutize(href, state.base);
      if (absolute) style.setAttribute('data-rh-href', absolute);
      style.textContent = placeholder;
      node.replaceWith(style);
      state.stats.styles++;
      return;
    }

    if (DROP_LINK_RELS.has(rel[0]) || rel.some((value) => DROP_LINK_RELS.has(value))) {
      node.remove();
      return;
    }

    if (rel.some((value) => ICON_RELS.has(value))) {
      inlineInto(node, ['href'], href, state, 'assets');
      return;
    }

    absolutizeAttribute(node, 'href', state.base);
  }

  function handleStyleElement(node, state) {
    const text = node.textContent || '';
    if (!/url\(|@import/i.test(text)) return;
    const placeholder = registerCssText(state, text, 'css-block');
    if (!placeholder) return;
    node.textContent = placeholder;
    state.stats.styles++;
  }

  function handleStyleAttribute(node, state) {
    const value = node.getAttribute('style');
    if (!value || !/url\(/i.test(value)) return;
    const placeholder = registerCssText(state, value, 'css-attribute');
    if (placeholder) node.setAttribute('style', placeholder);
  }

  function handlePoster(node, state) {
    const poster = node.getAttribute('poster');
    if (!poster || !state.options.inlineImages) {
      absolutizeAttribute(node, 'poster', state.base);
      return;
    }
    inlineInto(node, ['poster'], poster, state, 'assets');
  }

  function handleImage(node, live, state) {
    const candidates = [];
    if (live && typeof live.currentSrc === 'string' && live.currentSrc) candidates.push(live.currentSrc);
    candidates.push(node.getAttribute('src'));
    for (const attr of LAZY_IMAGE_ATTRS) candidates.push(node.getAttribute(attr));

    let picked = '';
    for (const candidate of candidates) {
      const absolute = absolutize(candidate, state.base);
      if (absolute) { picked = absolute; break; }
    }

    // srcset/sizes 会让浏览器重新按视口挑图，与"冻结这一次渲染"的目标冲突
    node.removeAttribute('srcset');
    node.removeAttribute('sizes');
    node.removeAttribute('imagesrcset');

    if (!picked) {
      // 可能是 data: 内联图，也可能压根没加载出来：保持原样，别把它改坏
      return;
    }
    if (!state.options.inlineImages) {
      node.setAttribute('src', picked);
      return;
    }
    const placeholder = registerBinary(state, picked);
    if (placeholder) {
      node.setAttribute('src', placeholder);
      state.stats.images++;
    }
  }

  function handleFrame(node, state) {
    const raw = node.getAttribute('src');
    if (!raw) return;
    // srcdoc 本身就是内联文档，而且是浏览器优先采用的那一个：再往里塞 srcdoc 会出现
    // 重复属性（前者生效），内容会张冠李戴。这类 iframe 原样保留。
    if (node.hasAttribute('srcdoc')) return;
    const absolute = absolutize(raw, state.base);
    if (!absolute) return;

    if (!state.options.embedFrames || state.frames.length >= state.options.maxFrames) {
      // 用户关掉了嵌入（或超出上限）：保留在线地址即可，这不算"失败"
      node.setAttribute('src', absolute);
      return;
    }

    const index = state.frames.length;
    state.frames.push({
      index: index,
      src: absolute,
      name: node.getAttribute('name') || '',
      title: node.getAttribute('title') || ''
    });
    node.setAttribute('data-rh-frame', String(index));
    node.setAttribute('src', placeholderOf(FRAME_SCHEME, state.token, index));
    state.stats.frames++;
  }

  /* ------------------------------------------------------------------ *
   * 资源登记
   * ------------------------------------------------------------------ */

  /** 把属性换成（或保留）内联资源占位符 */
  function inlineInto(node, attributeNames, raw, state, bucket) {
    const absolute = absolutize(raw, state.base);
    if (!absolute) {
      for (const name of attributeNames) {
        if (node.hasAttribute(name)) absolutizeAttribute(node, name, state.base);
      }
      return;
    }
    if (!state.options.inlineImages) {
      for (const name of attributeNames) {
        if (node.hasAttribute(name)) node.setAttribute(name, absolute);
      }
      return;
    }
    const placeholder = registerBinary(state, absolute);
    if (!placeholder) return;
    const target = attributeNames.find((name) => node.hasAttribute(name)) || attributeNames[0];
    node.setAttribute(target, placeholder);
    state.stats[bucket === 'assets' ? 'assets' : 'images']++;
  }

  function registerBinary(state, absoluteUrl) {
    const existing = state.binaryIndex.get(absoluteUrl);
    if (existing != null) return placeholderOf(RESOURCE_SCHEME, state.token, existing);
    const index = state.resources.length;
    state.resources.push({
      index: index,
      kind: 'binary',
      url: absoluteUrl,
      base: state.base,
      context: 'attribute'
    });
    state.binaryIndex.set(absoluteUrl, index);
    return placeholderOf(RESOURCE_SCHEME, state.token, index);
  }

  function registerCssLink(state, href) {
    const absolute = absolutize(href, state.base);
    if (!absolute) {
      state.stats.skipped++;
      return '';
    }
    const key = 'css-link|' + absolute;
    const existing = state.binaryIndex.get(key);
    if (existing != null) return placeholderOf(RESOURCE_SCHEME, state.token, existing);
    const index = state.resources.length;
    state.resources.push({
      index: index,
      kind: 'css-link',
      url: absolute,
      base: absolute,
      context: 'css-block'
    });
    state.binaryIndex.set(key, index);
    return placeholderOf(RESOURCE_SCHEME, state.token, index);
  }

  function registerCssText(state, text, context) {
    const index = state.resources.length;
    state.resources.push({
      index: index,
      kind: 'css-text',
      url: state.base,
      base: state.base,
      context: context === 'css-attribute' ? 'css-attribute' : 'css-block',
      text: text
    });
    return placeholderOf(RESOURCE_SCHEME, state.token, index);
  }
})();
