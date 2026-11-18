import test from 'node:test';
import assert from 'node:assert/strict';

import { MUX_SOFT_LIMIT_BYTES, checkMuxBudget, describeBudgetFailure } from '../../src/core/limits.js';

const MB = 1024 * 1024;

test('体积未知时放行（探测失败不应阻止用户）', () => {
  const budget = checkMuxBudget({ videoBytes: null, audioBytes: 10 * MB });
  assert.equal(budget.ok, true);
  assert.equal(budget.reason, 'UNKNOWN_SIZE');
  assert.equal(budget.totalBytes, null);
});

test('预算内放行，并给出合计体积', () => {
  const budget = checkMuxBudget({ videoBytes: 300 * MB, audioBytes: 20 * MB });
  assert.equal(budget.ok, true);
  assert.equal(budget.totalBytes, 320 * MB);
  assert.equal(budget.reason, 'WITHIN_BUDGET');
});

test('超过预算时拒绝并给出原因', () => {
  const budget = checkMuxBudget({ videoBytes: 1500 * MB, audioBytes: 50 * MB });
  assert.equal(budget.ok, false);
  assert.equal(budget.reason, 'OVER_BUDGET');
  assert.ok(budget.totalBytes > MUX_SOFT_LIMIT_BYTES);
});

test('只有视频轨时也能判断（音频缺失按 0 计）', () => {
  const budget = checkMuxBudget({ videoBytes: 100 * MB, audioBytes: null });
  assert.equal(budget.ok, true);
  assert.equal(budget.totalBytes, 100 * MB);
});

test('可以覆盖预算（测试与特殊场景）', () => {
  const budget = checkMuxBudget({ videoBytes: 10 * MB, audioBytes: 10 * MB, limitBytes: 15 * MB });
  assert.equal(budget.ok, false);
});

test('失败说明是人话，带两个体积', () => {
  const text = describeBudgetFailure({ totalBytes: 1500 * MB, limitBytes: 1200 * MB });
  assert.match(text, /1\.46 GB/);
  assert.match(text, /1\.17 GB/);
  assert.match(text, /只保存视频轨/);
});
