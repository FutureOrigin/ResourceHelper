#!/usr/bin/env node
/**
 * 缺陷探针诊断：跑 test/probes 下的所有探针并汇总。
 *
 * 探针的语义是"已知坏"：在缺陷修复前，探针以非零码退出属于预期。
 * 这个脚本永远以 0 退出（它是诊断工具，不是门禁），只负责把现状打印清楚；
 * 真正的门禁是 npm test（node:test 单测里会断言正确行为）。
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'test/probes');
const files = readdirSync(DIR).filter((f) => f.endsWith('.cjs') || f.endsWith('.mjs')).sort();

let broken = 0;
for (const f of files) {
  const res = spawnSync(process.execPath, [path.join(DIR, f)], { encoding: 'utf8' });
  const lines = (res.stdout || '').trim().split(/\r?\n/).filter((l) => l.includes('RESULT:'));
  const verdict = lines.length ? lines[lines.length - 1].trim() : 'RESULT: (无结论)';
  const isBroken = res.status !== 0;
  if (isBroken) broken++;
  console.log((isBroken ? '[已知缺陷] ' : '[通过]     ') + f + '  ' + verdict);
  if (isBroken) {
    for (const l of (res.stdout || '').trim().split(/\r?\n/).slice(0, 8)) console.log('    ' + l);
  }
}
console.log('');
console.log('探针合计 ' + files.length + '，其中已知缺陷 ' + broken + ' 个' +
  (files.length - broken ? '，' + (files.length - broken) + ' 个已修复' : ''));
