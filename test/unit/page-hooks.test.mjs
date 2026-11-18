/**
 * P5 页面钩子的单测（VM 沙箱加载真实 page_hooks.js）
 *
 * 钩子跑在页面主世界，一旦抛错就是在破坏别人的站点，所以它必须：
 *   · 任何异常都吞掉，绝不影响原始 fetch/XHR/appendBuffer 的行为
 *   · 只上报"媒体相关"的最小信息，不上报播放数据本体
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE = readFileSync(path.join(ROOT, 'src/content/page_hooks.js'), 'utf8');
const MARK = '__resourceHelperHooks';

function createHarness() {
  const posted = [];
  const listeners = [];
  const appendedCalls = [];
  const observers = [];

  class FakeSourceBuffer {
    appendBuffer(data) { appendedCalls.push(data); }
  }
  class FakeMediaSource {
    addSourceBuffer(mime) { return new FakeSourceBuffer(); }
  }

  const nativeFetch = function fetch(input) {
    return Promise.resolve({ url: typeof input === 'string' ? input : input && input.url });
  };

  const fakeWindow = {
    postMessage(data) { posted.push(data); },
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    fetch: nativeFetch,
    MediaSource: FakeMediaSource,
    SourceBuffer: FakeSourceBuffer
  };

  class FakeXhr {
    open(method, url) { this.opened = url; }
  }
  const nativeXhrOpen = FakeXhr.prototype.open;

  /** performance 观察者的替身：测试里手动喂条目，等价于浏览器触发回调 */
  class FakePerformanceObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(options) { this.options = options; }
    disconnect() { this.disconnected = true; }
  }

  function FakeMediaElement() {}
  Object.defineProperty(FakeMediaElement.prototype, 'src', {
    configurable: true,
    get() { return this._src; },
    set(value) { this._src = value; }
  });
  Object.defineProperty(FakeMediaElement.prototype, 'tagName', { value: 'VIDEO' });

  // 主世界里的 document：只实现"文本解锁"用到的那一点点
  const removedAttributes = [];
  const fakeDocument = {
    oncopy: () => 'document-handler',
    querySelectorAll(selector) {
      if (selector.includes('[oncopy]')) {
        return [{ removeAttribute(name) { removedAttributes.push(name); } }];
      }
      return [];
    }
  };

  const sandbox = {
    window: fakeWindow,
    document: fakeDocument,
    XMLHttpRequest: FakeXhr,
    HTMLMediaElement: FakeMediaElement,
    PerformanceObserver: FakePerformanceObserver,
    URL: { createObjectURL: (obj) => 'blob:fake' },
    console: { warn() {}, error() {}, log() {} },
    btoa: (binary) => Buffer.from(binary, 'binary').toString('base64'),
    atob: (text) => Buffer.from(text, 'base64').toString('binary')
  };

  vm.runInNewContext(SOURCE, sandbox, { filename: 'page_hooks.js' });

  const fire = (data, source) => listeners.forEach((fn) => fn({ source: source === undefined ? fakeWindow : source, data: data }));
  const handshake = () => fire({ [MARK]: 'ready' });
  const events = () => posted.filter((item) => item && item[MARK] === true && item.kind);
  /** 模拟浏览器投递资源条目 */
  const emit = (entries) => observers.forEach((observer) => observer.callback({ getEntries: () => entries }));
  const resource = (overrides) => Object.assign({
    entryType: 'resource',
    name: 'https://cdn.example.com/a.m3u8',
    initiatorType: 'fetch'
  }, overrides);

  return {
    posted, events, handshake, fire, emit, resource, observers,
    fakeWindow, fakeDocument, removedAttributes,
    FakeMediaSource, FakeXhr, FakeMediaElement, appendedCalls, sandbox,
    nativeFetch, nativeXhrOpen
  };
}

test('握手前的事件先进 backlog，握手后补发', () => {
  const h = createHarness();
  h.emit([h.resource()]);
  assert.equal(h.events().length, 0, '握手前不应直接发消息');

  h.handshake();
  const events = h.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'fetch');
  assert.equal(events[0].url, 'https://cdn.example.com/a.m3u8');
});

