/**
 * 回归测试：content/extractor.js 的页面数据采集（B 站 / YouTube）
 *
 * 背景 bug：旧实现用惰性正则截取内联 JSON，在第一个 '}' 处收尾，
 * 导致 "Expected ',' or '}'" —— 本测试先用旧正则复现该 bug，再验证现在能完整解析。
 *
 * P4 之后内容脚本不再自己映射媒体，而是把原始数据交给后台适配器，
 * 所以这里断言的是 ON_PAGE_DATA 的 payload。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXTRACTOR_SOURCE = readFileSync(path.join(ROOT, 'src/content/extractor.js'), 'utf8');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${String(e && e.message).split('\n').join('\n        ')}`);
  }
}

function runExtractor({ hostname, href, title = '测试页面标题', scripts = [], globals = {}, domMedia = [] }) {
  const sent = [];
  const warnings = [];
  const location = { hostname, href: href || `https://${hostname}/`, origin: `https://${hostname}`, pathname: '/', search: '' };

  const documentStub = {
    title,
    querySelectorAll(selector) {
      if (selector === 'script') return scripts.map((text) => ({ textContent: text }));
      if (selector === 'video') return domMedia.filter((item) => item.kind === 'video');
      if (selector === 'audio') return domMedia.filter((item) => item.kind === 'audio');
      return [];
    },
    querySelector() { return null; },
    addEventListener() {},
    getElementById() { return null; },
    createElement() { return { style: {}, classList: { add() {} }, appendChild() {}, remove() {} }; },
    body: { appendChild() {} },
    styleSheets: [],
    visibilityState: 'visible'
  };

  const windowStub = Object.assign({
    location,
    document: documentStub,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle() { return { backgroundImage: 'none' }; },
    innerWidth: 1280,
    innerHeight: 800
  }, globals);

  const sandbox = {
    window: windowStub,
    document: documentStub,
    location,
    URL,
    console: {
      log() {}, debug() {}, info() {},
      warn: (...args) => warnings.push(args.map((a) => (a && a.message) || String(a)).join(' ')),
      error: (...args) => warnings.push(args.map((a) => (a && a.message) || String(a)).join(' '))
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(message) { sent.push(message); return Promise.resolve({ ok: true }); }
      }
    },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 0,
    setInterval: () => 0,
    requestAnimationFrame: () => 0,
    clearTimeout() {},
    clearInterval() {}
  };

  vm.runInNewContext(EXTRACTOR_SOURCE, sandbox, { filename: 'extractor.js' });

  const pageData = sent.filter((m) => m && m.type === 'ON_PAGE_DATA').map((m) => m.payload);
  return { sent, pageData, warnings };
}

const trackUrl = (kind, id) =>
  `https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/25/123456789/${id}-1-30080.m4s?bvc=vod&kind=${kind}&id=${id}`;

function makePlayInfo({ videoCount = 3, audioCount = 2 } = {}) {
  const video = [];
  const ids = [80, 64, 32, 16, 120, 116];
  for (let i = 0; i < videoCount; i++) {
    const id = ids[i % ids.length];
    video.push({
      id,
      baseUrl: trackUrl(`v${id}`, id),
      backupUrl: [trackUrl(`b1-${id}`, id)],
      bandwidth: 1200000 + i * 1000,
      codecs: 'avc1.640032',
      width: id >= 80 ? 1920 : 1280,
      height: id >= 80 ? 1080 : 720,
      SegmentBase: { Initialization: '0-995', indexRange: '996-1843' },
      desc: i === 1 ? 'a};b"c' : `track-${i}`,
      path: 'C:\\\\tmp\\\\'
    });
  }
  const audio = [];
  for (let i = 0; i < audioCount; i++) {
    audio.push({ id: 30280 + i, baseUrl: trackUrl(`a${30280 + i}`, 30280 + i), bandwidth: 320000, codecid: 0 });
  }
  return {
    code: 0, message: '0', ttl: 1,
    data: {
      quality: 80, timelength: 734500,
      dash: { duration: 734, video, audio }
    }
  };
}

const playInfoScript = (jsonText, tail = '') => `window.__playinfo__=${jsonText};${tail}`;

console.log('\n[1] 旧实现在真实形状 playinfo 上的行为（bug 复现）');
const realistic = makePlayInfo();
const realisticJson = JSON.stringify(realistic);
const realisticScript = playInfoScript(realisticJson, '\nwindow.__INITIAL_STATE__={"a":1};');

check('fixture 的第一个 "}" 落在数千字符之后', () => {
  const start = realisticScript.indexOf('{');
  const offset = realisticScript.indexOf('}', start) - start + 1;
  console.log(`        第一个 '}' 距 JSON 起始 ${offset} 字符；完整 JSON 长 ${realisticJson.length} 字符`);
  assert.ok(offset > 200, `期望深位置，实际 ${offset}`);
});

check('旧正则截断后 JSON.parse 报错（bug 复现）', () => {
  const m = realisticScript.match(/window\.__playinfo__\s*=\s*({.+?});?/);
  assert.ok(m, '旧正则应当匹配到内容');
  let error = null;
  try { JSON.parse(m[1]); } catch (e) { error = e; }
  assert.ok(error, '截断文本应当解析失败');
  console.log(`        旧实现捕获 ${m[1].length} 字符 → ${error.message}`);
  assert.match(error.message, /Expected ',' or '}'/);
});

console.log('\n[2] 现在：B 站页面数据被完整采集');
const bili = runExtractor({
  hostname: 'www.bilibili.com',
  href: 'https://www.bilibili.com/video/BV1RqWe6EE6Q/',
  title: '某测试视频_哔哩哔哩_bilibili',
  scripts: [realisticScript]
});

check('发出了 ON_PAGE_DATA，且没有解析错误', () => {
  assert.equal(bili.pageData.length, 1, `实际 ${bili.pageData.length} 条`);
  assert.deepEqual(bili.warnings.filter((w) => w.includes('采集失败')), []);
});

check('payload 携带完整的 dash 轨道（未被截断）', () => {
  const payload = bili.pageData[0];
  assert.equal(payload.json.data.dash.video.length, 3);
  assert.equal(payload.json.data.dash.audio.length, 2);
  assert.equal(payload.json.data.dash.video[0].baseUrl, realistic.data.dash.video[0].baseUrl);
  assert.equal(payload.title, '某测试视频_哔哩哔哩_bilibili');
  assert.ok(payload.url.includes('BV1RqWe6EE6Q'));
});

console.log('\n[3] 边界：JSON 字符串内的 } 与转义引号');
const tricky = { code: 0, data: { note: '};{"a":1}', escaped: 'say \\"hi\\" }', dash: { video: [{ id: 80, baseUrl: 'https://example.test/v.m4s' }], audio: [] } } };
const trickyRun = runExtractor({ hostname: 'www.bilibili.com', scripts: [playInfoScript(JSON.stringify(tricky))] });
check('字符串内的 } 不影响解析', () => {
  assert.equal(trickyRun.pageData.length, 1);
  assert.equal(trickyRun.pageData[0].json.data.note, '};{"a":1}');
  assert.equal(trickyRun.pageData[0].json.data.dash.video[0].baseUrl, 'https://example.test/v.m4s');
});

console.log('\n[4] 边界：脚本被截断 / 页面无数据');
const truncatedRun = runExtractor({ hostname: 'www.bilibili.com', scripts: [realisticScript.slice(0, Math.floor(realisticJson.length / 2))] });
check('截断脚本不发消息', () => {
  assert.equal(truncatedRun.pageData.length, 0);
});
const noData = runExtractor({ hostname: 'www.bilibili.com', scripts: ['window.__INITIAL_STATE__={"videoData":{"bvid":"BV1xx"}};'] });
check('没有目标 JSON 时不发消息', () => {
  assert.equal(noData.pageData.length, 0);
});

console.log('\n[5] YouTube ytInitialPlayerResponse');
const ytResponse = {
  videoDetails: { title: 'YT 测试视频', lengthSeconds: '212', videoId: 'abc123XYZ' },
  streamingData: {
    formats: [{ itag: 18, url: 'https://rr1.googlevideo.com/videoplayback?itag=18', qualityLabel: '360p', width: 640, height: 360 }],
    adaptiveFormats: [
      { itag: 137, mimeType: 'video/mp4', url: 'https://rr1.googlevideo.com/videoplayback?itag=137', width: 1920, height: 1080 },
      { itag: 140, mimeType: 'audio/mp4', url: 'https://rr1.googlevideo.com/videoplayback?itag=140' }
    ]
  }
};
const ytScript = `var ytInitialPlayerResponse = ${JSON.stringify(ytResponse)};var meta = {"x":1};`;
const yt = runExtractor({ hostname: 'www.youtube.com', href: 'https://www.youtube.com/watch?v=abc123XYZ', title: 'YT 测试视频 - YouTube', scripts: [ytScript] });
check('完整解析 streamingData', () => {
  assert.equal(yt.pageData.length, 1);
  assert.equal(yt.pageData[0].json.streamingData.adaptiveFormats.length, 2);
  assert.equal(yt.pageData[0].json.videoDetails.videoId, 'abc123XYZ');
});

console.log('\n[6] 同一页多次赋值：取信息最全的那个');
const multi = runExtractor({
  hostname: 'www.bilibili.com',
  scripts: [
    'window.__playinfo__ = {"code":-404,"message":"啥都木有"};',
    'var x = "__playinfo__ = {not json}";',
    playInfoScript(JSON.stringify(makePlayInfo({ videoCount: 1, audioCount: 1 })))
  ]
});
check('跳过占位的 -404 响应，取到完整数据', () => {
  assert.equal(multi.pageData.length, 1);
  assert.equal(multi.pageData[0].json.code, 0);
  assert.equal(multi.pageData[0].json.data.dash.video.length, 1);
});

console.log('\n[7] DOM 媒体采集');
const fakeNode = (kind, src, extra) => Object.assign({
  kind,
  src,
  currentSrc: src,
  duration: 120,
  videoWidth: 640,
  videoHeight: 360,
  mediaKeys: null,
  getBoundingClientRect: () => ({ width: 640, height: 360 })
}, extra || {});

check('没有 DOM 媒体时不发消息', () => {
  const plain = runExtractor({ hostname: 'example.com' });
  assert.equal(plain.pageData.length, 0);
});

check('video/audio 地址被采集，并且过滤 blob:', () => {
  const withDom = runExtractor({
    hostname: 'v.qq.com',
    href: 'https://v.qq.com/x/cover/abc.html',
    domMedia: [
      fakeNode('video', 'https://apd-vlive.apdcdn.tc.qq.com/main.m3u8?token=1'),
      fakeNode('video', 'blob:https://v.qq.com/1234'),
      fakeNode('video', 'https://apd-vlive.apdcdn.tc.qq.com/main.m3u8?token=1'),
      fakeNode('audio', 'https://music.example.com/song.mp3')
    ]
  });
  assert.equal(withDom.pageData.length, 1);
  const media = withDom.pageData[0].media;
  assert.equal(media.length, 2, '重复地址与 blob: 都要去掉');
  assert.equal(media[0].kind, 'video');
  assert.equal(media[0].ext, 'm3u8');
  assert.equal(media[0].height, 360);
  assert.equal(media[1].kind, 'audio');
  assert.equal(media[1].ext, 'mp3');
});

console.log('');
if (failures > 0) {
  console.log(`✗ ${failures} 项失败`);
  process.exit(1);
}
console.log('✓ 全部通过');
