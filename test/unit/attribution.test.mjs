import test from 'node:test';
import assert from 'node:assert/strict';

import { NavigationTracker, attributeMedia } from '../../src/bg/attribution.js';

test('attributeMedia 挂上 documentId / frameId / tabId', () => {
  const media = { url: 'https://x/a.mp4' };
  const out = attributeMedia(media, { documentId: 'D1', frameId: 3, tabId: 9 });
  assert.equal(out.document_id, 'D1');
  assert.equal(out.frame_id, 3);
  assert.equal(out.tab_id, 9);
});

test('attributeMedia 对缺失字段不做覆盖', () => {
  const media = { document_id: 'KEEP' };
  attributeMedia(media, { frameId: 0 });
  assert.equal(media.document_id, 'KEEP');
  assert.equal(media.frame_id, 0);
});

test('attributeMedia 对空输入返回原值', () => {
  assert.equal(attributeMedia(null, { tabId: 1 }), null);
  const media = { a: 1 };
  assert.equal(attributeMedia(media, null), media);
});

test('NavigationTracker 初始代次为 0，bump 后递增', () => {
  const tracker = new NavigationTracker();
  assert.equal(tracker.generationOf(5), 0);
  assert.equal(tracker.bump(5, 'D1'), 1);
  assert.equal(tracker.bump(5, 'D2'), 2);
  assert.equal(tracker.generationOf(5), 2);
  assert.equal(tracker.documentOf(5), 'D2');
});

test('不同标签页的代次互不影响', () => {
  const tracker = new NavigationTracker();
  tracker.bump(1, 'A');
  assert.equal(tracker.generationOf(1), 1);
  assert.equal(tracker.generationOf(2), 0);
});

test('filterByGeneration 只留当前代次，无 scope 的节点视为当前', () => {
  const tracker = new NavigationTracker();
  tracker.bump(3, 'D1');
  tracker.bump(3, 'D2');   // 当前代次 = 2
  const nodes = [
    { key: 'a', scope: { generation: 1 } },
    { key: 'b', scope: { generation: 2 } },
    { key: 'legacy' }
  ];
  const kept = tracker.filterByGeneration(nodes, 3).map((n) => n.key);
  assert.deepEqual(kept, ['b', 'legacy']);
});

test('reset 后回到代次 0', () => {
  const tracker = new NavigationTracker();
  tracker.bump(4, 'D');
  tracker.reset(4);
  assert.equal(tracker.generationOf(4), 0);
});
