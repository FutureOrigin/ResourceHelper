/**
 * 页面世界钩子（P5）
 *
 * 为什么需要它：相当一部分站点不把可下载地址暴露在网络层——
 * 它们用 fetch/XHR 拿一次性签名地址，或者用 MSE 把分片喂给播放器。
 * webRequest 抓不到"喂给 MediaSource 的字节"，也看不到只在 JS 里出现一次的签名地址。
 *
 * 这个脚本注入到页面主世界（manifest 里 world: "MAIN"），只做两件事：
 *   1. 从 performance 的资源条目里读出媒体地址（**只读**：不替换、不代理任何网络 API）
 *   2. 记录 MSE 的 mimeType 与首个 appendBuffer 的头部字节（判断容器与编码）
 *
 * 第 1 条刻意不用"包一层 window.fetch / XHR.open"的老做法，原因是真实踩到的坑：
 * 包一层就等于站到页面的请求路径上，页面自己发的请求一旦被它的 CSP 拦下，控制台堆栈会
 * 指向**本文件**，看起来像扩展在偷偷发请求（例：站点脚本探测 fetch('data:,')，被自己的
 * connect-src 拒掉，堆栈落在 page_hooks.js 的转发行）；Cloudflare 这类会核对原生函数是否
 * 被改写的防护，也会把包过的 fetch 当成篡改。资源条目里同样有完整 URL 与 initiatorType，
 * 观察它零入侵，且不会改变页面的任何行为。
 *
 * 另外还接一条"文本解锁"指令（AUDIT F5）：页面用 JS 给 window / document 挂的
 * 复制拦截（oncopy / oncontextmenu …）只存在于主世界，隔离世界够不着；而往页面里
 * 插内联 <script> 会被严格 CSP 拦掉。所以由内容脚本发指令、这里动手，注入时零副作用。
 *
 * 它绝不做的事：不替换 fetch/XHR、不修改请求内容、不阻塞、不抛错、
 * 不读取播放数据本体（只取前 16 字节用于嗅探容器）。任何异常都吞掉，
 * 宁可少报也不能弄坏页面。
 */
