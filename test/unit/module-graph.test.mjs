/**
 * 模块图守卫
 *
 * `node --check` 只验语法，不验"这个 import 指向的文件是否存在""这个符号是否真的被导出"。
 * 而扩展加载失败最常见的形态就是这两类：改了文件名、删了导出，页面白屏但构建仍绿。
 * 这里把静态解析结果对一遍，成本约 30ms。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(ROOT, 'src');

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (full.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const files = walk(SRC);
const exportsCache = new Map();

function exportsOf(file) {
  if (exportsCache.has(file)) return exportsCache.get(file);
  const text = readFileSync(file, 'utf8');
  const names = new Set();
  for (const match of text.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const pieces = part.trim().split(/\s+as\s+/);
      const name = (pieces[1] || pieces[0] || '').trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+default\b/.test(text)) names.add('default');
  exportsCache.set(file, names);
  return names;
}

test('扫描到全部源文件', () => {
  assert.ok(files.length >= 40, '应扫描到全部源文件，实际 ' + files.length);
});

test('每个相对 import 都指向真实文件', () => {
  const missing = [];
  let checked = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/^\s*(?:import|export)\s[^'"]*from\s*['"](\.[^'"]+)['"]/gm)) {
      checked++;
      const target = path.resolve(path.dirname(file), match[1]);
      if (!existsSync(target)) missing.push(path.relative(ROOT, file) + ' -> ' + match[1]);
    }
  }
  assert.ok(checked > 0, '没扫到 import，检查是空的');
  assert.deepEqual(missing, []);
});

test('每个命名导入都在目标模块里真的有导出', () => {
  const missing = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/gm)) {
      const target = path.resolve(path.dirname(file), match[2]);
      if (!existsSync(target)) continue; // 上一项负责报这个
      const available = exportsOf(target);
      for (const part of match[1].split(',')) {
        const pieces = part.trim().split(/\s+as\s+/);
        const name = (pieces[0] || '').trim();
        if (!name) continue;
        if (!available.has(name)) {
          missing.push(path.relative(ROOT, file) + ' 导入的 ' + name + ' 不在 ' + match[2] + ' 里');
        }
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('内容脚本不 import（经典脚本无法解析模块说明符）', () => {
  const offenders = [];
  for (const file of files.filter((item) => item.includes(path.sep + 'content' + path.sep))) {
    const text = readFileSync(file, 'utf8');
    if (/^\s*import\s[^(]/m.test(text)) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, []);
});
