/**
 * 整页快照：编排流水线单测（假依赖）
 *
 * 这是整个功能最值得测的部分：内容脚本与后台都是 Chrome API，Node 里跑不了；
 * 但"采集 → 样式闭包 → 批量抓取 → 逐层装配 → 落盘"这条链路可以注入假依赖完整跑一遍。
 * 只要这里绿，剩下的风险就只剩 DOM 序列化与真实网络两种。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { archivePage } from '../../src/sidepanel/modules/page_archive.js';

const TOKEN = 'tk00000000';
const CHILD_TOKEN = 'tkchild000';

function pageResponse(overrides) {
  return Object.assign({
    success: true,
    token: TOKEN,
    base: 'https://e.com/page',
    title: '测试页',
    url: 'https://e.com/page',
    html: '<html><head></head><body></body></html>',
    resources: [],
    frames: [],
    stats: { images: 0, styles: 0, scripts: 0, skipped: 0 }
  }, overrides);
}

function makeDeps(config) {
  const settings = config || {};
  const state = {
    fetchBatches: [],
    finalized: null,
    injected: 0,
    asked: [],
    listFramesCalls: 0
  };

  const deps = {
    async sendToTab(tabId, message, options) {
      state.asked.push({ tabId: tabId, message: message, options: options || null });
      if (typeof settings.sendToTab === 'function') return settings.sendToTab(tabId, message, options);
      return pageResponse(settings.response);
    },
    async inject(tabId, frameId) {
      state.injected++;
      state.injectedFrame = frameId;
      return settings.injectResult !== false;
    },
    async listFrames(tabId) {
      state.listFramesCalls++;
      return settings.frames || [];
    },
    async fetchResources(requests, context) {
      state.fetchBatches.push({ requests: requests, context: context });
      return requests.map((request) => {
        if (typeof settings.fetch === 'function') return settings.fetch(request, context);
        return { url: request.url, ok: false, status: 404, bytes: 0, error: 'HTTP_404' };
      });
    },
    async finalize(input) {
      state.finalized = input;
      return 7;
    },
    now: () => Date.parse('2026-11-18T03:04:05.000Z')
  };

  return { deps: deps, state: state };
}

const PNG = { ok: true, status: 200, mime: 'image/png', bytes: 12, base64: 'iVBORw0KGgo=' };

test('基本链路：<style> 里的 url() 与 <img> 都变成 data URI', async () => {
  const html = '<html><head><style>' + 'rhres://' + TOKEN + '/0</style></head>'
    + '<body><img src="rhres://' + TOKEN + '/1"><a href="https://e.com/next">n</a></body></html>';

  const harness = makeDeps({
    response: pageResponse({
      html: html,
      resources: [
        { index: 0, kind: 'css-text', url: 'https://e.com/page', base: 'https://e.com/page', context: 'css-block', text: '.hero{background:url(bg.png)}' },
        { index: 1, kind: 'binary', url: 'https://cdn.e.com/a.png', base: 'https://e.com/page', context: 'attribute' }
      ]
    }),
    fetch: () => PNG
  });

  const phases = [];
  const result = await archivePage({
    tabId: 5,
    pageUrl: 'https://e.com/page',
    options: {},
    settings: { filenameTemplate: '{title}.{ext}' },
    deps: harness.deps,
    onProgress: (progress) => phases.push(progress.phase)
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.filename, '测试页.html');
  assert.equal(result.downloadId, 7);

  const doc = await harness.state.finalized.blob.text();
  assert.ok(doc.startsWith('<!DOCTYPE html>'), '必须是完整文档');
  assert.ok(doc.includes('<style>.hero{background:url("data:image/png;base64,iVBORw0KGgo=")}</style>'));
  assert.ok(doc.includes('<img src="data:image/png;base64,iVBORw0KGgo=">'));
  assert.ok(!doc.includes('rhres://'), '不能残留任何占位符');
  assert.ok(doc.includes('https://e.com/next'), '未处理的属性原样保留');

  assert.equal(harness.state.finalized.meta.mode, 'page');
  assert.equal(harness.state.finalized.meta.url, 'https://e.com/page');
  assert.ok(result.bytes > 0);

  // 进度会为同一个阶段报告"开始/结束"两次，这里只看阶段顺序
  const order = phases.filter((phase, index) => index === 0 || phases[index - 1] !== phase);
  assert.deepEqual(order, ['collect', 'css', 'resources', 'assemble', 'download']);
});

test('同源与跨域资源都按 kind 交给后台批量抓，且同一 URL 只抓一次', async () => {
  const html = '<html><body>'
    + '<img src="rhres://' + TOKEN + '/0">'
    + '<img src="rhres://' + TOKEN + '/1">'
    + '</body></html>';
  const shared = 'https://cdn.e.com/same.png';

  const harness = makeDeps({
    response: pageResponse({
      html: html,
      resources: [
        { index: 0, kind: 'binary', url: shared },
        { index: 1, kind: 'binary', url: shared }
      ]
    }),
    fetch: () => PNG
  });

  const result = await archivePage({ tabId: 1, pageUrl: 'https://e.com/page', options: {}, deps: harness.deps });
  assert.equal(result.ok, true);

  const requested = harness.state.fetchBatches.flatMap((batch) => batch.requests.map((request) => request.url));
  assert.deepEqual(requested, [shared], '重复地址必须去重');
  assert.equal(harness.state.fetchBatches[0].requests[0].kind, 'binary');
  assert.equal(harness.state.fetchBatches[0].context.pageUrl, 'https://e.com/page');
});

test('@import 会被展开，嵌套样式表的相对地址按它自己的地址解析', async () => {
  const harness = makeDeps({
    response: pageResponse({
      html: '<html><head><style>rhres://' + TOKEN + '/0</style></head></html>',
      resources: [
        { index: 0, kind: 'css-text', url: 'https://e.com/page', base: 'https://e.com/page', context: 'css-block', text: '@import url(theme/main.css);' }
      ]
    }),
    fetch: (request) => {
      if (request.kind === 'css') {
        assert.equal(request.url, 'https://e.com/theme/main.css');
        return { url: request.url, ok: true, status: 200, mime: 'text/css', bytes: 30, text: '.x{background:url(../img/x.png)}' };
      }
      assert.equal(request.url, 'https://e.com/img/x.png', '相对地址必须按样式表地址解析');
      return PNG;
    }
  });

  const result = await archivePage({ tabId: 1, pageUrl: 'https://e.com/page', options: {}, deps: harness.deps });
  assert.equal(result.ok, true);

  const doc = await harness.state.finalized.blob.text();
  assert.ok(!doc.includes('@import'), '@import 必须被展开');
  assert.ok(doc.includes('.x{background:url("data:image/png;base64,iVBORw0KGgo=")}'));
});

test('@import 抓不到时保留绝对地址与媒体条件，而不是断链', async () => {
  const harness = makeDeps({
    response: pageResponse({
      html: '<html><head><style>rhres://' + TOKEN + '/0</style></head></html>',
      resources: [
        { index: 0, kind: 'css-text', url: 'https://e.com/page', base: 'https://e.com/page', context: 'css-block', text: '@import url(missing.css) print;' }
      ]
    })
  });

  const result = await archivePage({ tabId: 1, pageUrl: 'https://e.com/page', options: {}, deps: harness.deps });
  assert.equal(result.ok, true);
  const doc = await harness.state.finalized.blob.text();
  assert.ok(doc.includes('@import url("https://e.com/missing.css") print;'));
  assert.ok(result.stats.skipped >= 1);
});

test('抓取失败：退回绝对地址并如实记账，不让整份快照失败', async () => {
  const harness = makeDeps({
    response: pageResponse({
      html: '<html><body><img src="rhres://' + TOKEN + '/0"></body></html>',
      resources: [{ index: 0, kind: 'binary', url: 'https://cdn.e.com/blocked.png?a=1&b=2' }]
    }),
    fetch: () => ({ url: 'https://cdn.e.com/blocked.png', ok: false, status: 403, bytes: 0, error: 'HTTP_403' })
  });

  const result = await archivePage({ tabId: 1, pageUrl: 'https://e.com/page', options: {}, deps: harness.deps });
  assert.equal(result.ok, true);
  assert.equal(result.stats.skipped, 1);
  assert.equal(result.skipped[0].reason, 'FETCH_FAILED');

  const doc = await harness.state.finalized.blob.text();
  assert.ok(doc.includes('src="https://cdn.e.com/blocked.png?a=1&amp;b=2"'), '属性里的 & 必须转义');
});

test('关掉"内联图片"时不发抓取请求，属性保留在线地址', async () => {
  const harness = makeDeps({
    response: pageResponse({
      html: '<html><body><img src="rhres://' + TOKEN + '/0"></body></html>',
      resources: [{ index: 0, kind: 'binary', url: 'https://cdn.e.com/a.png' }]
    })
  });

  const result = await archivePage({
    tabId: 1,
    pageUrl: 'https://e.com/page',
    options: { inlineImages: false },
    deps: harness.deps
  });
  assert.equal(result.ok, true);
  assert.equal(harness.state.fetchBatches.length, 0);
  const doc = await harness.state.finalized.blob.text();
  assert.ok(doc.includes('src="https://cdn.e.com/a.png"'));
});

test('iframe：跨域子文档先进 srcdoc，父文档最后装配', async () => {
  const top = pageResponse({
    token: TOKEN,
    title: '父页',
    html: '<html><body>parent<iframe data-rh-frame="0" src="rhframe://' + TOKEN + '/0"></iframe></body></html>',
    frames: [{ index: 0, src: 'https://e.com/child' }]
  });

  const child = {
    success: true,
    frameId: 1,
    token: CHILD_TOKEN,
    base: 'https://e.com/child',
    title: '子页',
    url: 'https://e.com/child',
    html: '<html><body><img src="rhres://' + CHILD_TOKEN + '/0"></body></html>',
    resources: [{ index: 0, kind: 'binary', url: 'https://e.com/c.png' }],
    frames: [],
    stats: { images: 1, styles: 0, scripts: 0, skipped: 0 }
  };

  const harness = makeDeps({
    frames: [
      { frameId: 0, parentFrameId: -1, url: 'https://e.com/page' },
      { frameId: 1, parentFrameId: 0, url: 'https://e.com/child' }
    ],
    sendToTab: (tabId, message, options) => {
      if (options && options.frameId === 1) return child;
      return top;
    },
    fetch: () => PNG
  });

  const result = await archivePage({
    tabId: 1,
    pageUrl: 'https://e.com/page',
    options: { embedFrames: true },
    settings: { filenameTemplate: '{title}.{ext}' },
    deps: harness.deps
  });

  assert.equal(result.ok, true);
  assert.equal(result.stats.frames, 1);
  const doc = await harness.state.finalized.blob.text();
  assert.ok(!doc.includes('rhframe://'), '框架占位符必须被替换');
  assert.ok(!doc.includes('data-rh-frame'), '登记属性必须清掉');
  assert.ok(doc.includes('srcdoc="&lt;html&gt;&lt;body&gt;&lt;img src=&quot;data:image/png;base64,'), '子文档只转义一层');
  assert.ok(doc.includes('parent'), '父文档内容保留');
});

test('iframe：子框架抓不到时保留绝对地址', async () => {
  const top = pageResponse({
    html: '<html><body><iframe data-rh-frame="0" src="rhframe://' + TOKEN + '/0"></iframe></body></html>',
    frames: [{ index: 0, src: 'https://ads.example/x' }]
  });

  const harness = makeDeps({
    // 浏览器报了 frame，但内容脚本不在（比如 about:blank 之类的不可注入页面）
    frames: [{ frameId: 0, parentFrameId: -1, url: 'https://e.com/page' }],
    sendToTab: (tabId, message, options) => {
      if (options && options.frameId) return { success: false, error: 'NO_RECEIVER' };
      return top;
    }
  });

  const result = await archivePage({ tabId: 1, pageUrl: 'https://e.com/page', options: {}, deps: harness.deps });
  assert.equal(result.ok, true);
  assert.equal(result.frames.failed, 1);
  const doc = await harness.state.finalized.blob.text();
  assert.ok(doc.includes('src="https://ads.example/x"'));
});

test('内容脚本不在时先注入再重试', async () => {
  let attempts = 0;
  const harness = makeDeps({
    response: pageResponse({ title: '注入后成功' }),
    sendToTab: () => {
      attempts++;
      if (attempts === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
      return pageResponse({ title: '注入后成功' });
    }
  });

  const result = await archivePage({ tabId: 1, pageUrl: 'https://e.com/page', options: {}, deps: harness.deps });
  assert.equal(result.ok, true);
  assert.equal(harness.state.injected, 1);
  assert.equal(attempts, 2);
});

test('页面始终不响应时给出可执行的原因', async () => {
  const harness = makeDeps({
    sendToTab: () => { throw new Error('Receiving end does not exist'); },
    injectResult: false
  });

  const result = await archivePage({ tabId: 1, pageUrl: 'chrome://settings', options: {}, deps: harness.deps });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'NO_RECEIVER');
  assert.match(result.message, /内部页面|刷新/);
});

test('没有标签页时直接拒绝', async () => {
  const harness = makeDeps({});
  const result = await archivePage({ tabId: 0, pageUrl: 'https://e.com/', options: {}, deps: harness.deps });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'NO_TAB');
});

test('抓回来是空身体时退回在线地址，不写坏 data URI', async () => {
  const harness = makeDeps({
    response: pageResponse({
      html: '<html><body><img src="rhres://' + TOKEN + '/0"></body></html>',
      resources: [{ index: 0, kind: 'binary', url: 'https://cdn.e.com/empty.png' }]
    }),
    fetch: () => ({ ok: true, status: 200, mime: 'image/png', bytes: 0, base64: '' })
  });

  const result = await archivePage({ tabId: 1, pageUrl: 'https://e.com/page', options: {}, deps: harness.deps });
  assert.equal(result.ok, true);
  assert.equal(result.skipped[0].reason, 'NO_CONTENT');

  const doc = await harness.state.finalized.blob.text();
  assert.ok(doc.includes('src="https://cdn.e.com/empty.png"'));
  assert.ok(!doc.includes('base64,'), '不能留下空的 data URI');
});

test('没有 bytes 时按 base64 长度计入预算，超了照样停手', async () => {
  const eightMb = 'A'.repeat(Math.ceil((8 * 1024 * 1024 * 4) / 3));
  const harness = makeDeps({
    response: pageResponse({
      html: '<html><body>'
        + '<img src="rhres://' + TOKEN + '/0">'
        + '<img src="rhres://' + TOKEN + '/1">'
        + '</body></html>',
      resources: [
        { index: 0, kind: 'binary', url: 'https://cdn.e.com/big1.png' },
        { index: 1, kind: 'binary', url: 'https://cdn.e.com/big2.png' }
      ]
    }),
    // 故意不给 bytes：预算只能靠 base64 长度反推，推错就等于没有预算
    fetch: () => ({ ok: true, status: 200, mime: 'image/png', base64: eightMb })
  });

  const result = await archivePage({
    tabId: 1,
    pageUrl: 'https://e.com/page',
    options: { limits: { maxTotalBytes: 10 * 1024 * 1024 } },
    deps: harness.deps
  });

  assert.equal(result.ok, true);
  assert.equal(result.stats.images, 1, '第二张 8MB 应被 10MB 预算挡掉');
  assert.ok(result.skipped.some((item) => item.reason === 'BUDGET'));

  const doc = await harness.state.finalized.blob.text();
  assert.ok(doc.includes('src="https://cdn.e.com/big2.png"'));
});

test('总量预算：超过上限后停止内联，其余保留在线地址', async () => {
  const harness = makeDeps({
    response: pageResponse({
      html: '<html><body>'
        + '<img src="rhres://' + TOKEN + '/0">'
        + '<img src="rhres://' + TOKEN + '/1">'
        + '</body></html>',
      resources: [
        { index: 0, kind: 'binary', url: 'https://cdn.e.com/big1.png' },
        { index: 1, kind: 'binary', url: 'https://cdn.e.com/big2.png' }
      ]
    }),
    fetch: () => ({ ok: true, status: 200, mime: 'image/png', bytes: 8 * 1024 * 1024, base64: 'AAAA' })
  });

  const result = await archivePage({
    tabId: 1,
    pageUrl: 'https://e.com/page',
    options: { limits: { maxTotalBytes: 10 * 1024 * 1024 } },
    deps: harness.deps
  });

  assert.equal(result.ok, true);
  assert.equal(result.stats.images, 1, '只应内联一张');
  assert.ok(result.skipped.some((item) => item.reason === 'BUDGET'));
  const doc = await harness.state.finalized.blob.text();
  assert.ok(doc.includes('src="https://cdn.e.com/big2.png"'));
});

/* ------------------------------------------------------------------ *
 * 体积优化
 * ------------------------------------------------------------------ */

