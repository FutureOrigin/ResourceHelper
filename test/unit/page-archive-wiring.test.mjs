/**
 * 整页快照：接线守卫（静态检查）
 *
 * 这类问题不会让单测变红，但会让功能"看不见"或"静默失效"：
 * 内容脚本没进 manifest、消息名两边不一致、占位符协议在两侧写歪、
 * 设置项只在界面里存在而没进 storage 形状。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ARCHIVE_SCHEME, DEFAULT_ARCHIVE_LIMITS, FRAME_SCHEME } from '../../src/core/page-archive.js';
import { COLLECT_MESSAGE } from '../../src/sidepanel/modules/page_archive.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/core/settings.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(ROOT, 'src');
const read = (rel) => readFileSync(path.join(SRC, rel), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const archiver = read('content/page_archiver.js');
const background = read('service/background.js');
const orchestrator = read('sidepanel/modules/page_archive.js');

test('内容脚本已注册、存在、且注入到所有 frame', () => {
  const entry = (manifest.content_scripts || []).find((item) => (item.js || []).includes('content/page_archiver.js'));
  assert.ok(entry, 'manifest 未注册 content/page_archiver.js');
  assert.equal(entry.all_frames, true, 'iframe 归档依赖每个 frame 都有内容脚本');
  assert.equal(entry.run_at, 'document_idle');
  assert.ok(existsSync(path.join(SRC, 'content/page_archiver.js')));
});

test('内容脚本是经典脚本（不能有 import/export）', () => {
  for (const line of archiver.split(/\r?\n/)) {
    const code = line.trim();
    if (!code || code.startsWith('//') || code.startsWith('*')) continue;
    assert.ok(!/^import\s/.test(code), '内容脚本出现 import：' + code);
    assert.ok(!/^export\s/.test(code), '内容脚本出现 export：' + code);
  }
});

test('占位符协议在两侧完全一致（内容脚本是手写复制的最小实现）', () => {
  const resourceConst = /const RESOURCE_SCHEME = '([^']+)'/.exec(archiver);
  const frameConst = /const FRAME_SCHEME = '([^']+)'/.exec(archiver);
  assert.ok(resourceConst, '内容脚本缺少 RESOURCE_SCHEME');
  assert.ok(frameConst, '内容脚本缺少 FRAME_SCHEME');
  assert.equal(resourceConst[1], ARCHIVE_SCHEME);
  assert.equal(frameConst[1], FRAME_SCHEME);
});

test('采集消息名在两侧一致，且侧边栏用的文件与 manifest 相同', () => {
  assert.ok(archiver.includes("'" + COLLECT_MESSAGE + "'"), '内容脚本没有处理 ' + COLLECT_MESSAGE);
  assert.ok(orchestrator.includes('export const COLLECT_MESSAGE = ' + "'" + COLLECT_MESSAGE + "'"));
  assert.ok(orchestrator.includes("ARCHIVER_FILE = 'content/page_archiver.js'"));
  assert.ok(manifest.content_scripts.some((item) => (item.js || []).includes('content/page_archiver.js')));
});

test('大页面不再按节点数拒绝，遍历分片让出主线程', () => {
  // 4 万节点在今天的站点上很常见：按节点数直接拒绝等于把功能判死
  assert.ok(!('maxNodes' in DEFAULT_ARCHIVE_LIMITS), '预算里不应再有节点数上限');
  assert.ok(!/maxNodes/.test(archiver), '内容脚本不应再接收节点数上限');
  assert.ok(!/TOO_MANY_NODES/.test(archiver), '内容脚本不应再返回 TOO_MANY_NODES');
  assert.ok(!/maxNodes/.test(orchestrator), '侧边栏不应再把节点数上限传给内容脚本');

  // 卡死的真正原因是"一次跑完的长任务"：必须分片，并在片与片之间让出主线程
  assert.match(archiver, /const WALK_CHUNK = \d+/, '缺少分片大小常量');
  assert.match(archiver, /await yieldToPage\(\)/, '遍历必须分片让出主线程');
  assert.match(archiver, /function yieldToPage\(\)[\s\S]{0,200}setTimeout\(/, '让出主线程要用宏任务，rAF 在后台标签页不跑');
  // 异步回包：跨宏任务之后才 sendResponse，监听器必须同步返回 true 保持通道打开
  assert.match(archiver, /async function collect\(/, '采集必须可跨宏任务');
  assert.match(archiver, /\.then\(/, '采集结果必须异步回包');
});

test('体积优化的接线：隐藏元素、选择器词表、CSS 精简', () => {
  // 采集端：按设置剔除 display:none，并把选择器词表带回侧边栏
  assert.match(archiver, /removeHidden: rawOptions\.removeHidden !== false/, '内容脚本未接收"移除隐藏元素"开关');
  assert.match(archiver, /vocabulary: snapshot\.vocabulary/, '采集结果没有带回选择器词表');
  assert.match(archiver, /getComputedStyle/, '隐藏判定必须用活节点的计算样式');

  // 编排端：按帧词表精简 CSS，并把开关传下去
  assert.match(orchestrator, /normalizeSelectorVocabulary/, '侧边栏没有使用选择器词表');
  assert.match(orchestrator, /pruneUnusedCss\(/, '侧边栏没有调用 CSS 精简');
  assert.match(orchestrator, /removeHidden: options\.removeHidden/, '开关没有传给内容脚本');

  // 设置项：默认开，且两侧 UI 都能改
  assert.equal(DEFAULT_SETTINGS.archiveRemoveHidden, true);
  assert.equal(DEFAULT_SETTINGS.archiveRemoveUnusedCss, true);
  const panel = read('sidepanel/modules/page_tab.js');
  assert.ok(panel.includes('archive-opt-hidden'), '快照面板缺少"移除隐藏元素"开关');
  assert.ok(panel.includes('archive-opt-unused-css'), '快照面板缺少"精简未使用的样式"开关');
});

test('后台提供批量抓取与 frame 枚举接口', () => {
  for (const type of ['RH_ARCHIVE_FETCH', 'RH_ARCHIVE_FRAMES']) {
    assert.ok(background.includes("'" + type + "'"), '后台缺少消息处理：' + type);
  }
  assert.ok(background.includes('fetchArchiveResources('), '未接整页抓取实现');
  assert.ok(background.includes('listTabFrames('), '未接 frame 枚举');
  assert.ok(background.includes('bg/archive-fetch.js'), '缺少抓取模块引用');
});

test('防盗链重试的开关来自设置，而不是消息参数', () => {
  const block = background.slice(background.indexOf("request.type === 'RH_ARCHIVE_FETCH'"));
  const head = block.slice(0, block.indexOf("request.type === 'RH_ARCHIVE_FRAMES'"));
  assert.ok(head.includes('archiveSettings.archiveRefererRetry'), '未读取设置里的 Referer 重试开关');
  assert.ok(!/request\.refererRetry/.test(head), '不应允许调用方直接打开 Referer 重试');
});

test('侧边栏 Tab 已接线（导航按钮 / 面板 / 模块 / 当前页同步）', () => {
  const html = read('sidepanel/index.html');
  assert.ok(html.includes('data-tab="page"'), '缺少"快照"导航按钮');
  assert.ok(html.includes('id="pane-page"'), '缺少 pane-page');

  const main = read('sidepanel/main.js');
  assert.ok(main.includes("from './modules/page_tab.js'"));
  assert.ok(main.includes('new PageTab()'));
  assert.ok(main.includes('this.pageTab.init('));
  assert.ok(main.includes('this.pageTab.setActiveTab('));
  assert.ok(main.includes("tabName === 'page'"));
});

test('快照页复用统一落盘末端（历史与 blob 释放只实现一次）', () => {
  assert.ok(orchestrator.includes("from './download_finalize.js'"));
  assert.ok(orchestrator.includes('finalizeBlobDownload(') || orchestrator.includes('deps.finalize('));
  assert.ok(orchestrator.includes("mode: 'page'"), '历史里应能区分"整页快照"');
});

test('设置项进了数据形状，也进了设置页', () => {
  const keys = [
    'archiveRemoveScripts',
    'archiveInlineImages',
    'archiveEmbedFrames',
    'archiveRemoveHidden',
    'archiveRemoveUnusedCss',
    'archiveRefererRetry',
    'archiveMaxResourceMB',
    'archiveMaxTotalMB'
  ];
  for (const key of keys) {
    assert.equal(typeof DEFAULT_SETTINGS[key], typeof normalizeSettings({})[key], key + ' 缺少默认值');
    assert.notEqual(normalizeSettings({})[key], undefined, key + ' 未进入设置形状');
  }

  const optionsHtml = read('options/index.html');
  const optionsJs = read('options/options.js');
  const ids = {
    archiveRemoveScripts: 'archive-remove-scripts',
    archiveInlineImages: 'archive-inline-images',
    archiveEmbedFrames: 'archive-embed-frames',
    archiveRemoveHidden: 'archive-remove-hidden',
    archiveRemoveUnusedCss: 'archive-remove-unused-css',
    archiveRefererRetry: 'archive-referer-retry',
    archiveMaxResourceMB: 'archive-max-resource-mb',
    archiveMaxTotalMB: 'archive-max-total-mb'
  };
  for (const [key, id] of Object.entries(ids)) {
    assert.ok(optionsHtml.includes('id="' + id + '"'), '设置页缺少控件 ' + id);
    assert.ok(optionsJs.includes("'" + id + "'"), '设置页未读取控件 ' + id);
    assert.ok(optionsJs.includes(key + ':'), '设置页未提交字段 ' + key);
  }

  // 预算的越界值必须被夹紧（否则一次手改就能让扩展拒绝一切内联）
  assert.equal(normalizeSettings({ archiveMaxResourceMB: 0 }).archiveMaxResourceMB, 1);
  assert.equal(normalizeSettings({ archiveMaxTotalMB: 99999 }).archiveMaxTotalMB, 512);
  assert.equal(normalizeSettings({ archiveRemoveScripts: 'no' }).archiveRemoveScripts, true);
});

test('不引入新权限（防盗链重试用的是已有的 declarativeNetRequest）', () => {
  const permissions = manifest.permissions || [];
  assert.ok(permissions.includes('declarativeNetRequest'), '会话级 Referer 规则需要该权限');
  // 现有的权限清单守卫在 manifest.test.mjs 里；这里只确认快照没有额外要求
  for (const extra of ['unlimitedStorage', 'webRequestBlocking', 'debugger', 'nativeMessaging']) {
    assert.ok(!permissions.includes(extra), '不应新增权限：' + extra);
  }
});

test('快照页的 DOM 选择器都能在模板里找到（没有 DOM 环境时的兜底守卫）', () => {
  const source = read('sidepanel/modules/page_tab.js');
  const start = source.indexOf('this.container.innerHTML = `');
  assert.ok(start > 0, '找不到模板');
  const template = source.slice(start, source.indexOf('`;', start));
  assert.ok(template.length > 200);

  const ids = [...source.matchAll(/querySelector\('#([a-z0-9-]+)'\)/g)].map((match) => match[1]);
  assert.ok(ids.length >= 8, '应当选中所有交互元素，实际 ' + ids.length);
  for (const id of ids) {
    assert.ok(template.includes('id="' + id + '"'), '模板里缺少 #' + id);
  }

  // 模板里不允许出现插值：这条约束与 no-html-injection.test.mjs 一致
  assert.ok(!template.includes('$' + '{'), '模板不得插值，动态内容用 textContent / el()');
});

test('快照页用到的样式类在 style.css 里有定义', () => {
  const css = read('sidepanel/style.css');
  for (const className of ['page-panel-wrap', 'archive-options', 'archive-toggle', 'archive-result-card', 'archive-skip-item']) {
    assert.ok(css.includes('.' + className), '缺少样式 .' + className);
  }
});
