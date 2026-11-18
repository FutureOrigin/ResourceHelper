/**
 * 整页快照：子框架装配单测
 *
 * 这里的错误最隐蔽：把 A 框架的内容塞进 B 框架，文件照样能打开，
 * 只是内容张冠李戴；转义顺序错一层，正文会变成 `&amp;lt;` 天书。
 * 所以每条规则都单独验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFrameTree,
  embedChildFrame,
  matchFrameDescriptors,
  normalizeFrameUrl,
  planFrameAssembly,
  revertFramePlaceholder
} from '../../src/core/page-frames.js';

test('frame 树：深度、根与"最深优先"顺序', () => {
  const tree = buildFrameTree([
    { frameId: 0, parentFrameId: -1, url: 'https://e.com/' },
    { frameId: 1, parentFrameId: 0, url: 'https://e.com/a' },
    { frameId: 2, parentFrameId: 1, url: 'https://ads.example/x' },
    { frameId: 3, parentFrameId: -1, url: 'about:blank' }
  ]);

  assert.equal(tree.byId.size, 4);
  assert.deepEqual(tree.roots.sort(), [0, 3]);
  assert.equal(tree.byId.get(2).depth, 2);
  assert.equal(tree.byId.get(1).depth, 1);
  assert.deepEqual(tree.deepestFirst, [2, 1, 0, 3]);
});

test('frame 树：环与坏数据不会死循环', () => {
  const tree = buildFrameTree([
    { frameId: 5, parentFrameId: 6, url: 'https://a/' },
    { frameId: 6, parentFrameId: 5, url: 'https://b/' },
    { frameId: 'x', parentFrameId: 0, url: 'https://c/' }
  ]);
  assert.equal(tree.byId.size, 2, '非法 frameId 应被丢弃');
  assert.deepEqual(tree.deepestFirst.sort(), [5, 6]);
});

test('URL 规范化：尾部斜杠与大小写主机不影响配对', () => {
  assert.equal(normalizeFrameUrl('https://E.com/a/'), 'https://e.com/a');
  assert.equal(normalizeFrameUrl('https://e.com/a#x'), 'https://e.com/a');
  assert.equal(normalizeFrameUrl('https://e.com/'), 'https://e.com/');
  assert.equal(normalizeFrameUrl('about:blank'), 'about:blank');
  assert.equal(normalizeFrameUrl(''), '');
});

test('配对：精确命中，且同一个 frame 不会被分给两个 iframe', () => {
  const frames = [
    { frameId: 1, parentFrameId: 0, url: 'https://e.com/a' },
    { frameId: 2, parentFrameId: 0, url: 'https://e.com/b' }
  ];
  const claimed = new Set();
  const first = matchFrameDescriptors(0, [{ index: 0, src: 'https://e.com/a' }], frames, claimed);
  assert.equal(first.get(0).frameId, 1);
  assert.ok(claimed.has(1));

  const second = matchFrameDescriptors(0, [
    { index: 0, src: 'https://e.com/a' },
    { index: 1, src: 'https://e.com/b' }
  ], frames, claimed);
  assert.equal(second.has(0), false, '已被占用的 frame 不能再配一次');
  assert.equal(second.get(1).frameId, 2);
});

test('配对：重定向后地址变了，退一步只比 pathname', () => {
  const frames = [{ frameId: 7, parentFrameId: 0, url: 'https://e.com/final?token=1' }];
  const picked = matchFrameDescriptors(0, [{ index: 3, src: 'https://e.com/final' }], frames, new Set());
  assert.equal(picked.get(3).frameId, 7);
});

test('配对：不同父框架的子框架不会被认领', () => {
  const frames = [{ frameId: 9, parentFrameId: 4, url: 'https://e.com/a' }];
  const picked = matchFrameDescriptors(0, [{ index: 0, src: 'https://e.com/a' }], frames, new Set());
  assert.equal(picked.size, 0);
});

test('嵌入：src 占位符换成 srcdoc，并去掉登记属性', () => {
  const token = 'tk';
  const html = '<div><iframe data-rh-frame="0" src="rhframe://tk/0"></iframe></div>';
  const out = embedChildFrame(html, token, 0, '<p class="x">hi</p>');

  assert.equal(out, '<div><iframe srcdoc="&lt;p class=&quot;x&quot;&gt;hi&lt;/p&gt;"></iframe></div>');
  assert.ok(!out.includes('data-rh-frame'));
  assert.ok(!out.includes('rhframe:'));
});

test('嵌入：子文档只被转义一层（不在父层再转一次）', () => {
  const child = '<img src="data:image/png;base64,AA">';
  const out = embedChildFrame('<iframe src="rhframe://t/1"></iframe>', 't', 1, child);
  assert.ok(out.includes('srcdoc="&lt;img src=&quot;data:image/png;base64,AA&quot;&gt;"'));
  assert.ok(!out.includes('&amp;lt;'), '不能出现二次转义');
});

test('嵌入：占位符不存在时原样返回（不误伤别的属性）', () => {
  const html = '<iframe src="https://e.com/x"></iframe>';
  assert.equal(embedChildFrame(html, 't', 0, '<p>x</p>'), html);
});

test('回退：抓不到的框架还原成绝对地址，仍然去掉登记属性', () => {
  const html = '<iframe data-rh-frame="2" src="rhframe://t/2"></iframe>';
  const out = revertFramePlaceholder(html, 't', 2, 'https://ads.example/x?a=1&b=2');
  assert.equal(out, '<iframe src="https://ads.example/x?a=1&amp;b=2"></iframe>');
});

test('装配计划：只安排真正采集到 HTML 的框架，且从深到浅', () => {
  const plan = planFrameAssembly([
    { frameId: 0, parentFrameId: -1, html: '<html>top</html>' },
    { frameId: 1, parentFrameId: 0, html: '<html>child</html>' },
    { frameId: 2, parentFrameId: 1, html: null },
    { frameId: 3, parentFrameId: 0, html: '<html>other</html>' }
  ]);
  assert.deepEqual(plan.order, [1, 3, 0], '深度 1 的两个框架先处理，父文档最后');
  assert.equal(plan.byId.size, 4);
});
