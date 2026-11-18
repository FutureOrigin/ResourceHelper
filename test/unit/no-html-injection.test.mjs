/**
 * HTML 注入守卫
 *
 * 资源标题、图片地址、音频名都来自网页（不可信输入）。把它们拼进 innerHTML
 * 会产生 HTML 注入（AUDIT F1：全仓曾出现 26 处）。规则很硬：
 *   innerHTML / outerHTML / insertAdjacentHTML 只允许清空或纯静态字符串；
 *   需要插值的结构必须用 src/ui/dom.js 的 el() 构造。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(ROOT, 'src');
const INTERP = '$' + '{';
const assignable = /\.(innerHTML|outerHTML)\s*=\s*`([\s\S]*?)`/g;

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (full.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const files = walk(SRC);

test('扫描到源码文件', () => {
  assert.ok(files.length >= 10, '应扫描到全部源文件，实际 ' + files.length);
});

test('模板字符串形式的 innerHTML 不得包含插值', () => {
  const violations = [];
  let scanned = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assignable.lastIndex = 0;
    let match;
    while ((match = assignable.exec(text)) !== null) {
      scanned++;
      if (!match[2].includes(INTERP)) continue;
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      violations.push(path.relative(ROOT, file) + ':' + line);
    }
  }
  assert.ok(scanned > 0, '至少要扫描到 innerHTML 赋值，否则检查是空的');
  assert.deepEqual(violations, []);
});

test('字符串拼接形式的 innerHTML 不得拼接变量', () => {
  const violations = [];
  for (const file of files.filter((f) => !f.endsWith(path.join('ui', 'icons.js')))) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, '');
      if (!/\.(innerHTML|outerHTML)\s*=/.test(code)) return;
      if (!/=\s*(['"])[^\n]*\1\s*\+/.test(code)) return;
      violations.push(path.relative(ROOT, file) + ':' + (index + 1));
    });
  }
  assert.deepEqual(violations, []);
});

test('insertAdjacentHTML / document.write 同样受约束', () => {
  const violations = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, '');
      if (!/insertAdjacentHTML|document\.write\s*\(/.test(code)) return;
      if (code.includes(INTERP)) violations.push(path.relative(ROOT, file) + ':' + (index + 1));
    });
  }
  assert.deepEqual(violations, []);
});

test('卡片与悬浮菜单都用 DOM 构造不可信字段', () => {
  for (const rel of ['sidepanel/modules/video_tab.js', 'sidepanel/modules/audio_tab.js', 'sidepanel/modules/image_tab.js']) {
    const text = readFileSync(path.join(SRC, rel), 'utf8');
    assert.ok(text.includes("from '../../ui/dom.js'"), rel + ' 应当使用 ui/dom.js 构造节点');
  }
  const overlay = readFileSync(path.join(SRC, 'content/inpage_overlay.js'), 'utf8');
  assert.ok(overlay.includes('function mkMenuItem'), '悬浮菜单应当用局部构造器');
});
