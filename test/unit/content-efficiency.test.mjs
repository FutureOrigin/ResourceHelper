/**
 * 内容脚本效率守卫（静态检查）
 *
 * 这几个约定很容易在后续改动里被"顺手"破坏，而且破坏后不会报错，只会在真实页面上
 * 悄悄烧 CPU（AUDIT E6 / E7 / C6）。所以用静态断言把它们钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (rel) => readFileSync(path.join(ROOT, 'src', rel), 'utf8');

test('内容脚本不再使用 setInterval 轮询', () => {
  for (const rel of ['content/extractor.js', 'content/inpage_overlay.js', 'content/text_unlocker.js']) {
    const source = read(rel);
    const hits = source.split(/\r?\n/)
      .map((line, index) => ({ line: line.trim(), no: index + 1 }))
      .filter((item) => item.line.includes('setInterval(') && !item.line.startsWith('//'));
    assert.deepEqual(hits, [], rel + ' 仍有定时轮询');
  }
});

test('悬浮层只在模块级注册一次全局点击监听', () => {
  const source = read('content/inpage_overlay.js');
  const clicks = source.match(/document\.addEventListener\(\s*["']click["']/g) || [];
  assert.equal(clicks.length, 1, '每实例监听会造成成千上万个监听器');
});

test('悬浮层不再修改宿主元素的定位样式', () => {
  const source = read('content/inpage_overlay.js');
  assert.ok(!source.includes('parent.style.position'), '不应把宿主的 position 改成 relative');
  assert.ok(source.includes('position: fixed'), '应当用 fixed 定位');
});

test('悬浮层用 IntersectionObserver 做视口驱动挂载', () => {
  const source = read('content/inpage_overlay.js');
  assert.ok(source.includes('IntersectionObserver'), '缺少视口观察器');
  assert.ok(source.includes('requestAnimationFrame'), '位置刷新应当合并到一帧');
});

test('extractor 用样式表解析代替逐元素 getComputedStyle', () => {
  const source = read('content/extractor.js');
  assert.ok(source.includes('styleSheets'), '应当解析 document.styleSheets');
  const calls = (source.match(/getComputedStyle\(/g) || []).length;
  assert.equal(calls, 0, '不应再对每个元素调用 getComputedStyle');
});
