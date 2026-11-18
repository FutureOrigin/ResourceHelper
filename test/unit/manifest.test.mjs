/**
 * 清单与入口一致性守卫
 *
 * 锁住 AUDIT C3/C4/C5：点图标必须进侧边栏（不能有 default_popup），
 * 声明的每个快捷键必须有监听，代码里不能偷偷 setPopup 把入口改回弹窗。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(ROOT, 'src');
const manifest = JSON.parse(readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const background = readFileSync(path.join(SRC, 'service/background.js'), 'utf8');

test('manifest 是 MV3 且声明了侧边栏', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.side_panel && manifest.side_panel.default_path, '必须声明 side_panel.default_path');
});

test('声明到 side_panel 的页面真实存在', () => {
  assert.ok(existsSync(path.join(SRC, manifest.side_panel.default_path)), manifest.side_panel.default_path);
});

test('action 不再声明 default_popup（否则点图标永远开弹窗，AUDIT C4）', () => {
  assert.equal(manifest.action.default_popup, undefined);
});

test('后台代码不再调用 action.setPopup', () => {
  const hits = background.split(/\r?\n/)
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter((x) => x.line.includes('setPopup') && !x.line.startsWith('//'));
  assert.deepEqual(hits, [], '不应在运行时把入口改回 popup');
});

test('设置页已声明且真实存在', () => {
  assert.ok(manifest.options_ui && manifest.options_ui.page, '缺少 options_ui');
  assert.ok(existsSync(path.join(SRC, manifest.options_ui.page)), manifest.options_ui.page);
  const dir = path.dirname(path.join(SRC, manifest.options_ui.page));
  for (const asset of ['options.js', 'options.css']) {
    assert.ok(existsSync(path.join(dir, asset)), '设置页缺少 ' + asset);
  }
});

test('主世界钩子与隔离世界桥都已声明，且钩子在 document_start', () => {
  const entries = manifest.content_scripts || [];
  const mainEntry = entries.find((entry) => entry.world === 'MAIN');
  assert.ok(mainEntry, '缺少 MAIN world 的钩子脚本（P5）');
  assert.equal(mainEntry.run_at, 'document_start', '钩子必须尽早安装，否则抓不到页面早期的 fetch');
  assert.deepEqual(mainEntry.js, ['content/page_hooks.js']);
  assert.ok(existsSync(path.join(SRC, mainEntry.js[0])), mainEntry.js[0]);

  const bridgeEntry = entries.find((entry) => (entry.js || []).includes('content/hook_bridge.js'));
  assert.ok(bridgeEntry, '缺少隔离世界的转发桥');
  assert.ok(existsSync(path.join(SRC, 'content/hook_bridge.js')));
});

test('权限集合是最小的、已枚举的（新增权限必须显式改这个测试）', () => {
  const expected = [
    'tabs', 'downloads', 'sidePanel', 'webRequest',
    'webNavigation', 'scripting', 'declarativeNetRequest', 'storage',
    'offscreen'
  ];
  const actual = (manifest.permissions || []).slice().sort();
  assert.deepEqual(actual, expected.slice().sort(), '权限清单变化必须同步 docs/STORE.md 的说明');
  assert.ok(!(manifest.permissions || []).includes('unlimitedStorage'), 'unlimitedStorage 已确认不需要');
});

test('上架材料存在', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  for (const rel of ['docs/PRIVACY.md', 'docs/STORE.md']) {
    assert.ok(existsSync(path.join(root, rel)), rel);
  }
});

test('每个声明的命令都有对应的监听分支', () => {
  const commands = Object.keys(manifest.commands || {}).filter((id) => id !== '_execute_action');
  assert.ok(commands.length > 0, '至少应有一个自定义命令');
  assert.match(background, /chrome\.commands\.onCommand\.addListener/);
  for (const id of commands) {
    assert.ok(background.includes("'" + id + "'"), '命令 ' + id + ' 未在后台处理');
  }
});

test('content script 与图标文件都存在', () => {
  for (const entry of manifest.content_scripts || []) {
    for (const rel of entry.js || []) assert.ok(existsSync(path.join(SRC, rel)), rel);
    for (const rel of entry.css || []) assert.ok(existsSync(path.join(SRC, rel)), rel);
  }
  for (const rel of Object.values(manifest.icons || {})) {
    assert.ok(existsSync(path.join(SRC, rel)), rel);
  }
});

test('host_permissions 覆盖 content script 的匹配范围', () => {
  const hosts = manifest.host_permissions || [];
  for (const entry of manifest.content_scripts || []) {
    for (const pattern of entry.matches || []) {
      assert.ok(hosts.includes(pattern) || hosts.includes('<all_urls>'), '缺少 host 权限: ' + pattern);
    }
  }
});

test('资源图持久化依赖的 storage 权限已声明（AUDIT C1）', () => {
  const permissions = manifest.permissions || [];
  assert.ok(permissions.includes('storage'), '缺少 storage 权限时 chrome.storage.session 不可用');
  assert.match(background, /storage.session/, '后台应使用 storage.session 保存快照');
});

test('后台 service worker 文件存在', () => {
  assert.ok(existsSync(path.join(SRC, manifest.background.service_worker)), manifest.background.service_worker);
});
