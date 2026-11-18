import test from 'node:test';
import assert from 'node:assert/strict';

import { TASK_STATES, TaskQueue } from '../../src/core/task-queue.js';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 0));

test('默认串行：前一个跑完才跑下一个', async () => {
  const order = [];
  const queue = new TaskQueue();
  const a = queue.add({ label: 'A', run: async () => { order.push('A:start'); await tick(5); order.push('A:end'); } });
  const b = queue.add({ label: 'B', run: async () => { order.push('B:start'); order.push('B:end'); } });

  await Promise.all([a, b]);
  assert.deepEqual(order, ['A:start', 'A:end', 'B:start', 'B:end']);
});

test('并发度大于 1 时并行执行', async () => {
  const queue = new TaskQueue({ concurrency: 2 });
  let running = 0;
  let peak = 0;
  const task = () => queue.add({
    run: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await tick(5);
      running -= 1;
    }
  });

  await Promise.all([task(), task(), task()]);
  assert.equal(peak, 2, '峰值并发应为 2');
});

test('任务失败不会卡住队列，后一个继续跑', async () => {
  const queue = new TaskQueue();
  const events = [];
  const failed = queue.add({ run: async () => { throw new Error('boom'); } });
  const next = queue.add({ run: async () => { events.push('next'); return 'ok'; } });

  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'ok');
  assert.deepEqual(events, ['next']);
});

test('快照反映运行与排队状态', async () => {
  const queue = new TaskQueue();
  const seen = [];
  queue.onChange = (snapshot) => seen.push(snapshot);

  const first = queue.add({ label: 'A', run: () => tick(5) });
  const second = queue.add({ label: 'B', run: () => tick(1) });
  assert.equal(queue.size, 1, '一个在跑，一个在排');
  assert.equal(queue.busy, true);

  await Promise.all([first, second]);
  assert.equal(queue.size, 0);
  assert.equal(queue.busy, false);
  assert.ok(seen.length >= 3, '应当通知过多次状态变化');
});

test('取消排队中的任务：被拒绝，正在跑的照常完成', async () => {
  const queue = new TaskQueue();
  let runningDone = false;
  const running = queue.add({ run: async () => { await tick(10); runningDone = true; return 'done'; } });
  const queued = queue.add({ run: async () => 'never' });

  assert.equal(queue.cancelPending(), 1);
  await assert.rejects(queued, (e) => e.code === 'TASK_CANCELLED');
  assert.equal(await running, 'done');
  assert.equal(runningDone, true);
});

test('非法任务被拒绝', async () => {
  const queue = new TaskQueue();
  await assert.rejects(queue.add({}), /run/);
  await assert.rejects(queue.add(null), /run/);
});

test('历史记录保留最近完成的任务', async () => {
  const queue = new TaskQueue();
  await Promise.all([
    queue.add({ label: 'A', run: async () => 1 }),
    queue.add({ label: 'B', run: async () => 2 })
  ]);
  const states = queue.history.map((item) => item.state);
  assert.deepEqual(states, [TASK_STATES.DONE, TASK_STATES.DONE]);
  assert.equal(queue.snapshot().recent.length, 2);
});
