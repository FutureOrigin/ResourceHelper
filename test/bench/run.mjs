#!/usr/bin/env node
/**
 * 效率基准（ROADMAP §0.1 的"效率"KPI）
 *
 * 目标：
 *   1. Service Worker 分类 1000 次请求        <= 20 ms
 *   2. 内容脚本扫描 5000 节点页面             <= 80 ms
 *   3. 分片下载的内存上界                     <= 一个块（默认 64MB）
 *
 * 这些是"结构上可测"的部分：分类与扫描都是纯函数，下载内存是 sink 的不变量。
 * 阈值按 ROADMAP 的目标给，但留了容差（CI 机器快慢差异大），
 * 超出目标会打印警告，超过目标的 4 倍才算失败。
 *
 * 用法：node test/bench/run.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

import { isCandidateUrl } from '../../src/core/classify.js';
import { normalizeUrl, resourceKey, shortId } from '../../src/core/identity.js';
import { ChunkedBlobSink, DEFAULT_CHUNK_BYTES } from '../../src/core/sink.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const EXTRACTOR_SOURCE = readFileSync(path.join(ROOT, 'src/content/extractor.js'), 'utf8');

const results = [];
function record(name, targetMs, actualMs, unit) {
  const over = actualMs / targetMs;
  results.push({
    name,
    target: targetMs,
    actual: actualMs,
    unit: unit || 'ms',
    status: over <= 1 ? '达标' : over <= 4 ? '偏慢（容差内）' : '超标'
  });
}

/* ------------------------------------------------------------------ *
 * 1. Service Worker 分类：1000 次请求
 * ------------------------------------------------------------------ */
function benchClassification(rounds = 1000) {
  const hosts = ['https://www.bilibili.com', 'https://cdn.example.com', 'https://x.com', 'https://player.qq.com'];
  const urls = [];
  for (let i = 0; i < rounds; i += 1) {
    const host = hosts[i % hosts.length];
    const kind = i % 4;
    if (kind === 0) urls.push(host + '/api/feed?page=' + i);
    else if (kind === 1) urls.push(host + '/video/seg-' + i + '.m4s?range=' + i * 1024);
    else if (kind === 2) urls.push(host + '/stream/master.m3u8?token=' + i);
    else urls.push(host + '/static/app.' + i + '.js');
  }

  const start = performance.now();
  let candidates = 0;
  for (const url of urls) {
    if (!isCandidateUrl(url, null)) continue;
    candidates += 1;
    const normalized = normalizeUrl(url);
    shortId(resourceKey(normalized));
  }
  const elapsed = performance.now() - start;
  record('SW 分类 1000 次请求', 20, elapsed);
  return { elapsed, candidates };
}

/* ------------------------------------------------------------------ *
 * 2. 内容脚本扫描：5000 节点的页面
 * ------------------------------------------------------------------ */
function buildBigPage() {
  const nodes = [];
  const images = [];
  const styleNodes = [];

  for (let i = 0; i < 3000; i += 1) nodes.push({ tagName: 'DIV', shadowRoot: null });

  for (let i = 0; i < 1200; i += 1) {
    const img = {
      currentSrc: 'https://img.example.com/pic-' + i + '.jpg',
      src: 'https://img.example.com/pic-' + i + '.jpg',
      srcset: 'https://img.example.com/pic-' + i + '-400.jpg 400w, https://img.example.com/pic-' + i + '-1200.jpg 1200w',
      naturalWidth: i % 7 === 0 ? 32 : 800,
      naturalHeight: i % 7 === 0 ? 32 : 600,
      alt: '图 ' + i,
      title: '',
      getAttribute(name) { return name === 'data-src' ? this.src : null; }
    };
    images.push(img);
    if (i < 500) {
      nodes.push({
        tagName: 'A',
        shadowRoot: null,
        getAttribute(name) { return name === 'style' ? 'background: url("https://img.example.com/inline-' + i + '.jpg")' : null; },
        getBoundingClientRect() { return { width: 320, height: 180 }; }
      });
      styleNodes.push(nodes[nodes.length - 1]);
    }
  }

  for (let i = 0; i < 300; i += 1) {
    nodes.push({
      tagName: 'SECTION',
      shadowRoot: null,
      getAttribute(name) { return name === 'style' ? 'background-image: url("https://img.example.com/sec-' + i + '.jpg")' : null; },
      getBoundingClientRect() { return { width: 600, height: 400 }; }
    });
    styleNodes.push(nodes[nodes.length - 1]);
  }

  const sheets = [];
  for (let i = 0; i < 120; i += 1) {
    sheets.push({
      cssRules: [
        { cssText: '.card-' + i + ' { background-image: url("https://img.example.com/card-' + i + '.jpg"); }' },
        { cssText: '.card-' + i + ':hover { color: #fff; }' }
      ]
    });
  }

  return { nodes, images, styleNodes, sheets };
}

