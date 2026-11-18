/**
 * 后台抓包路径回归（AUDIT E3 / E9）
 *
 * 这里直接用假的 chrome 把 background.js 载入，然后按真实时序触发
 * webRequest / tabs 监听器。它守的是这类事故：
 *
 *   91ce532 把 toObservation 抽到 core/observation.js 时，顺手删掉了
 *   tabMeta / titleOf / rememberTab / ensureTabMeta / parseMediaUrl /
 *   parseYouTubePlayback，但调用点还在。语法检查过得去，线上表现是每条候选
 *   请求都抛 "ReferenceError: rememberTab is not defined"，抓包整条链路死掉。
 *
 * 所以：入口脚本必须能在"一条真实请求"上跑通，并且真的产出资源。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

async function boot() {
  const state = {
    runtimeSent: [],
    tabSent: [],
    tabsGetCalls: [],
    storage: new Map(),
    onSendHeaders: [],
    onHeadersReceived: [],
    onUpdated: [],
    onRemoved: []
  };

  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message) { state.runtimeSent.push(message); return Promise.resolve(); },
      getURL(relative) { return 'chrome-extension://test/' + relative; },
      getContexts: async () => [],
      onMessage: { addListener() {} }
    },
    tabs: {
      get(tabId) {
        state.tabsGetCalls.push(tabId);
        return Promise.resolve({ id: tabId, title: '兜底标题', url: 'https://fallback.example/' });
      },
      sendMessage(tabId, message) { state.tabSent.push({ tabId, message }); return Promise.resolve(); },
      query: async () => [],
      onRemoved: { addListener(fn) { state.onRemoved.push(fn); } },
      onUpdated: { addListener(fn) { state.onUpdated.push(fn); } }
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
      setBadgeTextColor: () => Promise.resolve(),
      onClicked: { addListener() {} }
    },
    storage: {
      session: {
        async get(key) { return state.storage.has(key) ? { [key]: state.storage.get(key) } : {}; },
        async set(payload) { for (const [k, v] of Object.entries(payload)) state.storage.set(k, v); },
        async remove(key) { state.storage.delete(key); }
      }
    },
    webRequest: {
      onSendHeaders: { addListener(fn) { state.onSendHeaders.push(fn); } },
      onHeadersReceived: { addListener(fn) { state.onHeadersReceived.push(fn); } }
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      updateDynamicRules: async () => {}
    }
  };

  globalThis.chrome = chrome;
  // 探测队列会真的发请求；单测里让它立刻失败，避免联网
  globalThis.fetch = () => Promise.reject(new Error('offline'));
  await import('../../src/service/background.js');

  state.tabUpdated = (tabId, changeInfo) => state.onUpdated.forEach((fn) => fn(tabId, changeInfo));
  state.tabRemoved = (tabId) => state.onRemoved.forEach((fn) => fn(tabId));
  state.sendHeaders = (details) => state.onSendHeaders.forEach((fn) => fn(details));
  state.headersReceived = (details) => state.onHeadersReceived.forEach((fn) => fn(details));
  state.upserts = (tabId) => state.tabSent
    .filter((item) => item.message && item.message.type === 'RH_MEDIA_UPSERTED')
    .filter((item) => tabId === undefined || item.tabId === tabId)
    .map((item) => item.message.media);
  state.reset = () => {
    state.runtimeSent.length = 0;
    state.tabSent.length = 0;
    state.tabsGetCalls.length = 0;
  };
  return state;
}

const h = await boot();

test('普通媒体请求：不抛错，并且产出带标题的资源（rememberTab + parseMediaUrl）', () => {
  h.reset();
  h.tabUpdated(7, { title: ' 测试视频 - 哔哩哔哩 ', url: 'https://www.bilibili.com/video/BV1' });

  const details = {
    tabId: 7,
    frameId: 0,
    documentId: 'doc-a',
    url: 'https://cdn.example.com/media/abc.mp4?token=1',
    requestHeaders: [{ name: 'Referer', value: 'https://www.bilibili.com/video/BV1' }]
  };

  assert.doesNotThrow(() => h.sendHeaders(details), '抓包路径不允许出现未定义引用');
  const media = h.upserts(7)[0];
  assert.ok(media, '应当广播一条 RH_MEDIA_UPSERTED');
  assert.equal(media.title, '测试视频');
  assert.equal(media.extension, 'mp4');
  assert.equal(media.scope.documentId, 'doc-a');
  assert.equal(media.headers.Referer, 'https://www.bilibili.com/video/BV1');
});

test('YouTube 分块地址走 parseYouTubePlayback（同步，标题取缓存）', () => {
  h.reset();
  h.tabUpdated(8, { title: 'YouTube 测试 - YouTube' });

  const details = {
    tabId: 8,
    frameId: 0,
    documentId: 'doc-b',
    url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?itag=137&id=vid123&mime=video%2Fmp4&clen=1024&dur=12.5&range=0-1023'
  };

  assert.doesNotThrow(() => h.sendHeaders(details));
  const media = h.upserts(8)[0];
  assert.ok(media, '应当产出 YouTube 媒体');
  assert.equal(media.title, 'YouTube 测试 [1080P 高清视频轨]');
  assert.equal(media.extension, 'mp4');
  assert.equal(media.size, 1024);
  assert.equal(media.url.includes('range='), false, '分块参数必须去掉，否则只能下到第一段');
});

test('只有 Content-Type 没有后缀时，靠响应头认出媒体', () => {
  h.reset();
  h.tabUpdated(9, { title: '响应头测试' });

  h.headersReceived({
    tabId: 9,
    frameId: 0,
    documentId: 'doc-c',
    url: 'https://cdn.example.com/stream/xyz',
    responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }]
  });

  const media = h.upserts(9)[0];
  assert.ok(media, 'MIME 命中时应当入库');
  assert.equal(media.extension, 'mp4');
});

test('分片（.ts/.m4s）与非媒体请求都不入库', () => {
  h.reset();
  h.tabUpdated(10, { title: '分片测试' });

  h.sendHeaders({ tabId: 10, frameId: 0, documentId: 'doc-d', url: 'https://cdn.example.com/seg/1.ts' });
  h.sendHeaders({ tabId: 10, frameId: 0, documentId: 'doc-d', url: 'https://cdn.example.com/seg/2.m4s' });
  h.sendHeaders({ tabId: 10, frameId: 0, documentId: 'doc-d', url: 'https://cdn.example.com/app.js' });

  assert.deepEqual(h.upserts(10), []);
});

test('标签页关闭后标题缓存一起清掉，冷启动只补一次', () => {
  h.reset();
  h.tabUpdated(42, { title: '关闭测试' });

  // 缓存命中：不再走 chrome.tabs.get
  h.sendHeaders({ tabId: 42, frameId: 0, documentId: 'd1', url: 'https://cdn.example.com/a.mp4' });
  assert.deepEqual(h.tabsGetCalls, [], '标题已缓存时不应再 IPC');

  h.tabRemoved(42);
  h.sendHeaders({ tabId: 42, frameId: 0, documentId: 'd2', url: 'https://cdn.example.com/b.mp4' });
  assert.deepEqual(h.tabsGetCalls, [42], '缓存被清掉后应补一次 tabs.get');
});
