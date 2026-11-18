/**
 * 文本解锁器守卫（AUDIT F5）
 *
 * 曾经的做法是往页面里插一个内联 <script> 去改主世界，严格 CSP 的站点
 * （script-src 'self' + 没有 unsafe-inline，例如 fanqienovel / GitHub）会直接拒掉：
 *   "Executing inline script violates the following Content Security Policy directive"
 * 解锁在那些站点上是静默失效的。现在的分工是：
 *   · 隔离世界（text_unlocker.js）负责 CSS / 捕获事件 / DOM 内联属性；
 *   · 主世界（page_hooks.js，manifest 里 world: "MAIN"）负责 window / document 上的处理器；
 *   · 沟通走 window.postMessage，不产生任何 <script> 节点。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(ROOT, 'src');
const UNLOCKER = readFileSync(path.join(SRC, 'content/text_unlocker.js'), 'utf8');
const HOOKS = readFileSync(path.join(SRC, 'content/page_hooks.js'), 'utf8');
const MARK = '__resourceHelperHooks';

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (full.endsWith('.js')) acc.push(full);
  }
  return acc;
}

function createHarness() {
  const created = [];
  const appended = [];
  const posted = [];
  const messageListeners = [];

  function makeElement(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      id: '',
      textContent: '',
      style: {},
      appendChild(child) { appended.push(child); return child; },
      remove() {},
      removeAttribute() {},
      setAttribute() {}
    };
    created.push(el);
    return el;
  }

  const head = makeElement('head');
  const body = makeElement('body');
  const document = {
    title: '测试文章标题',
    head,
    body,
    documentElement: makeElement('html'),
    getElementById(id) { return appended.find((el) => el.id === id) || null; },
    createElement: makeElement,
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {}
  };

  const window = {
    location: { hostname: 'example.com' },
    addEventListener() {},
    removeEventListener() {},
    postMessage(data) { posted.push(data); },
    getComputedStyle() { return { zIndex: 'auto', opacity: '1', backgroundColor: 'rgb(255, 255, 255)' }; }
  };

  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
  }

  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { messageListeners.push(fn); } }
    }
  };

  const sandbox = {
    window,
    document,
    chrome,
    MutationObserver: FakeMutationObserver,
    Node: { ELEMENT_NODE: 1, DOCUMENT_FRAGMENT_NODE: 11 },
    console: { log() {}, warn() {}, error() {} }
  };

  vm.runInNewContext(UNLOCKER, sandbox, { filename: 'text_unlocker.js' });

  /** 模拟侧边栏发来的一条消息，返回 sendResponse 的内容 */
  function send(message) {
    let response;
    for (const listener of messageListeners) {
      const kept = listener(message, {}, (value) => { response = value; });
      if (kept === true) break;
    }
    return response;
  }

  return { created, appended, posted, send, window, document };
}

test('解锁不再往页面里插 <script>（严格 CSP 会拦掉）', () => {
  const h = createHarness();
  const response = h.send({ type: 'SNIFFER_UNLOCK_TEXT' });

  assert.equal(response.success, true);
  const scripts = h.created.filter((el) => el.tagName === 'SCRIPT');
  assert.deepEqual(scripts, [], '不得创建 <script> 节点：script-src 严格时会被 CSP 拒绝');
  assert.ok(h.created.some((el) => el.tagName === 'STYLE'), '样式仍然由隔离世界补');
});

test('主世界解锁改为发 postMessage 指令', () => {
  const h = createHarness();
  h.send({ type: 'SNIFFER_UNLOCK_TEXT' });

  const command = h.posted.find((item) => item && item[MARK] === 'cmd');
  assert.ok(command, '应当向主世界发一条 cmd 消息');
  assert.equal(command.action, 'unlock-text');
});

test('两侧的握手标记与指令名一致，主世界确实有处理分支', () => {
  assert.ok(UNLOCKER.includes("'" + MARK + "'"), '内容脚本的标记必须与主世界一致');
  assert.ok(HOOKS.includes("'" + MARK + "'"), '主世界钩子的标记变了');
  assert.match(HOOKS, /action === 'unlock-text'/, 'page_hooks.js 缺少 unlock-text 分支');
});

test('全仓不再有内联 <script> 注入（AUDIT F5 的通用守卫）', () => {
  const violations = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (/createElement\(\s*['"]script['"]\s*\)/.test(text)) {
      violations.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(violations, [], '内联脚本在严格 CSP 站点上必被拦，请改用 MAIN world 脚本或 executeScript');
});
