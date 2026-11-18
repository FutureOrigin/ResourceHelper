#!/usr/bin/env node
/**
 * ResourceHelper 构建：src/ -> out/ResourceHelper/
 *
 * 零依赖，只用 Node 内置模块。职责刻意保持狭窄：
 *   1. 复制源码（后续引入打包器时，这里替换成 esbuild 调用即可，其余步骤不变）
 *   2. 把 package.json 的 version 注入 manifest.json（单一版本源）
 *   3. 语法门禁：对产物里每个 .js 跑 node --check
 *   4. 资产门禁：manifest 里声明到的每个文件必须真实存在
 *
 * 用法：node tools/build.mjs [--out=out/ResourceHelper]
 */
import { cpSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const outArg = process.argv.find((a) => a.startsWith('--out='));
const OUT = path.resolve(ROOT, outArg ? outArg.slice('--out='.length) : 'out/ResourceHelper');

const problems = [];
const notes = [];

function walk(dir, filter, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, filter, acc);
    else if (filter(full)) acc.push(full);
  }
  return acc;
}

function bytesOf(dir) {
  let total = 0, count = 0;
  for (const f of walk(dir, () => true)) { total += statSync(f).size; count++; }
  return { total, count };
}

// ---- 1. 清理并复制 -------------------------------------------------------
if (!existsSync(path.join(SRC, 'manifest.json'))) {
  console.error('[build] 找不到 src/manifest.json，源码目录结构不对');
  process.exit(1);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(SRC, OUT, { recursive: true });

// ---- 2. 版本注入 ---------------------------------------------------------
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const manifestPath = path.join(OUT, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const previousVersion = manifest.version;
manifest.version = pkg.version;
manifest.version_name = pkg.version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 3) + '\n', 'utf8');
notes.push('manifest version ' + previousVersion + ' -> ' + pkg.version);

// ---- 3. 语法门禁 ---------------------------------------------------------
const jsFiles = walk(OUT, (f) => f.endsWith('.js'));
for (const file of jsFiles) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    problems.push('语法错误 ' + path.relative(ROOT, file) + '\n' + (res.stderr || '').trim());
  }
}

// ---- 4. 资产门禁 ---------------------------------------------------------
function requireFile(rel, where) {
  if (!rel) { problems.push(where + '：路径为空'); return; }
  if (!existsSync(path.join(OUT, rel))) problems.push(where + '：文件不存在 -> ' + rel);
}

for (const [, rel] of Object.entries(manifest.icons || {})) requireFile(rel, 'icons');
for (const [, rel] of Object.entries((manifest.action && manifest.action.default_icon) || {})) requireFile(rel, 'action.default_icon');
if (manifest.action && manifest.action.default_popup) requireFile(manifest.action.default_popup, 'action.default_popup');
if (manifest.background && manifest.background.service_worker) requireFile(manifest.background.service_worker, 'background.service_worker');
if (manifest.side_panel && manifest.side_panel.default_path) requireFile(manifest.side_panel.default_path, 'side_panel.default_path');
for (const [i, cs] of (manifest.content_scripts || []).entries()) {
  for (const rel of cs.js || []) requireFile(rel, 'content_scripts[' + i + '].js');
  for (const rel of cs.css || []) requireFile(rel, 'content_scripts[' + i + '].css');
}
for (const [locale] of Object.entries({})) void locale;
if (manifest.default_locale) {
  requireFile('_locales/' + manifest.default_locale + '/messages.json', 'default_locale');
}

// ---- 5. 汇总 -------------------------------------------------------------
const size = bytesOf(OUT);
console.log('[build] 产物目录 ' + path.relative(ROOT, OUT));
console.log('[build] ' + size.count + ' 个文件 / ' + (size.total / 1024).toFixed(1) + ' KiB；' + jsFiles.length + ' 个 JS 通过语法门禁');
for (const n of notes) console.log('[build] ' + n);

if (problems.length) {
  console.error('[build] 失败 ' + problems.length + ' 项：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('[build] OK');