function vocabularyOf(tags, classes) {
  return { tags: tags, classes: classes, ids: [], attrs: ['class'] };
}

test('按帧词表精简 CSS：匹配不到的规则被删，也不再抓它的背景图', async () => {
  const html = '<html><body><div class="used"></div><style>rhres://' + TOKEN + '/0</style></body></html>';
  const harness = makeDeps({
    response: pageResponse({
      html: html,
      vocabulary: vocabularyOf(['html', 'body', 'div', 'style'], ['used']),
      resources: [{
        index: 0,
        kind: 'css-text',
        url: 'https://e.com/page',
        base: 'https://e.com/page',
        context: 'css-block',
        text: '.used{color:red}.unused{background:url(unused.png)}'
      }]
    })
  });

  const result = await archivePage({ tabId: 1, pageUrl: 'https://e.com/page', options: {}, deps: harness.deps });
  assert.equal(result.ok, true);

  const doc = await harness.state.finalized.blob.text();
  assert.ok(doc.includes('.used{color:red}'), '能匹配的规则必须保留');
  assert.ok(!doc.includes('.unused'), '匹配不到的规则应被删掉');

  const requested = harness.state.fetchBatches.flatMap((batch) => batch.requests.map((request) => request.url));
  assert.deepEqual(requested, [], '被删规则里的背景图不该再抓');
  assert.ok(result.stats.cssPrunedBytes > 0, '要如实统计省下的字节');
  assert.equal(result.stats.cssPrunedRules, 1);
});

