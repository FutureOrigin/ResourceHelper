/**
 * 字体反爬还原的接线守卫
 *
 * 解禁（CSS/事件）与字体加密是两件事：前者改不了码位，后者只能换字。
 * 这里守住"换字"这条链路的几个接点，避免以后重构时被拆掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

test('内容脚本：提取结果带私用区统计与字体线索', () => {
  const src = read('src/content/text_unlocker.js');
  assert.match(src, /function collectPrivateUse/);
  assert.match(src, /function findObfuscationFont/);
  assert.match(src, /pua: \{ total: pua\.total, distinct: pua\.distinct\.length \}/);
  assert.match(src, /font: pua\.total \? findObfuscationFont\(\) : null/);
});

test('内容脚本：复制时按映射改写剪贴板', () => {
  const src = read('src/content/text_unlocker.js');
  assert.match(src, /SNIFFER_SET_COPY_MAP/);
  assert.match(src, /SNIFFER_EXTRACT_CONTENT_V2/);
  assert.match(src, /const VERSION = \d+/, '版本化守卫决定能否就地升级');
  assert.match(src, /clipboardData\.setData\('text\/plain'/, '复制事件必须改写剪贴板，否则页面里还是乱码');
  assert.match(src, /e\.preventDefault\(\)/);
  // 复制处理器必须先于"吞事件"的拦截器挂上，否则永远轮不到它
  const copyIndex = src.indexOf("window.addEventListener('copy', copyHandler, true)");
  assert.ok(copyIndex > 0);
  assert.ok(src.indexOf('function suppressDefensiveEvents') < copyIndex);
});

test('侧边栏：提取后按需解码，并把映射推回页面', () => {
  const tab = read('src/sidepanel/modules/text_tab.js');
  assert.match(tab, /import \{ decodeExtractedText, describeDecodeFailure, discoverFontInTab, pushCopyMap \}/);
  assert.match(tab, /await this\.applyFontDecode\(resp, this\.activeTabId\)/);
  assert.match(tab, /SNIFFER_EXTRACT_CONTENT_V2/, '侧边栏要先问 V2，才能分辨页面里是不是新脚本');
  assert.match(tab, /upgradeContentScript/, '老标签页要能就地升级内容脚本');
  assert.match(tab, /collectPrivateUse\(content\)/, '内容脚本没给统计时侧边栏要自己算');
  assert.match(tab, /discoverFontInTab\(tabId\)/, '拿不到字体线索时要自己找');
  assert.match(tab, /await pushCopyMap\(tabId, result\.mapping\)/);
  assert.match(tab, /prepareCopyMap/, '解禁后应顺手修复制');
});

test('解码模块：指纹表按需加载，路径真实存在', () => {
  const src = read('src/sidepanel/modules/font_text_decode.js');
  assert.match(src, /data\/glyph-table\.bin/);
  assert.ok(existsSync(path.join(ROOT, 'src/data/glyph-table.bin')), '指纹表没提交');
  assert.match(src, /buildPrivateUseMapping/);
  assert.match(src, /credentials: 'omit'/, '取字体不该带凭据');
});

test('指纹表头部与 CRC 自洽', () => {
  const bytes = new Uint8Array(readFileSync(path.join(ROOT, 'src/data/glyph-table.bin')));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0), 0x47485431, 'magic 不是 GHT1');
  assert.equal(view.getUint16(4), 1, '版本号变了要同步 loadGlyphTable');
  const hashBytes = view.getUint16(6);
  const count = view.getUint32(8);
  assert.equal(bytes.length, 12 + count * hashBytes + count * 2 + 4, '长度与头部记录不符');
  const stored = view.getUint32(bytes.length - 4);
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length - 4; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  assert.equal((crc ^ 0xFFFFFFFF) >>> 0, stored, 'CRC 对不上，表被改坏了');
});

test('建表工具与运行时共用同一份轮廓解析', () => {
  const tool = read('tools/build-glyph-table.mjs');
  assert.match(tool, /from '\.\.\/src\/core\/font-glyph\.js'/);
  assert.match(tool, /signatureHex/);
});
