/**
 * 图片扫描的回归测试（VM 沙箱加载真实 extractor.js）
 *
 * 覆盖 P2 的性能改造后仍然正确：
 *   · srcset 取最大项、同一图片多来源去重
 *   · 1×1 埋点、小图标被过滤
 *   · 样式表里的无名 url 不进列表（噪声太大），但内联 style 带尺寸的会进
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE = readFileSync(path.join(ROOT, 'src/content/extractor.js'), 'utf8');

function fakeImg(overrides) {
  const attrs = Object.assign({}, overrides.attrs || {});
  return Object.assign({
    currentSrc: '',
    src: '',
    srcset: '',
    naturalWidth: 0,
    naturalHeight: 0,
    alt: '',
    title: '',
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    }
  }, overrides, { attrs: undefined });
}

function runScan(fixture) {
  const doc = {
    title: '测试页',
    styleSheets: fixture.sheets || [],
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
    addEventListener() {},
    getElementById() { return null; },
    createElement() { return { style: {}, classList: { add() {} }, appendChild() {}, remove() {} }; },
    querySelector(selector) {
      return pick(selector)[0] || null;
    },
    querySelectorAll(selector) {
      return pick(selector);
    }
  };

  function pick(selector) {
    if (selector === 'img') return fixture.images || [];
    if (selector === 'picture source') return fixture.sources || [];
    if (selector === 'svg image') return [];
    if (selector === 'video[poster]') return [];
    if (selector.startsWith('meta[')) return fixture.metas || [];
    if (selector === 'audio') return [];
    if (selector === 'script') return fixture.scripts || [];
    if (selector === '[style*="background"]') return fixture.styleNodes || [];
    if (selector === '*') return fixture.allNodes || [];
    return [];
  }

  const listeners = [];
  const sandbox = {
    window: {
      location: { hostname: 'example.com', href: 'https://example.com/', pathname: '/', origin: 'https://example.com' },
      addEventListener() {},
      removeEventListener() {},
      getComputedStyle() { return { backgroundImage: 'none' }; },
      __snifferExtractorInitialized: false
    },
    document: doc,
    location: { hostname: 'example.com', href: 'https://example.com/', pathname: '/', origin: 'https://example.com' },
    URL,
    console: { log() {}, warn() {}, debug() {}, info() {}, error() {} },
    chrome: {
      runtime: {
        onMessage: { addListener(fn) { listeners.push(fn); } },
        sendMessage() { return Promise.resolve(); }
      }
    },
    PerformanceObserver: class { observe() {} },
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout() {},
    clearInterval() {}
  };

  vm.runInNewContext(SOURCE, sandbox, { filename: 'extractor.js' });

  const scan = listeners.find((fn) => fn.length >= 1);
  assert.ok(scan, '内容脚本应当注册消息监听');
  let response = null;
  scan({ type: 'SNIFFER_SCAN_IMAGES' }, {}, (payload) => { response = payload; });
  return response;
}

test('srcset 取最大项，普通 src 也会保留', () => {
  const response = runScan({
    images: [fakeImg({
      src: 'https://cdn.example.com/a.jpg',
      naturalWidth: 1600,
      naturalHeight: 900,
      alt: '封面',
      srcset: 'https://cdn.example.com/a-400.jpg 400w, https://cdn.example.com/a-1600.jpg 1600w'
    })]
  });
  const urls = Array.from(response.images, (item) => item.src);
  assert.ok(urls.includes('https://cdn.example.com/a.jpg'));
  assert.ok(urls.includes('https://cdn.example.com/a-1600.jpg'));
  assert.ok(urls.includes('https://cdn.example.com/a-400.jpg'));
  const max = response.images.find((item) => item.src.endsWith('a-1600.jpg'));
  assert.equal(max.fromSrcsetMax, true);
});

test('1×1 埋点与 32×32 小图标被过滤', () => {
  const response = runScan({
    images: [
      fakeImg({ src: 'https://cdn.example.com/pixel.gif', naturalWidth: 1, naturalHeight: 1 }),
      fakeImg({ src: 'https://cdn.example.com/icon.png', naturalWidth: 32, naturalHeight: 32 }),
      fakeImg({ src: 'https://cdn.example.com/photo.jpg', naturalWidth: 800, naturalHeight: 600 })
    ]
  });
  // 结果数组来自 VM 沙箱（不同 realm 的 Array），转成本地数组再比较
  const urls = Array.from(response.images, (item) => item.src);
  assert.deepEqual(urls, ['https://cdn.example.com/photo.jpg']);
});

test('同一地址多来源只保留一条，并合并最大尺寸与 alt', () => {
  const response = runScan({
    images: [
      fakeImg({ src: 'https://cdn.example.com/same.jpg', naturalWidth: 300, naturalHeight: 200 }),
      fakeImg({ src: 'https://cdn.example.com/same.jpg', naturalWidth: 1200, naturalHeight: 800, alt: '大图' })
    ]
  });
  assert.equal(response.images.length, 1);
  assert.equal(response.images[0].width, 1200);
  assert.equal(response.images[0].alt, '大图');
});

test('样式表里的无名 url 被过滤，内联 style 带尺寸的保留', () => {
  const sheet = {
    cssRules: [{ cssText: '.hero { background-image: url("https://cdn.example.com/bg.jpg"); }' }]
  };
  const inlineNode = {
    getAttribute(name) { return name === 'style' ? 'background: url("https://cdn.example.com/inline.jpg")' : null; },
    getBoundingClientRect() { return { width: 640, height: 360 }; }
  };
  const response = runScan({ sheets: [sheet], styleNodes: [inlineNode] });
  const urls = Array.from(response.images, (item) => item.src);
  assert.ok(urls.includes('https://cdn.example.com/inline.jpg'), '内联背景图应保留');
  assert.ok(!urls.includes('https://cdn.example.com/bg.jpg'), '样式表无名 url 噪声太大，应过滤');
});

test('跨域样式表读取失败不影响其余扫描', () => {
  const hostileSheet = {
    get cssRules() { throw new Error('SecurityError'); }
  };
  const response = runScan({
    sheets: [hostileSheet],
    images: [fakeImg({ src: 'https://cdn.example.com/ok.jpg', naturalWidth: 800, naturalHeight: 600 })]
  });
  assert.deepEqual(Array.from(response.images, (item) => item.src), ['https://cdn.example.com/ok.jpg']);
});

test('结果按"已知尺寸优先"排序', () => {
  const response = runScan({
    images: [
      fakeImg({ src: 'https://cdn.example.com/small.jpg', naturalWidth: 200, naturalHeight: 200 }),
      fakeImg({ src: 'https://cdn.example.com/big.jpg', naturalWidth: 1920, naturalHeight: 1080 })
    ]
  });
  assert.equal(response.images[0].src, 'https://cdn.example.com/big.jpg');
});
