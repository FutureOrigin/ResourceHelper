/**
 * 设置页
 *
 * 只做三件事：把当前设置填进表单、把表单收集回来、显示保存结果。
 * 校验统一交给 core/settings.js 的 normalizeSettings，页面不重复实现规则。
 */
import { DEFAULT_SETTINGS, normalizeSettings, renderFilenameTemplate } from '../core/settings.js';

const FIELDS = {
  deepCapture: () => document.getElementById('deep-capture'),
  showHookHint: () => document.getElementById('show-hook-hint'),
  imageMinSize: () => document.getElementById('image-min-size'),
  maxMediaPerTab: () => document.getElementById('max-media-per-tab'),
  filenameTemplate: () => document.getElementById('filename-template'),
  archiveRemoveScripts: () => document.getElementById('archive-remove-scripts'),
  archiveInlineImages: () => document.getElementById('archive-inline-images'),
  archiveEmbedFrames: () => document.getElementById('archive-embed-frames'),
  archiveRefererRetry: () => document.getElementById('archive-referer-retry'),
  archiveMaxResourceMB: () => document.getElementById('archive-max-resource-mb'),
  archiveMaxTotalMB: () => document.getElementById('archive-max-total-mb')
};

const STATUS_CLASSES = ['ok', 'error'];

function setStatus(text, kind) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.classList.remove(...STATUS_CLASSES);
  if (kind) el.classList.add(kind);
  if (text) {
    clearTimeout(setStatus.timer);
    setStatus.timer = setTimeout(() => { el.textContent = ''; el.classList.remove(...STATUS_CLASSES); }, 2600);
  }
}

function applyToForm(settings) {
  FIELDS.deepCapture().checked = Boolean(settings.deepCapture);
  FIELDS.showHookHint().checked = Boolean(settings.showHookHint);
  FIELDS.imageMinSize().value = String(settings.imageMinSize);
  FIELDS.maxMediaPerTab().value = String(settings.maxMediaPerTab);
  FIELDS.filenameTemplate().value = settings.filenameTemplate;
  FIELDS.archiveRemoveScripts().checked = Boolean(settings.archiveRemoveScripts);
  FIELDS.archiveInlineImages().checked = Boolean(settings.archiveInlineImages);
  FIELDS.archiveEmbedFrames().checked = Boolean(settings.archiveEmbedFrames);
  FIELDS.archiveRefererRetry().checked = Boolean(settings.archiveRefererRetry);
  FIELDS.archiveMaxResourceMB().value = String(settings.archiveMaxResourceMB);
  FIELDS.archiveMaxTotalMB().value = String(settings.archiveMaxTotalMB);
}

function collectFromForm() {
  return normalizeSettings({
    deepCapture: FIELDS.deepCapture().checked,
    showHookHint: FIELDS.showHookHint().checked,
    imageMinSize: FIELDS.imageMinSize().value,
    maxMediaPerTab: FIELDS.maxMediaPerTab().value,
    filenameTemplate: FIELDS.filenameTemplate().value,
    archiveRemoveScripts: FIELDS.archiveRemoveScripts().checked,
    archiveInlineImages: FIELDS.archiveInlineImages().checked,
    archiveEmbedFrames: FIELDS.archiveEmbedFrames().checked,
    archiveRefererRetry: FIELDS.archiveRefererRetry().checked,
    archiveMaxResourceMB: FIELDS.archiveMaxResourceMB().value,
    archiveMaxTotalMB: FIELDS.archiveMaxTotalMB().value
  });
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get('settings');
  return normalizeSettings(stored && stored.settings);
}

function diffOf(settings) {
  const diff = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'version') continue;
    if (value !== DEFAULT_SETTINGS[key]) diff[key] = value;
  }
  return diff;
}

async function save() {
  try {
    const settings = collectFromForm();
    await chrome.storage.sync.set({ settings: diffOf(settings) });
    applyToForm(settings);
    setStatus('已保存', 'ok');
  } catch (e) {
    setStatus('保存失败：' + (e && e.message ? e.message : '未知错误'), 'error');
  }
}

async function reset() {
  try {
    await chrome.storage.sync.set({ settings: {} });
    applyToForm(normalizeSettings(null));
    setStatus('已恢复默认', 'ok');
  } catch (e) {
    setStatus('恢复失败', 'error');
  }
}

async function main() {
  applyToForm(await loadSettings());
  document.getElementById('save').addEventListener('click', save);
  document.getElementById('reset').addEventListener('click', reset);

  // 模板实时预览，避免用户写完才发现结果不对
  const templateInput = FIELDS.filenameTemplate();
  templateInput.addEventListener('input', () => {
    const preview = renderFilenameTemplate(templateInput.value, {
      title: '示例视频', quality: '1080P', ext: 'mp4', site: 'bilibili.com', date: '20260101'
    });
    setStatus('预览：' + preview);
  });
}

main();