test('只上报 fetch/XHR 发起、看起来像媒体的地址', () => {
  const h = createHarness();
  h.handshake();

  h.emit([
    h.resource({ name: 'https://api.example.com/feed?page=1' }),
    h.resource({ name: 'https://api.example.com/app.js' }),
    // <img>/<video> 发起的请求由 DOM 扫描与 webRequest 覆盖，这里不重复占名额
    h.resource({ name: 'https://cdn.example.com/bg.png', initiatorType: 'img' }),
    h.resource({ name: 'https://cdn.example.com/movie.mp4', initiatorType: 'video' })
  ]);
  assert.equal(h.events().length, 0);

  h.emit([h.resource({ name: 'https://cdn.example.com/v.mp4?token=1' })]);
  assert.equal(h.events().length, 1);
  assert.equal(h.events()[0].kind, 'fetch');
});

test('同一地址只上报一次', () => {
  const h = createHarness();
  h.handshake();
  h.emit([h.resource({ name: 'https://cdn.example.com/a.m4s' })]);
  h.emit([h.resource({ name: 'https://cdn.example.com/a.m4s' })]);
  assert.equal(h.events().length, 1);
});

test('XHR 发起的媒体请求记成 xhr，与 fetch 区分开', () => {
  const h = createHarness();
  h.handshake();
  h.emit([h.resource({ name: 'https://cdn.example.com/stream.mpd', initiatorType: 'xmlhttprequest' })]);
  const events = h.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'xhr');
  assert.equal(events[0].url, 'https://cdn.example.com/stream.mpd');
});

test('不替换 fetch / XHR.open：页面请求被自己的 CSP 拦下时不能算到扩展头上', () => {
  const h = createHarness();

  // 历史上这里是包 window.fetch 的。包一层就站到了页面的请求路径上：页面自己 fetch('data:,')
  // 被它的 connect-src 拦掉时，控制台堆栈会指向 page_hooks.js，看着像扩展在发请求。
  assert.equal(h.fakeWindow.fetch, h.nativeFetch, 'window.fetch 必须保持原生');
  assert.equal(h.FakeXhr.prototype.open, h.nativeXhrOpen, 'XHR.open 必须保持原生');
  assert.equal(h.fakeWindow.fetch.toString(), h.nativeFetch.toString());

  // 地址改从 performance 资源条目里读，观察者必须真的挂上
  assert.equal(h.observers.length, 1, '应当只装一个观察者');
  assert.equal(h.observers[0].options.type, 'resource');
  assert.equal(h.observers[0].options.buffered, true);
});

test('垃圾资源条目不会把页面搞崩', () => {
  const h = createHarness();
  h.handshake();
  assert.doesNotThrow(() => h.emit([null, {}, { entryType: 'resource', initiatorType: 'fetch' }]));
  assert.equal(h.events().length, 0);
});

test('addSourceBuffer 上报 mimeType 且去重', () => {
  const h = createHarness();
  h.handshake();
  const ms = new h.fakeWindow.MediaSource();
  ms.addSourceBuffer('video/mp4; codecs="avc1.640028"');
  ms.addSourceBuffer('video/mp4; codecs="avc1.640028"');
  ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
  const events = h.events().filter((e) => e.kind === 'mse');
  assert.equal(events.length, 2);
  assert.equal(events[0].mimeType, 'video/mp4; codecs="avc1.640028"');
});

test('appendBuffer 只报前两次，并带上头部字节', () => {
  const h = createHarness();
  h.handshake();
  const proto = h.fakeWindow.SourceBuffer.prototype;
  const target = Object.create(proto);
  target.appendBuffer = proto.appendBuffer.bind(target);

  const ftyp = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  target.appendBuffer(ftyp);
  target.appendBuffer(ftyp);
  target.appendBuffer(ftyp);

  const events = h.events().filter((e) => e.kind === 'mse-append');
  assert.equal(events.length, 2, '第三次不再上报，避免刷屏');
  assert.equal(events[0].size, 12);
  // head 来自 VM 沙箱（不同 realm 的 Array），先转成本地数组
  assert.deepEqual(Array.from(events[0].head).slice(4, 8), [0x66, 0x74, 0x79, 0x70]);
});