test('关掉"精简未使用的样式"时规则与背景图都原样保留', async () => {
  const html = '<html><body><div class="used"></div><style>rhres://' + TOKEN + '/0</style></body></html>';
  const harness = makeDeps({
    response: pageResponse({
      html: html,
      vocabulary: vocabularyOf(['html', 'body', 'div', 'style'], ['used']),
      resources: [{
        index: 0,
        kind: 'css-text',
        url: 'https://e.com/page',
        base: 'https://e.com/page',
        context: 'css-block',
        text: '.unused{background:url(unused.png)}'
      }]
    }),
    fetch: () => PNG
  });

  const result = await archivePage({
    tabId: 1,
    pageUrl: 'https://e.com/page',
    options: { removeUnusedCss: false },
    deps: harness.deps
  });
  assert.equal(result.ok, true);

  const requested = harness.state.fetchBatches.flatMap((batch) => batch.requests.map((request) => request.url));
  assert.deepEqual(requested, ['https://e.com/unused.png'], '关掉精简后仍应抓背景图');
  const doc = await harness.state.finalized.blob.text();
  assert.ok(doc.includes('.unused{background:url("data:image/png;base64,iVBORw0KGgo=")}'));
  assert.equal(result.stats.cssPrunedBytes, 0);
});

test('内容脚本报的隐藏元素数量会汇总进结果', async () => {
  const harness = makeDeps({
    response: pageResponse({ stats: { images: 0, styles: 0, scripts: 0, skipped: 0, hiddenRemoved: 7 } })
  });
  const result = await archivePage({ tabId: 1, pageUrl: 'https://e.com/page', options: {}, deps: harness.deps });
  assert.equal(result.ok, true);
  assert.equal(result.stats.hiddenRemoved, 7);
});