(function installResourceHelperHooks() {
  const MARK = '__resourceHelperHooks';
  if (window[MARK + 'Installed']) return;
  window[MARK + 'Installed'] = true;

  const MEDIA_URL = /\.(m3u8|mpd|mp4|m4s|m4a|m4v|ts|flv|webm|mov|mp3|aac|ogg|opus|wav|flac)(\?|#|$)/i;
  const MAX_BACKLOG = 60;
  const MAX_URLS = 40;

  const backlog = [];
  const seenUrls = new Set();
  const seenMime = new Set();
  let bridgeReady = false;

  // ---- MSE 录制状态（默认关，只有侧边栏点了"录制"才开） ----
  let RECORD_MAX_BYTES = 384 * 1024 * 1024;
  let recording = false;
  let recordedBytes = 0;
  let recordedChunks = 0;
  let recordSeq = 0;

  /** 把二进制转 base64：分块处理，避免大数组撑爆调用栈 */
  function toBase64(bytes) {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function post(payload) {
    payload[MARK] = true;
    try {
      window.postMessage(payload, '*');
    } catch (e) {}
  }

  function report(payload) {
    if (backlog.length < MAX_BACKLOG) backlog.push(payload);
    if (bridgeReady) post(payload);
  }

  function looksMedia(url) {
    return typeof url === 'string' && MEDIA_URL.test(url);
  }

  function shortUrl(url) {
    return url.length > 2000 ? url.slice(0, 2000) : url;
  }

  /**
   * 清掉页面主世界里的复制拦截（AUDIT F5，只在内容脚本发来 unlock-text 时执行）。
   *
   * 必须赋值 null 而不是 delete：
   *   · window.oncopy / document.onclick 这类旧式事件属性是原型上的访问器，
   *     delete 看起来"成功"，读回来还是那个函数；
   *   · <body oncopy="return false"> 是内容属性，赋值 null 才会把它摘掉。
   */
  const COPY_GUARD_PROPS = ['oncopy', 'oncut', 'oncontextmenu', 'onselectstart', 'ondragstart'];

  function clearCopyGuards() {
    for (const prop of COPY_GUARD_PROPS) {
      for (const scope of [window, document]) {
        try {
          if (scope[prop]) scope[prop] = null;
        } catch (e) {}
      }
    }
    try {
      const selector = COPY_GUARD_PROPS.map((prop) => '[' + prop + ']').join(',');
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        for (const prop of COPY_GUARD_PROPS) node.removeAttribute(prop);
      }
    } catch (e) {}
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[MARK] === undefined) return;

    if (data[MARK] === 'ready') {
      bridgeReady = true;
      // 握手指令到达后，把 READY 之前记下的补发出去（内容脚本比页面钩子晚一点加载）
      while (backlog.length > 0) post(backlog.shift());
      return;
    }

    if (data[MARK] === 'cmd') {
      if (data.action === 'start-record') {
        // 侧边栏可以指定上限（默认 384MB），超出的部分直接丢弃以保护页面
        const limit = Number(data.maxBytes);
        RECORD_MAX_BYTES = Number.isFinite(limit) && limit > 0 ? limit : 384 * 1024 * 1024;
        recording = true;
        recordedBytes = 0;
        recordedChunks = 0;
        recordSeq = 0;
        post({ kind: 'record-started' });
      } else if (data.action === 'stop-record') {
        recording = false;
        post({ kind: 'record-stopped', chunks: recordedChunks, bytes: recordedBytes });
      } else if (data.action === 'unlock-text') {
        clearCopyGuards();
      }
    }
  });

  /* ---- 1. 媒体地址：读 performance 资源条目（只读，不碰原生方法） ----
   *
   * 只认 fetch / xmlhttprequest 发起的请求：<video>/<img> 由 DOM 扫描与 webRequest
   * 覆盖，重复上报没有价值，反而会挤占 MAX_URLS 的名额。
   * 被 CSP 拦掉的请求不会产生资源条目 —— 也没关系，那种地址本来也下不下来。
   */
  try {
    if (typeof PerformanceObserver === 'function') {
      const observer = new PerformanceObserver(function (list) {
        try {
          for (const entry of list.getEntries()) {
            if (!entry || entry.entryType !== 'resource') continue;
            const initiator = String(entry.initiatorType || '');
            if (initiator !== 'fetch' && initiator !== 'xmlhttprequest') continue;
            const url = entry.name;
            if (!looksMedia(url)) continue;
            if (seenUrls.has(url) || seenUrls.size >= MAX_URLS) continue;
            seenUrls.add(url);
            report({ kind: initiator === 'fetch' ? 'fetch' : 'xhr', url: shortUrl(url) });
          }
        } catch (e) {}
      });
      // buffered: 我们注入得早，但页面的 <link rel=preload> 之类可能已经完成
      observer.observe({ type: 'resource', buffered: true });
    }
  } catch (e) {}

  /* ---- 2. MediaSource（MSE 播放器） ---- */
  try {
    const MediaSourceProto = window.MediaSource && window.MediaSource.prototype;
    if (MediaSourceProto && typeof MediaSourceProto.addSourceBuffer === 'function') {
      const originalAdd = MediaSourceProto.addSourceBuffer;
      MediaSourceProto.addSourceBuffer = function (mimeType) {
        const created = originalAdd.apply(this, arguments);
        try {
          const mime = String(mimeType || '');
          // 把 mime 记在 SourceBuffer 实例上，录制时才知道这段字节属于哪条轨
          if (created) created[MARK + 'Mime'] = mime;
          if (mime && !seenMime.has(mime)) {
            seenMime.add(mime);
            report({ kind: 'mse', mimeType: mime.slice(0, 120) });
          }
        } catch (e) {}
        return created;
      };
    }

    const SourceBufferProto = window.SourceBuffer && window.SourceBuffer.prototype;
    if (SourceBufferProto && typeof SourceBufferProto.appendBuffer === 'function') {
      const originalAppend = SourceBufferProto.appendBuffer;
      SourceBufferProto.appendBuffer = function (data) {
        try {
          const buffer = data && data.buffer ? data : null;
          const view = buffer
            ? new Uint8Array(buffer.buffer, buffer.byteOffset || 0, Math.min(16, buffer.byteLength))
            : null;

          if (view && view.length > 0) {
            this[MARK + 'Appends'] = (this[MARK + 'Appends'] || 0) + 1;
            // 只报前 2 次：足够分辨容器（ftyp/styp/moof）与编码，又不至于刷屏
            if (this[MARK + 'Appends'] <= 2) {
              report({
                kind: 'mse-append',
                size: buffer.byteLength,
                index: this[MARK + 'Appends'],
                head: Array.prototype.slice.call(view)
              });
            }

            if (recording && recordedBytes < RECORD_MAX_BYTES) {
              const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset || 0, buffer.byteLength);
              const accepted = Math.min(bytes.length, RECORD_MAX_BYTES - recordedBytes);
              recordSeq += 1;
              recordedBytes += accepted;
              recordedChunks += 1;
              post({
                kind: 'mse-chunk',
                mimeType: this[MARK + 'Mime'] || 'unknown',
                seq: recordSeq,
                size: bytes.length,
                truncated: accepted < bytes.length,
                b64: toBase64(bytes.subarray(0, accepted))
              });
            }
          }
        } catch (e) {}
        return originalAppend.apply(this, arguments);
      };
    }
  } catch (e) {}

  /* ---- 3. createObjectURL / blob 播放 ---- */
  try {
    const originalCreate = URL.createObjectURL;
    if (typeof originalCreate === 'function') {
      URL.createObjectURL = function (object) {
        try {
          if (window.MediaSource && object instanceof window.MediaSource) report({ kind: 'mse-object-url' });
        } catch (e) {}
        return originalCreate.apply(this, arguments);
      };
    }

    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (descriptor && descriptor.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set: function (value) {
          try {
            if (typeof value === 'string' && value.startsWith('blob:')) {
              report({ kind: 'blob-src', tag: this.tagName ? this.tagName.toLowerCase() : '' });
            }
          } catch (e) {}
          return descriptor.set.call(this, value);
        }
      });
    }
  } catch (e) {}
})();
