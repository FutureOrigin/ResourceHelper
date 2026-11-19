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
  /** 同步扫描（词表 / 隐藏元素 / 指纹）的分片大小 */
  const SCAN_CHUNK = 2000;
  /** 选择器词表上限：超过就放弃 CSS 精简（类名机器生成的页面，词表会失控） */
  const VOCABULARY_LIMIT = 20000;
  /** 扩展自己的悬浮层（shadow host），归档前整棵摘掉 */
  const OVERLAY_CLASS = 'rh-inpage-overlay-root';

  /**
   * 这些标签的 display:none 是"结构性"的（UA 默认），删掉会毁掉文档本身：
   * head 里的东西、表单的隐藏字段、模板、字幕轨，以及 SVG 里不参与渲染的容器
   * （defs/symbol/渐变/裁剪路径……它们的子节点正是被引用的图形）。
   */
  const KEEP_HIDDEN = new Set([
    'html', 'head', 'body', 'style', 'link', 'meta', 'title', 'base',
    'script', 'noscript', 'template', 'datalist', 'param', 'source', 'track',
    'option', 'optgroup', 'col', 'colgroup', 'area',
    'defs', 'symbol', 'clippath', 'mask', 'pattern', 'lineargradient',
    'radialgradient', 'filter', 'marker', 'metadata', 'desc', 'view', 'cursor',
    'font', 'font-face'
  ]);

  /** 压缩 HTML 时不能碰其文本的元素（空白有意义） */
  const PRESERVE_TEXT = new Set(['pre', 'textarea', 'style', 'script', 'xmp', 'plaintext', 'listing']);

  /** 已知的块级标签：两侧都是块级（或边界）时，空白文本节点一定不显示 */
  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'colgroup',
    'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
    'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
    'hgroup', 'hr', 'html', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
    'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul'
  ]);

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
      removeHidden: rawOptions.removeHidden !== false,
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

    const snapshot = await buildSnapshot(options);
    if (!snapshot.ok) return snapshot;

    state.stats.nodes = snapshot.nodes;
    state.stats.hiddenRemoved = snapshot.hiddenRemoved || 0;
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

    compressTree(snapshot.root);

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
      vocabulary: snapshot.vocabulary || null,
      frameId: Number.isFinite(sender && sender.frameId) ? sender.frameId : 0
    };
  }

  /**
   * 建一份可以安全改写的克隆，并确认克隆期间页面没有变。
   *
   * 一次同步遍历同时做四件事：算"元素树指纹"（文档序 localName 的 64 位哈希 +
   * 节点数）、收集选择器词表、记下每张图真正显示的地址、把不该进归档的节点从克隆里摘掉
   * （扩展自己的悬浮层、display:none 的元素）。这样活树只读、克隆树只删，
   * 两边结构始终可比对；也让"删隐藏元素"不会破坏图片配对。
   */
  async function buildSnapshot(options) {
    if (options.onlySelection) {
      const selection = window.getSelection && window.getSelection();
      if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        const fragment = selection.getRangeAt(0).cloneContents();
        const root = document.createElement('div');
        root.setAttribute('data-rh-selection', '');
        root.appendChild(fragment);
        for (const host of root.querySelectorAll('.' + OVERLAY_CLASS)) host.remove();
        return {
          ok: true,
          root: root,
          liveImages: null,
          nodes: countElements(root),
          vocabulary: vocabularyOf(root),
          hiddenRemoved: 0
        };
      }
      // 没有选中内容时退回整页：用户点的是"保存整页"，不该因为没选中而失败
    }

    const liveRoot = document.documentElement;
    const cloneRoot = liveRoot.cloneNode(true);
    const scan = await scanTrees(liveRoot, cloneRoot, options);
    if (!scan.ok) return scan;
    return {
      ok: true,
      root: cloneRoot,
      liveImages: scan.images,
      nodes: scan.count,
      vocabulary: scan.vocabulary,
      hiddenRemoved: scan.hiddenRemoved
    };
  }

  /**
   * 同步遍历活树与克隆树（结构相同才能同步推进），顺带摘掉悬浮层与隐藏元素。
   *
   * 隐藏判定用活节点的 computedStyle：克隆节点不在渲染树里，读不到 display。
   * 只删 display:none —— 它不占布局位置，删掉不会让页面错位；visibility:hidden
   * 还占位，删了会改变排版，不做。
   */
  async function scanTrees(liveRoot, cloneRoot, options) {
    const checkHidden = options.removeHidden !== false;
    const live = { count: 0, a: 0x811c9dc5 | 0, b: 0x7f4a7c15 | 0 };
    const clone = { count: 0, a: 0x811c9dc5 | 0, b: 0x7f4a7c15 | 0 };
    const images = [];
    const vocabulary = { tags: new Set(), classes: new Set(), ids: new Set(), attrs: new Set() };
    let hiddenRemoved = 0;
    let budget = SCAN_CHUNK;
    let l = liveRoot;
    let c = cloneRoot;

    while (l && c) {
      const name = l.localName || '';
      const overlay = isOverlay(l);
      const hidden = !overlay && checkHidden && isHidden(l, name);
      if (overlay || hidden) {
        const nextLive = nextAfterSubtree(l, liveRoot);
        const nextClone = nextAfterSubtree(c, cloneRoot);
        c.remove();
        if (hidden) hiddenRemoved++;
        l = nextLive;
        c = nextClone;
        if (--budget <= 0) { budget = SCAN_CHUNK; await yieldToPage(); }
        continue;
      }

      mixFingerprint(live, name);
      mixFingerprint(clone, c.localName || '');
      live.count++;
      clone.count++;
      addVocabulary(vocabulary, l);
      if (isImageNode(l)) images.push(typeof l.currentSrc === 'string' ? l.currentSrc : '');

      const child = l.firstElementChild;
      if (child) {
        l = child;
        c = c.firstElementChild;
      } else {
        l = nextAfterSubtree(l, liveRoot);
        c = nextAfterSubtree(c, cloneRoot);
      }
      if (--budget <= 0) { budget = SCAN_CHUNK; await yieldToPage(); }
    }

    if (l || c) {
      return {
        ok: false,
        success: false,
        error: 'MUTATING',
        message: '页面在保存过程中发生了变化（结构不一致），请重试'
      };
    }
    if (live.count !== clone.count) {
      return {
        ok: false,
        success: false,
        error: 'MUTATING',
        message: '页面在保存过程中发生了变化（节点数 ' + live.count + ' → ' + clone.count + '），请重试'
      };
    }
    if (live.a !== clone.a || live.b !== clone.b) {
      return {
        ok: false,
        success: false,
        error: 'MUTATING',
        message: '页面在保存过程中发生了变化（结构不一致），请重试'
      };
    }

    return {
      ok: true,
      count: live.count,
      images: images,
      vocabulary: vocabularyToArrays(vocabulary),
      hiddenRemoved: hiddenRemoved
    };
  }

  /**
   * 元素树指纹：文档序的 localName 序列，压成两个 32 位哈希。
   *
   * 用哈希而不是保存节点引用：几万项的数组本身就要几 MB，逐项比较还是纯 JS 长任务。
   * 两个独立初值一起用等效 64 位，这个规模下可以当零碰撞。
   */
  function mixFingerprint(target, name) {
    // 先混入长度，避免 "ab"+"c" 与 "a"+"bc" 被当成同一串
    target.a = Math.imul(target.a ^ name.length, 16777619) | 0;
    target.b = Math.imul(target.b ^ name.length, 2654435761) | 0;
    for (let i = 0; i < name.length; i++) {
      const code = name.charCodeAt(i);
      target.a = Math.imul(target.a ^ code, 16777619) | 0;
      target.b = Math.imul(target.b ^ code, 2654435761) | 0;
    }
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
   * 选择器词表：文档里出现过的标签 / 类 / id / 属性。
   *
   * 侧边栏用它删掉"不可能匹配"的 CSS 规则。只收集、不判断；词表太大（类名是
   * 机器生成的页面）就返回 null —— 宁可不少删，也不能因为漏记而删错规则。
   */
  function addVocabulary(vocabulary, node) {
    const name = node.localName;
    if (name) vocabulary.tags.add(name);

    const className = node.getAttribute('class');
    if (className) {
      for (const token of className.split(/\s+/)) {
        if (token) vocabulary.classes.add(token);
      }
    }
    const id = node.getAttribute('id');
    if (id) vocabulary.ids.add(id);

    const attributes = node.attributes;
    if (!attributes) return;
    for (let i = 0; i < attributes.length; i++) {
      const attrName = attributes[i].name;
      if (attrName) vocabulary.attrs.add(attrName.toLowerCase());
    }
  }

  function vocabularyOf(root) {
    const vocabulary = { tags: new Set(), classes: new Set(), ids: new Set(), attrs: new Set() };
    addVocabulary(vocabulary, root);
    for (const node of root.querySelectorAll('*')) addVocabulary(vocabulary, node);
    return vocabularyToArrays(vocabulary);
  }

  function vocabularyToArrays(vocabulary) {
    const total = vocabulary.tags.size + vocabulary.classes.size + vocabulary.ids.size + vocabulary.attrs.size;
    if (total > VOCABULARY_LIMIT) return null;
    return {
      tags: Array.from(vocabulary.tags),
      classes: Array.from(vocabulary.classes),
      ids: Array.from(vocabulary.ids),
      attrs: Array.from(vocabulary.attrs)
    };
  }

  /** 扩展自己的悬浮层（shadow host） */
  function isOverlay(node) {
    return Boolean(node.classList && node.classList.contains(OVERLAY_CLASS));
  }

  /**
   * 这个元素是不是"不渲染"（display:none）。
   *
   * 结构性标签（head/style/link/meta/script/template…）的 display:none 来自 UA 样式，
   * 删掉会毁掉文档本身，必须先排除；只处理 body 里的元素。
   */
  function isHidden(node, name) {
    if (!name || KEEP_HIDDEN.has(name.toLowerCase())) return false;
    if (!document.body || !document.body.contains(node)) return false;
    if (typeof window.getComputedStyle !== 'function') return false;
    const style = window.getComputedStyle(node);
    return Boolean(style) && style.display === 'none';
  }

  function countElements(root) {
    let count = 0;
    let node = root;
    while (node) {
      count++;
      const child = node.firstElementChild;
      node = child || nextAfterSubtree(node, root);
    }
    return count;
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
   * 压缩整棵克隆树：删注释、删"一定不显示"的空白文本节点。
   *
   * 只处理**纯空白**的文本节点，且要求两侧都是已知块级标签（或边界）—— 文本
   * 内容一个字都不动，所以不会把 "Hello <b>world</b>" 粘成一个词。
   * 未知标签按内联处理（保守保留空格），pre/textarea/style 整棵子树跳过。
   */
  function compressTree(root) {
    let node = root;
    while (node) {
      const tag = node.localName;
      if (tag && PRESERVE_TEXT.has(tag)) {
        node = nextAfterSubtree(node, root);
        continue;
      }
      compressChildren(node);
      const child = node.firstElementChild;
      node = child || nextAfterSubtree(node, root);
    }
  }

  function compressChildren(node) {
    let child = node.firstChild;
    while (child) {
      const next = child.nextSibling;
      if (child.nodeType === 8) {
        node.removeChild(child);
      } else if (child.nodeType === 3 && /^\s+$/.test(child.nodeValue || '')) {
        if (insignificantSpace(child)) node.removeChild(child);
        else if (child.nodeValue !== ' ') child.nodeValue = ' ';
      }
      child = next;
    }
  }

  /** 纯空白文本节点两侧都不是内联内容时，它渲染不出任何东西 */
  function insignificantSpace(node) {
    const prev = node.previousSibling;
    const next = node.nextSibling;
    if (!prev && !next) return false; // 元素里只有空白：内联上下文里可能是有意义的
    if (prev && !isBlockLike(prev)) return false;
    if (next && !isBlockLike(next)) return false;
    return true;
  }

  function isBlockLike(node) {
    // 文本节点相邻的空白一定有意义；未知标签按内联处理（保守）
    if (node.nodeType !== 1) return false;
    const tag = node.localName;
    return Boolean(tag) && BLOCK_TAGS.has(tag);
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