/* ------------------------------------------------------------------ *
 * 字体精简
 * ------------------------------------------------------------------ */

const FONT = { ok: true, status: 200, mime: 'font/woff2', bytes: 10, base64: 'AAAA' };

function stylePage(css) {
  return pageResponse({
    html: '<html><head><style>rhres://' + TOKEN + '/0</style></head><body><p>x</p></body></html>',
    resources: [{
      index: 0,
      kind: 'css-text',
      url: 'https://e.com/page',
      base: 'https://e.com/page',
      context: 'css-block',
      text: css
    }]
  });
}

function requestedUrls(harness) {
  return harness.state.fetchBatches.flatMap((batch) => batch.requests.map((request) => request.url));
}

test('字体精简：没人点名的 @font-face 在抓取之前就被删掉', async () => {
  const css = '@font-face{font-family:"Used";src:url(used.woff2)}'
    + '@font-face{font-family:"Orphan";src:url(orphan.woff2)}'
    + 'body{font-family:"Used"}';
  const harness = makeDeps({ response: stylePage(css), fetch: () => FONT });

  const result = await archivePage({ tabId: 1, pageUrl: 'https://e.com/page', options: {}, deps: harness.deps });
  assert.equal(result.ok, true);

  assert.deepEqual(requestedUrls(harness), ['https://e.com/used.woff2'], '没点名的字体不该被下载');
  const doc = await harness.state.finalized.blob.text();
  assert.ok(doc.includes('font-family:"Used"'), '用到的字体必须留下');
  assert.ok(!doc.includes('Orphan'), '整块 @font-face 应被删掉');
  assert.equal(result.stats.fontsPruned, 1);
  assert.equal(result.stats.fonts, 1, '只应内联一个字体');
});

