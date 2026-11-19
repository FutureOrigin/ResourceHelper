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

  /**
   * 每处理多少个节点让出一次主线程。
   *
   * 这个功能以前用"超过 4 万个节点就拒绝"来避免标签页卡死，等于把内容多的页面直接判死；
   * 卡死的真正原因是"一次跑完的长任务"，不是节点数本身。切成小片之后单次任务只有
   * 几毫秒，滚动与输入都不会被卡住（见 docs/ARCHIVE.md §4.6）。
   */
  const WALK_CHUNK = 2000;
  /** 扩展自己的悬浮层（shadow host），归档前整棵摘掉 */
  const OVERLAY_CLASS = 'rh-inpage-overlay-root';

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
      // 采集可能跨多个宏任务（大页面分片让出主线程），所以只能异步回包：
      // 返回 true 保持通道打开，等 collect 自己调用 sendResponse。
      collect(request.options || {}, sender).then(
        (result) => respond(sendResponse, result),
        (error) => respond(sendResponse, {
          success: false,
          error: 'COLLECT_FAILED',
          message: (error && error.message) || String(error)
        })
      );
      return true;
    }

    return false;
  });

  /** 回包时通道可能已经关了（侧边栏被关掉/页面跳走），别把异常冒到页面控制台 */
  function respond(sendResponse, payload) {
    try {
      sendResponse(payload);
    } catch (error) {
      // 没有接收方属于正常情况：这里没有需要补救的状态
    }
  }

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

  async function collect(rawOptions, sender) {
    const options = {
      inlineImages: rawOptions.inlineImages !== false,
      removeScripts: rawOptions.removeScripts !== false,
      embedFrames: rawOptions.embedFrames !== false,
      onlySelection: rawOptions.onlySelection === true,
      maxFrames: Number.isFinite(Number(rawOptions.maxFrames)) ? Number(rawOptions.maxFrames) : 20
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

    state.stats.nodes = snapshot.nodes;
    const walked = await walk(snapshot, state);
    // 活树与克隆树的图片数量必须一致：不一致说明配对不可靠，宁可让用户重试，
    // 也不能把 A 图的字节塞进 B 图的 src
    if (snapshot.liveImages && walked.images !== snapshot.liveImages.length) {
      return {
        success: false,
        error: 'MUTATING',
        message: '页面在保存过程中发生了变化（图片数量不一致），请重试'
      };
    }

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
   * 建一份可以安全改写的克隆，并确认克隆期间页面没有变。
   *
   * 老实现把活节点与克隆节点各物化成几万项的数组再逐项比对：光是引用数组就要几 MB，
   * 逐项比较本身也是一次长任务。现在只算两次"元素树指纹"（文档序的 localName 序列
   * + 节点数），图片的 currentSrc 单独按文档序收集 —— 这也是不再需要节点数上限的前提。
   *
   * 指纹只看元素名与顺序，不看文字/属性：页面上的时钟、计数器在采集期间更新不该让
   * 保存失败；只要元素结构一致，占位符与图片的配对就是可靠的。
   */
  function buildSnapshot(options) {
    if (options.onlySelection) {
      const selection = window.getSelection && window.getSelection();
      if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        const fragment = selection.getRangeAt(0).cloneContents();
        const root = document.createElement('div');
        root.setAttribute('data-rh-selection', '');
        root.appendChild(fragment);
        for (const host of root.querySelectorAll('.' + OVERLAY_CLASS)) host.remove();
        return { ok: true, root: root, liveImages: null, nodes: fingerprint(root).count };
      }
      // 没有选中内容时退回整页：用户点的是"保存整页"，不该因为没选中而失败
    }

    const live = fingerprint(document.documentElement);
    const cloneRoot = document.documentElement.cloneNode(true);
    const clone = fingerprint(cloneRoot);

    if (live.count !== clone.count) {
      return {
        success: false,
        error: 'MUTATING',
        message: '页面在保存过程中发生了变化（节点数 ' + live.count + ' → ' + clone.count + '），请重试'
      };
    }
    if (live.a !== clone.a || live.b !== clone.b) {
      return {
        success: false,
        error: 'MUTATING',
        message: '页面在保存过程中发生了变化（结构不一致），请重试'
      };
    }

    // 悬浮层是扩展自己的 UI，不该进归档。影子树不会被 cloneNode 复制，light DOM 里
    // 也没有子节点，所以整棵摘掉不会让后面的图片配对错位。
    const overlays = document.querySelectorAll('.' + OVERLAY_CLASS);
    if (overlays.length > 0) {
      for (const host of cloneRoot.querySelectorAll('.' + OVERLAY_CLASS)) host.remove();
    }

    return { ok: true, root: cloneRoot, liveImages: collectLiveImages(overlays), nodes: clone.count };
  }

  /**
   * 元素树指纹：文档序的 localName 序列，压成两个 32 位哈希。
   *
   * 用哈希而不是保存节点引用：几万项的数组本身就要几 MB，逐项比较还是纯 JS 长任务。
   * 两个独立初值一起用等效 64 位，这个规模下可以当零碰撞。
   */
  function fingerprint(root) {
    const result = { count: 0, a: 0x811c9dc5 | 0, b: 0x7f4a7c15 | 0 };
    let node = root;
    while (node) {
      const name = node.localName || '';
      result.count++;
      // 先混入长度，避免 "ab"+"c" 与 "a"+"bc" 被当成同一串
      result.a = Math.imul(result.a ^ name.length, 16777619) | 0;
      result.b = Math.imul(result.b ^ name.length, 2654435761) | 0;
      for (let i = 0; i < name.length; i++) {
        const code = name.charCodeAt(i);
        result.a = Math.imul(result.a ^ code, 16777619) | 0;
        result.b = Math.imul(result.b ^ code, 2654435761) | 0;
      }
      const child = node.firstElementChild;
      node = child || nextAfterSubtree(node, root);
    }
    return result;
  }

  /** 文档序里"跳过整棵子树之后"的下一个元素；走到 root 返回 null */
  function nextAfterSubtree(node, root) {
    let cursor = node;
    while (cursor && cursor !== root) {
      if (cursor.nextElementSibling) return cursor.nextElementSibling;
      cursor = cursor.parentElement;
    }
    return null;
  }

  /**
   * 记下每张图"浏览器实际显示的那张"（currentSrc）。
   *
   * 克隆节点不会加载图片，currentSrc 是空的，所以只能在活树上取；顺序必须与克隆树
   * 的文档序一致 —— 两边结构已经比对过，这里用同一判定（isImageNode）收集。
   */
  function collectLiveImages(overlays) {
    const list = [];
    const nodes = document.querySelectorAll('img, input[type="image" i]');
    for (const node of nodes) {
      if (overlays && overlays.length > 0 && insideAny(node, overlays)) continue;
      list.push(typeof node.currentSrc === 'string' ? node.currentSrc : '');
    }
    return list;
  }

  function insideAny(node, hosts) {
    for (const host of hosts) {
      if (host.contains(node)) return true;
    }
    return false;
  }

  /** 与 handleElement 里的 img/input 分支同一判定 */
  function isImageNode(node) {
    const name = node.localName;
    if (name === 'img') return true;
    if (name !== 'input') return false;
    return String(node.getAttribute('type') || '').toLowerCase() === 'image';
  }

  /**
   * 把主线程还给页面。
   *
   * 用 setTimeout 而不是 requestAnimationFrame：后台标签页里 rAF 根本不跑，
   * 会让保存停在半路；setTimeout 最多被节流，但一定会继续。
   */
  function yieldToPage() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * 逐个元素改写克隆树，每 WALK_CHUNK 个节点让出一次主线程。
   *
   * 顺序是"先取下一个、再改当前"：handleElement 可能 remove()/replaceWith()，
   * 改完再读兄弟指针时它已经不在树上了。返回访问到的图片数，供调用方核对配对。
   */
  async function walk(snapshot, state) {
    const liveImages = snapshot.liveImages;
    const root = snapshot.root;
    let node = root;
    let cursor = 0;
    let budget = WALK_CHUNK;

    while (node) {
      const child = node.firstElementChild;
      const after = nextAfterSubtree(node, root);
      const liveSrc = liveImages && isImageNode(node) ? (liveImages[cursor++] || '') : '';
      const removed = handleElement(node, liveSrc, state);
      node = removed ? after : (child || after);
      budget--;
      if (budget <= 0) {
        budget = WALK_CHUNK;
        await yieldToPage();
      }
    }

    return { images: cursor };
  }

  /**
   * 处理一个元素。
   *
   * 返回 true 表示这个节点（连同子树）已经从克隆树上摘掉，调用方必须跳过它的子树。
   */
  function handleElement(node, liveSrc, state) {
    const tag = node.localName ? node.localName.toLowerCase() : '';
    const options = state.options;

    // 任何元素的内联 style 里都可能带背景图（先处理，避免被下面的分支提前 return 掉）
    handleStyleAttribute(node, state);

    if (options.removeScripts) {
      stripActiveAttributes(node);
      if (tag === 'script') {
        state.stats.scripts++;
        node.remove();
        return true;
      }
    }

    switch (tag) {
      case 'script':
        absolutizeAttribute(node, 'src', state.base);
        return false;

      case 'base':
        node.remove();
        return true;

      case 'meta': {
        const equiv = String(node.getAttribute('http-equiv') || '').toLowerCase();
        if (!equiv || !DROP_META_EQUIV.has(equiv)) return false;
        node.remove();
        return true;
      }

      case 'link':
        return handleLink(node, state);

      case 'style':
        handleStyleElement(node, state);
        return false;

      case 'img':
      case 'input':
        if (tag === 'input' && String(node.getAttribute('type') || '').toLowerCase() !== 'image') return false;
        handleImage(node, liveSrc, state);
        return false;

      case 'source':
        // <picture> 里的 <source> 会盖过我们内联的 <img src>，必须拿掉。
        // 按节点删，而不是在 <picture> 上一次性删子树：遍历指针是"先取下一个"的，
        // 提前删子树会让指针指向已经脱离文档的节点。
        if (node.closest && node.closest('picture')) {
          node.remove();
          return true;
        }
        absolutizeAttribute(node, 'src', state.base);
        return false;

      case 'video':
        absolutizeAttribute(node, 'src', state.base);
        handlePoster(node, state);
        return false;

      case 'audio':
        absolutizeAttribute(node, 'src', state.base);
        return false;

      case 'track':
        absolutizeAttribute(node, 'src', state.base);
        return false;

      case 'iframe':
      case 'frame':
        handleFrame(node, state);
        return false;

      case 'a':
      case 'area':
        absolutizeAttribute(node, 'href', state.base);
        return false;

      case 'form':
        absolutizeAttribute(node, 'action', state.base);
        return false;

      case 'object':
        absolutizeAttribute(node, 'data', state.base);
        return false;

      case 'embed':
        absolutizeAttribute(node, 'src', state.base);
        return false;

      case 'canvas':
        // toDataURL 会被跨域图片污染，且大量站点用它做实时绘制：不猜、不糊，如实跳过
        state.stats.canvas++;
        return false;

      case 'image': {
        // SVG <image>：老站点写 xlink:href，新写法是 href
        const attribute = node.hasAttribute('href') ? 'href' : (node.hasAttribute('xlink:href') ? 'xlink:href' : 'href');
        inlineInto(node, [attribute], node.getAttribute(attribute) || '', state, 'assets');
        return false;
      }

      default:
        return false;
    }
  }

  /** 去掉会执行脚本的属性（onclick= / href="javascript:" 等） */
  function stripActiveAttributes(node) {
    const attributes = node.attributes;
    if (!attributes || attributes.length === 0) return;
    // 倒序删除：删掉第 i 项不会让更低的下标失效，这样不用先收集一遍属性名。
    // 几万个元素逐个分配临时数组是白白的 GC 压力（AUDIT E4 的同类问题）。
    for (let i = attributes.length - 1; i >= 0; i--) {
      const name = attributes[i].name;
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
        return true;
      }
      const placeholder = registerCssLink(state, href);
      if (!placeholder) {
        node.remove();
        return true;
      }
      const style = document.createElement('style');
      const media = node.getAttribute('media');
      if (media) style.setAttribute('media', media);
      const absolute = absolutize(href, state.base);
      if (absolute) style.setAttribute('data-rh-href', absolute);
      style.textContent = placeholder;
      node.replaceWith(style);
      state.stats.styles++;
      return true;
    }

    if (DROP_LINK_RELS.has(rel[0]) || rel.some((value) => DROP_LINK_RELS.has(value))) {
      node.remove();
      return true;
    }

    if (rel.some((value) => ICON_RELS.has(value))) {
      inlineInto(node, ['href'], href, state, 'assets');
      return false;
    }

    absolutizeAttribute(node, 'href', state.base);
    return false;
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

  function handleImage(node, liveSrc, state) {
    const candidates = [];
    if (liveSrc) candidates.push(liveSrc);
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
