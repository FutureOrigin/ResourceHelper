import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HISTORY_LIMIT,
  HISTORY_STATES,
  addEntry,
  formatRelativeTime,
  normalizeEntry,
  patchByBrowserId,
  patchEntry,
  pruneHistory,
  summarize
} from '../../src/core/history.js';

const entry = (overrides) => Object.assign({
  id: 'h1',
  title: '某视频',
  url: 'https://cdn.example.com/v.mp4',
  filename: '某视频.mp4',
  mode: 'direct',
  status: HISTORY_STATES.INITIATED,
  ts: 1000
}, overrides || {});

test('缺少标题与地址的记录被丢弃', () => {
  assert.equal(normalizeEntry(null), null);
  assert.equal(normalizeEntry({}), null);
  assert.equal(normalizeEntry({ title: '只有标题' }).title, '只有标题');
});

test('规整：未知状态回退为 initiated，非法体积变 null', () => {
  const item = normalizeEntry(entry({ status: 'weird', size: 'abc' }));
  assert.equal(item.status, HISTORY_STATES.INITIATED);
  assert.equal(item.size, null);
});

test('合流记录保留音轨地址（重下时需要）', () => {
  const item = normalizeEntry(entry({ mode: 'mux', audioUrl: 'https://x/a.m4a' }));
  assert.equal(item.audioUrl, 'https://x/a.m4a');
  assert.equal(normalizeEntry(entry({})).audioUrl, '');
});

test('插入：最新的排最前，同 id 覆盖而不是重复', () => {
  let list = addEntry([], entry({ id: 'a' }));
  list = addEntry(list, entry({ id: 'b' }));
  assert.deepEqual(list.map((item) => item.id), ['b', 'a']);

  list = addEntry(list, entry({ id: 'a', title: '覆盖后的标题' }));
  assert.equal(list.length, 2);
  assert.equal(list[0].title, '覆盖后的标题');
});

test('插入：超过上限截断', () => {
  let list = [];
  for (let i = 0; i < 5; i += 1) list = addEntry(list, entry({ id: 'h' + i }), 3);
  assert.equal(list.length, 3);
  assert.equal(list[0].id, 'h4');
  assert.equal(HISTORY_LIMIT, 300);
});

test('按 id 与浏览器下载 id 更新状态', () => {
  let list = addEntry([], entry({ id: 'a', browserDownloadId: 42 }));
  list = patchEntry(list, 'a', { status: HISTORY_STATES.COMPLETED, size: 1024 });
  assert.equal(list[0].status, HISTORY_STATES.COMPLETED);
  assert.equal(list[0].size, 1024);

  list = patchByBrowserId(list, 42, { status: HISTORY_STATES.FAILED });
  assert.equal(list[0].status, HISTORY_STATES.FAILED);
  assert.equal(patchEntry(list, 'missing', { status: 'x' }).length, 1, '找不到时原样返回');
});

test('裁剪：超期记录被移除，空值被过滤', () => {
  const now = Date.now();
  const fresh = entry({ id: 'fresh', ts: now - 60 * 1000 });
  const old = entry({ id: 'old', ts: now - 40 * 24 * 60 * 60 * 1000 });
  const pruned = pruneHistory([fresh, old, null], { now, maxAgeDays: 30 });
  assert.deepEqual(pruned.map((item) => item.id), ['fresh']);
});

test('统计与相对时间', () => {
  const list = [
    entry({ id: 'a', status: HISTORY_STATES.COMPLETED, size: 100 }),
    entry({ id: 'b', status: HISTORY_STATES.FAILED }),
    entry({ id: 'c', status: HISTORY_STATES.INITIATED })
  ];
  const stats = summarize(list);
  assert.equal(stats.total, 3);
  assert.equal(stats.completed, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.bytes, 100);

  // 用真实时间基准：ts 必须为正数（0 表示"没有时间"，会返回空串）
  const now = Date.now();
  assert.equal(formatRelativeTime(now - 30 * 1000, now), '刚刚');
  assert.equal(formatRelativeTime(now - 5 * 60 * 1000, now), '5 分钟前');
  assert.equal(formatRelativeTime(now - 3 * 60 * 60 * 1000, now), '3 小时前');
  assert.equal(formatRelativeTime(now - 2 * 24 * 60 * 60 * 1000, now), '2 天前');
  assert.equal(formatRelativeTime(0, now), '');
});