test('blob: 播放地址会被识别为 MSE 播放', () => {
  const h = createHarness();
  h.handshake();
  const element = new h.FakeMediaElement();
  element.src = 'blob:https://example.com/1234';
  const events = h.events().filter((e) => e.kind === 'blob-src');
  assert.equal(events.length, 1);
  assert.equal(events[0].tag, 'video');
  assert.equal(element.src, 'blob:https://example.com/1234', '实际赋值必须生效');
});

test('只有收到录制指令后才收集分片，且按轨带上 mimeType', () => {
  const h = createHarness();
  h.handshake();

  const source = new h.fakeWindow.MediaSource();
  const videoBuffer = source.addSourceBuffer('video/mp4; codecs="avc1"');
  const audioBuffer = source.addSourceBuffer('audio/mp4; codecs="mp4a"');

  videoBuffer.appendBuffer(new Uint8Array([1, 2, 3]));
  assert.equal(h.events().filter((e) => e.kind === 'mse-chunk').length, 0, '未开始录制时不应收集');

  h.fire({ [MARK]: 'cmd', action: 'start-record' });
  videoBuffer.appendBuffer(new Uint8Array([9, 8, 7]));
  audioBuffer.appendBuffer(new Uint8Array([4, 5, 6]));

  const chunks = h.events().filter((e) => e.kind === 'mse-chunk');
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].mimeType, 'video/mp4; codecs="avc1"');
  assert.equal(chunks[1].mimeType, 'audio/mp4; codecs="mp4a"');
  assert.deepEqual(Array.from(Buffer.from(chunks[0].b64, 'base64')), [9, 8, 7]);
  assert.equal(chunks[0].seq, 1);
  assert.equal(chunks[1].seq, 2);
});

test('停止录制后不再收集，并回报累计量', () => {
  const h = createHarness();
  h.handshake();
  const buffer = new h.fakeWindow.MediaSource().addSourceBuffer('video/mp4');

  h.fire({ [MARK]: 'cmd', action: 'start-record' });
  buffer.appendBuffer(new Uint8Array(4));
  h.fire({ [MARK]: 'cmd', action: 'stop-record' });
  buffer.appendBuffer(new Uint8Array(4));

  const chunks = h.events().filter((e) => e.kind === 'mse-chunk');
  assert.equal(chunks.length, 1, '停止后不应再有分片');
  const stopped = h.events().find((e) => e.kind === 'record-stopped');
  assert.ok(stopped);
  assert.equal(stopped.chunks, 1);
  assert.equal(stopped.bytes, 4);
});

test('录制量超过上限后不再上报，保护页面内存', () => {
  const h = createHarness();
  h.handshake();
  const buffer = new h.fakeWindow.MediaSource().addSourceBuffer('video/mp4');
  h.fire({ [MARK]: 'cmd', action: 'start-record', maxBytes: 100 });

  const big = new Uint8Array(1024);
  for (let i = 0; i < 3; i += 1) buffer.appendBuffer(big);

  const chunks = h.events().filter((e) => e.kind === 'mse-chunk');
  assert.equal(chunks.length, 1, '超出上限后不再上报');
  assert.equal(chunks[0].size, 1024);
  assert.equal(chunks[0].truncated, true, '最后一段应被截断到剩余额度');
  assert.equal(Buffer.from(chunks[0].b64, 'base64').length, 100);
});

test('重复安装是幂等的', () => {
  const h = createHarness();
  const before = h.posted.length;
  vm.runInNewContext(SOURCE, h.sandbox, { filename: 'page_hooks.js' });
  assert.equal(h.posted.length, before, '第二次执行应当直接返回');
});

test('收到 unlock-text 才清复制拦截，且赋值 null 而不是 delete（AUDIT F5）', () => {
  const h = createHarness();
  h.fakeWindow.oncopy = () => 'window-handler';

  // 注入时零副作用：没收到指令前不许动页面的处理器
  assert.equal(typeof h.fakeWindow.oncopy, 'function');
  assert.equal(typeof h.fakeDocument.oncopy, 'function');

  h.fire({ [MARK]: 'cmd', action: 'unlock-text' });

  assert.equal(h.fakeWindow.oncopy, null, 'window 上的处理器必须被清掉');
  assert.equal(h.fakeDocument.oncopy, null, 'document 上的处理器必须被清掉');
  assert.ok(h.removedAttributes.includes('oncopy'), '内联属性也要摘掉');
});