test('字体精简：@font-face 的备用格式只抓第一个', async () => {
  const css = '@font-face{font-family:"Used";src:url(a.woff2) format("woff2"), url(a.woff) format("woff")}'
    + 'body{font-family:"Used"}';
  const harness = makeDeps({ response: stylePage(css), fetch: () => FONT });

  const result = await archivePage({ tabId: 1, pageUrl: 'https://e.com/page', options: {}, deps: harness.deps });
  assert.equal(result.ok, true);

  assert.deepEqual(requestedUrls(harness), ['https://e.com/a.woff2'], '浏览器只用第一个支持的格式');
  const doc = await harness.state.finalized.blob.text();
  assert.ok(doc.includes('url("data:font/woff2;base64,AAAA")'), doc);
  assert.ok(!doc.includes('a.woff'), '备用格式应从 src 里删掉');
  assert.equal(result.stats.fontsPruned, 1);
});

test('字体精简：有 @import 时整帧不动字体（导入的样式可能点名别的族）', async () => {
  const css = '@import url(theme.css);@font-face{font-family:"Orphan";src:url(orphan.woff2)}';
  const harness = makeDeps({
    response: stylePage(css),
    fetch: (request) => {
      if (request.url.endsWith('theme.css')) {
        return { ok: true, status: 200, mime: 'text/css', text: 'body{color:red}' };
      }
      return FONT;
    }
  });

  const result = await archivePage({ tabId: 1, pageUrl: 'https://e.com/page', options: {}, deps: harness.deps });
  assert.equal(result.ok, true);

  assert.ok(requestedUrls(harness).includes('https://e.com/orphan.woff2'), '@import 在场时应保留字体');
  assert.equal(result.stats.fontsPruned, 0);
});