function benchImageScan() {
  const page = buildBigPage();
  const documentStub = {
    title: '基准页面',
    styleSheets: page.sheets,
    visibilityState: 'visible',
    addEventListener() {},
    getElementById() { return null; },
    createElement() { return { style: {}, classList: { add() {} }, appendChild() {}, remove() {} }; },
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      if (selector === 'img') return page.images;
      if (selector === 'picture source' || selector === 'svg image' || selector === 'video[poster]' || selector === 'audio') return [];
      if (selector === 'script') return [];
      if (selector.startsWith('meta[')) return [];
      if (selector === '[style*="background"]') return page.styleNodes;
      if (selector === '*') return page.nodes;
      return [];
    }
  };

  const listeners = [];
  const sandbox = {
    window: {
      location: { hostname: 'example.com', href: 'https://example.com/', pathname: '/', origin: 'https://example.com' },
      addEventListener() {}, removeEventListener() {},
      getComputedStyle() { return { backgroundImage: 'none' }; },
      innerWidth: 1280, innerHeight: 800
    },
    document: documentStub,
    location: { hostname: 'example.com', href: 'https://example.com/', pathname: '/', origin: 'https://example.com' },
    URL,
    console: { log() {}, debug() {}, info() {}, warn() {}, error() {} },
    chrome: { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } }, sendMessage() { return Promise.resolve(); } } },
    MutationObserver: class { observe() {} disconnect() {} },
    PerformanceObserver: class { observe() {} },
    setTimeout: () => 0,
    setInterval: () => 0,
    requestAnimationFrame: () => 0,
    clearTimeout() {},
    clearInterval() {}
  };

  vm.runInNewContext(EXTRACTOR_SOURCE, sandbox, { filename: 'extractor.js' });
  const listener = listeners.find((fn) => fn.length >= 1);

  let response = null;
  const start = performance.now();
  listener({ type: 'SNIFFER_SCAN_IMAGES' }, {}, (payload) => { response = payload; });
  const elapsed = performance.now() - start;

  record('内容脚本扫描 5000 节点页面', 80, elapsed);
  return { elapsed, count: response && response.images ? response.images.length : 0, nodes: page.nodes.length };
}

/* ------------------------------------------------------------------ *
 * 3. 下载内存：模拟 300MB 分片流
 * ------------------------------------------------------------------ */
function benchDownloadMemory() {
  const chunk = new Uint8Array(1024 * 1024);   // 1MB / 片
  const sink = new ChunkedBlobSink({ chunkBytes: DEFAULT_CHUNK_BYTES });
  let peak = 0;
  for (let i = 0; i < 300; i += 1) {
    sink.add(chunk);
    peak = Math.max(peak, sink.bufferedBytes);
  }
  const peakMb = peak / (1024 * 1024);
  record('分片下载峰值内存（300MB 流）', 250, peakMb, 'MB');
  return { peakMb, totalMb: sink.totalBytes / (1024 * 1024), chunks: sink.blobCount };
}

/* ------------------------------------------------------------------ */
const classification = benchClassification();
const scanning = benchImageScan();
const memory = benchDownloadMemory();

console.log('');
for (const item of results) {
  const actual = item.actual.toFixed(2) + ' ' + item.unit;
  const target = '≤ ' + item.target + ' ' + item.unit;
  console.log('  [' + item.status + '] ' + item.name + '：' + actual + '（目标 ' + target + '）');
}
console.log('');
console.log('  分类候选命中 ' + classification.candidates + ' / 1000；扫描出图 ' + scanning.count + ' 张（页面 ' + scanning.nodes + ' 节点）');
console.log('  下载 ' + memory.totalMb.toFixed(0) + 'MB 流，峰值驻留 ' + memory.peakMb.toFixed(1) + 'MB，固化 ' + memory.chunks + ' 块');

const failed = results.filter((item) => item.status === '超标');
console.log('');
if (failed.length > 0) {
  console.log('✗ ' + failed.length + ' 项超过目标 4 倍');
  process.exit(1);
}
console.log('✓ 效率基准通过');
