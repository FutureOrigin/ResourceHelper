import test from 'node:test';
import assert from 'node:assert/strict';

import { ProbeQueue } from '../../src/bg/enricher.js';

function deferredProbe() {
  const pending = [];
  const probe = (url) => new Promise((resolve) => {
    pending.push({ url, resolve });
  });
  return { probe, pending };
}

test('入队后按并发上限执行', async () => {
  const { probe, pending } = deferredProbe();
  const queue = new ProbeQueue({ probe, concurrency: 2, onResult: () => {} });
  queue.request('https://x/a.mp4', { id: 'a' });
  queue.request('https://x/b.mp4', { id: 'b' });
  queue.request('https://x/c.mp4', { id: 'c' });
  await Promise.resolve();
  assert.equal(pending.length, 2, '并发上限为 2 时只应同时跑两个');
  pending[0].resolve({ ok: true });
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(pending.length, 3, '腾出名额后应启动第三个');
  pending[1].resolve({ ok: true });
  pending[2].resolve({ ok: true });
  await queue.drain();
  assert.equal(queue.done, 3);
});

test('同一 URL 只探一次', async () => {
  let calls = 0;
  const queue = new ProbeQueue({
    probe: async () => { calls += 1; return { ok: true }; },
    onResult: () => {}
  });
  assert.equal(queue.request('https://x/a.mp4', {}), true);
  assert.equal(queue.request('https://x/a.mp4', {}), false);
  await queue.drain();
  assert.equal(calls, 1);
});

test('blob/data/扩展内部地址直接跳过', async () => {
  let calls = 0;
  const queue = new ProbeQueue({ probe: async () => { calls += 1; return { ok: true }; }, onResult: () => {} });
  assert.equal(queue.request('blob:https://x/1', {}), false);
  assert.equal(queue.request('data:video/mp4;base64,AAAA', {}), false);
  assert.equal(queue.request('chrome-extension://abc/x.mp4', {}), false);
  assert.equal(queue.request('', {}), false);
  await queue.drain();
  assert.equal(calls, 0);
});

test('探测失败计数但不抛出，也不阻塞后续任务', async () => {
  const seen = [];
  let index = 0;
  const queue = new ProbeQueue({
    probe: async () => {
      index += 1;
      if (index === 1) throw new Error('boom');
      return { ok: true, totalBytes: 1024 };
    },
    concurrency: 1,
    onResult: (meta, result) => seen.push({ meta, result })
  });
  queue.request('https://x/a.mp4', { id: 'a' });
  queue.request('https://x/b.mp4', { id: 'b' });
  await queue.drain();
  assert.equal(queue.failed, 1);
  assert.equal(queue.done, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].meta.id, 'b');
});

test('条目上限保护，避免无限增长', async () => {
  const queue = new ProbeQueue({ probe: async () => ({ ok: true }), maxEntries: 2, onResult: () => {} });
  assert.equal(queue.request('https://x/1', {}), true);
  assert.equal(queue.request('https://x/2', {}), true);
  assert.equal(queue.request('https://x/3', {}), false);
  await queue.drain();
  assert.equal(queue.has('https://x/1'), true);
  assert.equal(queue.has('https://x/3'), false);
});

test('onResult 拿到入队时携带的元信息与探测结果', async () => {
  const got = [];
  const queue = new ProbeQueue({
    probe: async (url) => ({ ok: true, url, totalBytes: 42 }),
    onResult: (meta, result, url) => got.push({ meta, result, url })
  });
  queue.request('https://x/a.mp4', { key: 'g1', variantId: 'v1' });
  await queue.drain();
  assert.equal(got[0].meta.key, 'g1');
  assert.equal(got[0].meta.variantId, 'v1');
  assert.equal(got[0].result.totalBytes, 42);
  assert.equal(got[0].url, 'https://x/a.mp4');
});
