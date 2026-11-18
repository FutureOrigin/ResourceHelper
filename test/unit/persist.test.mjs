import test from 'node:test';
import assert from 'node:assert/strict';

import { GraphStore, STORAGE_KEY } from '../../src/bg/persist.js';

function fakeStorage() {
  const data = new Map();
  let writes = 0;
  return {
    data,
    get writes() { return writes; },
    async get(key) {
      return data.has(key) ? { [key]: data.get(key) } : {};
    },
    async set(obj) {
      writes += 1;
      for (const [k, v] of Object.entries(obj)) data.set(k, JSON.parse(JSON.stringify(v)));
    },
    async remove(key) {
      data.delete(key);
    }
  };
}

function observation(overrides) {
  return Object.assign({
    key: 'https://cdn.example.com/v/1080.mp4',
    title: '测试视频',
    site: 'example.com',
    scope: { tabId: 1, frameId: 0, documentId: 'D1', generation: 0 },
    variant: { id: 'v1', url: 'https://cdn.example.com/v/1080.mp4', extension: 'mp4' }
  }, overrides || {});
}

test('flush 后能从 storage 恢复出同样的节点', async () => {
  const storage = fakeStorage();
  const store = new GraphStore({ storage, debounceMs: 0 });
  await store.ready;
  store.graphFor(7).upsert(observation({ scope: { tabId: 7, frameId: 0, documentId: 'D', generation: 0 } }));
  await store.flush();

  const revived = new GraphStore({ storage, debounceMs: 0 });
  await revived.ready;
  assert.equal(revived.nodesFor(7).length, 1);
  assert.equal(revived.nodesFor(7)[0].title, '测试视频');
});

test('空 storage 启动时不抛错且返回空图', async () => {
  const store = new GraphStore({ storage: fakeStorage(), debounceMs: 0 });
  assert.equal(await store.ready, false);
  assert.deepEqual(store.nodesFor(3), []);
});

test('storage 抛异常时恢复失败但不影响后续使用', async () => {
  const broken = {
    async get() { throw new Error('boom'); },
    async set() { throw new Error('boom'); },
    async remove() { throw new Error('boom'); }
  };
  const store = new GraphStore({ storage: broken, debounceMs: 0 });
  assert.equal(await store.ready, false);
  store.graphFor(1).upsert(observation());
  assert.equal(store.nodesFor(1).length, 1);
});

test('scheduleFlush 合并短时间内的多次变更', async () => {
  const storage = fakeStorage();
  const store = new GraphStore({ storage, debounceMs: 20 });
  await store.ready;
  const graph = store.graphFor(1);
  graph.upsert(observation());
  store.scheduleFlush();
  graph.upsert(observation({ key: 'k2', variant: { id: 'v2', url: 'https://cdn.example.com/v/2.mp4', videoUrl: 'https://cdn.example.com/v/2.mp4', extension: 'mp4' } }));
  store.scheduleFlush();
  graph.upsert(observation({ key: 'k3', variant: { id: 'v3', url: 'https://cdn.example.com/v/3.mp4', videoUrl: 'https://cdn.example.com/v/3.mp4', extension: 'mp4' } }));
  store.scheduleFlush();
  // 20ms 去抖 + 40ms 等待在 CI 上偶发失败（事件循环被其它测试挤占），
  // 这里放宽到 150ms：断言的是"合并成一次"，不是"多久写完"
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(storage.writes, 1, '三次变更只应写一次 storage');
  const payload = storage.data.get(STORAGE_KEY);
  assert.equal(payload.tabs.length, 1);
  assert.equal(payload.tabs[0].snapshot.nodes.length, 3);
});

test('超过 maxTabs 时优先保留最近使用的标签页', async () => {
  let now = 1000;
  const storage = fakeStorage();
  const store = new GraphStore({ storage, debounceMs: 0, maxTabs: 2, now: () => now });
  await store.ready;
  for (const tabId of [1, 2, 3]) {
    now += 10;
    store.graphFor(tabId).upsert(observation({
      key: 'k' + tabId,
      scope: { tabId, frameId: 0, documentId: 'D', generation: 0 }
    }));
  }
  now += 10;
  store.touch(2);
  const payload = store.buildPayload();
  const kept = payload.tabs.map((t) => t.tabId);
  assert.deepEqual(kept, [2, 3]);
});

test('drop 会移除该标签页并安排一次持久化', async () => {
  const storage = fakeStorage();
  const store = new GraphStore({ storage, debounceMs: 0 });
  await store.ready;
  store.graphFor(5).upsert(observation());
  await store.flush();
  assert.equal(store.drop(5), true);
  await store.flush();
  const payload = storage.data.get(STORAGE_KEY);
  assert.equal(payload.tabs.length, 0);
});

test('恢复时丢弃已超期节点（ttl 生效）', async () => {
  const storage = fakeStorage();
  let now = 1000;
  const store = new GraphStore({ storage, debounceMs: 0, now: () => now });
  await store.ready;
  store.graphFor(9).upsert(observation());
  await store.flush();

  now = 1000 + 31 * 60 * 1000; // 超过默认 30 分钟 ttl
  const revived = new GraphStore({ storage, debounceMs: 0, now: () => now });
  await revived.ready;
  assert.equal(revived.nodesFor(9).length, 0, '超期节点不应被恢复');
});

test('没有 storage 后端时退化为纯内存，不抛错', async () => {
  const store = new GraphStore({ storage: null, debounceMs: 0 });
  store.graphFor(1).upsert(observation());
  assert.equal(store.nodesFor(1).length, 1);
  await store.flush();
});
