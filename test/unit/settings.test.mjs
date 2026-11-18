import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, diffSettings, normalizeSettings, renderFilenameTemplate, SETTINGS_VERSION } from '../../src/core/settings.js';

test('默认值完整且版本一致', () => {
  const settings = normalizeSettings(null);
  assert.equal(settings.version, SETTINGS_VERSION);
  assert.equal(settings.deepCapture, DEFAULT_SETTINGS.deepCapture);
  assert.equal(settings.imageMinSize, DEFAULT_SETTINGS.imageMinSize);
});

test('类型不对的字段回退默认值，未知字段丢弃', () => {
  const settings = normalizeSettings({ deepCapture: 'yes', showHookHint: 1, unknown: 'x', imageMinSize: '160' });
  assert.equal(settings.deepCapture, DEFAULT_SETTINGS.deepCapture);
  assert.equal(settings.showHookHint, DEFAULT_SETTINGS.showHookHint);
  assert.equal(settings.unknown, undefined);
  assert.equal(settings.imageMinSize, 160, '数字字符串应当被接受');
});

test('越界值被夹紧', () => {
  assert.equal(normalizeSettings({ imageMinSize: -50 }).imageMinSize, 0);
  assert.equal(normalizeSettings({ imageMinSize: 99999 }).imageMinSize, 2000);
  assert.equal(normalizeSettings({ maxMediaPerTab: 5 }).maxMediaPerTab, 10);
});

test('文件名模板必须是含占位符的字符串', () => {
  assert.equal(normalizeSettings({ filenameTemplate: '固定名' }).filenameTemplate, DEFAULT_SETTINGS.filenameTemplate);
  assert.equal(normalizeSettings({ filenameTemplate: '{title}-{quality}.{ext}' }).filenameTemplate, '{title}-{quality}.{ext}');
});

test('diff 只保留与默认值不同的项', () => {
  const diff = diffSettings({ imageMinSize: 200, deepCapture: DEFAULT_SETTINGS.deepCapture });
  assert.deepEqual(diff, { imageMinSize: 200 });
  assert.deepEqual(diffSettings({}), {});
});

test('模板渲染：空画质不留残缺括号', () => {
  assert.equal(renderFilenameTemplate('{title}{quality}.{ext}', { title: '某视频', quality: '', ext: 'mp4' }), '某视频.mp4');
  assert.equal(renderFilenameTemplate('{title} [{quality}].{ext}', { title: '某视频', quality: '', ext: 'mp4' }), '某视频.mp4');
  assert.equal(renderFilenameTemplate('{title} [{quality}].{ext}', { title: '某视频', quality: '1080P', ext: 'mp4' }), '某视频 [1080P].mp4');
});

test('模板渲染：缺省值兜底', () => {
  assert.equal(renderFilenameTemplate('', {}), 'resource.bin');
  assert.equal(renderFilenameTemplate('{title}.{ext}', null), 'resource.bin');
});
