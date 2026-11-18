import test from 'node:test';
import assert from 'node:assert/strict';

import { HISTORY_STATES } from '../../src/core/history.js';

function makeChrome(initial) {
  const store = new Map();
  if (initial !== undefined) store.set('downloadHistory', initial);
  return {
    store,
    chrome: {
      storage: {
        local: {
          async get(key) { return store.has(key) ? { [key]: store.get(key) } : {}; },
          async set(payload) { for (const [k, v] of Object.entries(payload)) store.set(k, JSON.parse(JSON.stringify(v))); }
        }
      }
    }
  };
}

async function fresh() {
  const module = await import('../../src/bg/history.js');
  module.resetHistoryCache();
  return module;
}

test('记录一次下载并发起落盘', async () => {
  const fake = makeChrome([]);
  globalThis.chrome = fake.chrome;
  const { recordDownload, flushHistoryNow } = await fresh();

  await recordDownload({ id: 't1', title: '某视频', url: 'https://x/v.mp4', mode: 'direct', ts: Date.now() });
  await flushHistoryNow();

  const stored = fake.store.get('downloadHistory');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].title, '某视频');
  delete globalThis.chrome;
});

test('按任务 id 更新状态', async () => {
  const fake = makeChrome([]);
  globalThis.chrome = fake.chrome;
  const { recordDownload, updateHistory, loadHistory } = await fresh();

  await recordDownload({ id: 't1', title: 'A', url: 'https://x/a.mp4', ts: Date.now() });
  await updateHistory({ id: 't1' }, { status: HISTORY_STATES.COMPLETED, size: 2048 });

  const list = await loadHistory(true);
  assert.equal(list[0].status, HISTORY_STATES.COMPLETED);
  assert.equal(list[0].size, 2048);
  delete globalThis.chrome;
});

test('按浏览器下载 id 更新状态', async () => {
  const fake = makeChrome([]);
  globalThis.chrome = fake.chrome;
  const { recordDownload, updateHistory, loadHistory } = await fresh();

  await recordDownload({ id: 't1', title: 'A', url: 'https://x/a.mp4', browserDownloadId: 77, ts: Date.now() });
  await updateHistory({ browserDownloadId: 77 }, { status: HISTORY_STATES.FAILED });

  const list = await loadHistory(true);
  assert.equal(list[0].status, HISTORY_STATES.FAILED);
  delete globalThis.chrome;
});

test('清空历史', async () => {
  const fake = makeChrome([{ id: 'old', title: 'X', url: 'https://x/x.mp4', ts: Date.now(), status: 'completed' }]);
  globalThis.chrome = fake.chrome;
  const { loadHistory, clearHistory } = await fresh();

  assert.equal((await loadHistory(true)).length, 1);
  await clearHistory();
  assert.deepEqual(fake.store.get('downloadHistory'), []);
  delete globalThis.chrome;
});

test('storage 抛错时退化为空历史而不是崩溃', async () => {
  globalThis.chrome = { storage: { local: { async get() { throw new Error('denied'); }, async set() { throw new Error('denied'); } } } };
  const { loadHistory } = await fresh();
  assert.deepEqual(await loadHistory(true), []);
  delete globalThis.chrome;
});
