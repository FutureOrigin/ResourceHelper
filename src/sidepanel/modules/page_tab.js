/**
 * 网页快照 Tab（P8）
 *
 * 侧边栏里的"保存整页"入口：读当前标签页 → 交给 page_archive 流水线 → 展示结果。
 * 这里只做交互与状态，任何"怎么归档"的判断都在 core/sidepanel 的其它模块里。
 */
import { bus } from './bus.js';
import { el, clear, setText } from '../../ui/dom.js';
import { archivePage } from './page_archive.js';

const MB = 1024 * 1024;

export class PageTab {
  constructor() {
    this.container = null;
    this.badge = null;
    this.tab = null;
    this.settings = null;
    this.busy = false;
  }

  init(containerEl, badgeEl) {
    this.container = containerEl;
    this.badge = badgeEl;
    this.renderLayout();
  }

  renderLayout() {
    this.container.innerHTML = `
      <div class="page-panel-wrap">
        <div class="page-card">
          <div class="page-card-head">
            <span class="page-card-icon">🌐</span>
            <div class="page-card-text">
              <div class="page-card-title" id="page-title">等待页面信息…</div>
              <div class="page-card-url" id="page-url"></div>
            </div>
          </div>
          <div class="page-card-note">
            把这个页面连同图片、样式表、字体、背景图一起存成<strong>一个</strong> .html 文件，
            断网、换电脑都能打开。脚本、CSP 与自动跳转会去掉；画布与视频流不内联。
          </div>
        </div>

        <div class="archive-options">
          <label class="archive-toggle">
            <input type="checkbox" id="archive-opt-scripts" />
            <span>移除脚本（推荐）</span>
          </label>
          <label class="archive-toggle">
            <input type="checkbox" id="archive-opt-images" />
            <span>内联图片与字体</span>
          </label>
          <label class="archive-toggle">
            <input type="checkbox" id="archive-opt-frames" />
            <span>嵌入 iframe 内容</span>
          </label>
          <label class="archive-toggle">
            <input type="checkbox" id="archive-opt-hidden" />
            <span>移除隐藏元素（省体积）</span>
          </label>
          <label class="archive-toggle">
            <input type="checkbox" id="archive-opt-unused-css" />
            <span>精简未使用的样式</span>
          </label>
          <label class="archive-toggle">
            <input type="checkbox" id="archive-opt-selection" />
            <span>只保存选中区域</span>
          </label>
        </div>

        <button class="action-btn" id="archive-btn">
          <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
          保存为单文件 HTML
        </button>

        <div class="archive-progress hidden" id="archive-progress">
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" id="archive-progress-fill"></div>
          </div>
          <div class="archive-progress-text" id="archive-progress-text"></div>
        </div>

        <div class="archive-result hidden" id="archive-result"></div>
      </div>
    `;

    this.titleEl = this.container.querySelector('#page-title');
    this.urlEl = this.container.querySelector('#page-url');
    this.button = this.container.querySelector('#archive-btn');
    this.progressBox = this.container.querySelector('#archive-progress');
    this.progressFill = this.container.querySelector('#archive-progress-fill');
    this.progressText = this.container.querySelector('#archive-progress-text');
    this.resultBox = this.container.querySelector('#archive-result');

    this.optScripts = this.container.querySelector('#archive-opt-scripts');
    this.optImages = this.container.querySelector('#archive-opt-images');
    this.optFrames = this.container.querySelector('#archive-opt-frames');
    this.optHidden = this.container.querySelector('#archive-opt-hidden');
    this.optUnusedCss = this.container.querySelector('#archive-opt-unused-css');
    this.optSelection = this.container.querySelector('#archive-opt-selection');

    this.button.addEventListener('click', () => this.run());

    this.optScripts.addEventListener('change', () => this.persistOption('archiveRemoveScripts', this.optScripts.checked));
    this.optImages.addEventListener('change', () => this.persistOption('archiveInlineImages', this.optImages.checked));
    this.optFrames.addEventListener('change', () => this.persistOption('archiveEmbedFrames', this.optFrames.checked));
    this.optHidden.addEventListener('change', () => this.persistOption('archiveRemoveHidden', this.optHidden.checked));
    this.optUnusedCss.addEventListener('change', () => this.persistOption('archiveRemoveUnusedCss', this.optUnusedCss.checked));

    this.loadSettings();
  }

  async loadSettings() {
    const response = await bus.sendToService({ type: 'RH_GET_SETTINGS' });
    const settings = response && response.success ? response.settings : null;
    this.applySettings(settings || {});
  }

  applySettings(settings) {
    this.settings = settings || {};
    const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
    this.optScripts.checked = bool(this.settings.archiveRemoveScripts, true);
    this.optImages.checked = bool(this.settings.archiveInlineImages, true);
    this.optFrames.checked = bool(this.settings.archiveEmbedFrames, true);
    this.optHidden.checked = bool(this.settings.archiveRemoveHidden, true);
    this.optUnusedCss.checked = bool(this.settings.archiveRemoveUnusedCss, true);
    this.optSelection.checked = false; // 每次打开都从"整页"开始，避免误存半个页面
  }

  /** 选项改动写回设置：这是"下次打开还这样"的默认值，不是一次性开关 */
  async persistOption(key, value) {
    try {
      const patch = {};
      patch[key] = Boolean(value);
      const response = await bus.sendToService({ type: 'RH_SET_SETTINGS', patch: patch });
      if (response && response.success) this.settings = response.settings || this.settings;
    } catch (e) {
      console.warn('[PageTab] persist option failed:', e);
    }
  }

  setActiveTab(tab) {
    this.tab = tab || null;
    if (!tab) {
      setText(this.titleEl, '没有可用的标签页');
      setText(this.urlEl, '');
      this.button.disabled = true;
      return;
    }

    const restricted = bus.isRestrictedUrl(tab.url);
    setText(this.titleEl, tab.title || '（无标题）');
    setText(this.urlEl, this.shortUrl(tab.url));
    this.button.disabled = restricted || this.busy;

    if (restricted) {
      this.showMessage('这个页面是浏览器内部页面（或应用商店），扩展不能读取它的内容。', 'error');
    } else if (!this.busy) {
      this.clearMessage();
    }
  }

  shortUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname + (parsed.pathname === '/' ? '' : parsed.pathname);
    } catch (e) {
      return String(url || '');
    }
  }

  setBusy(busy) {
    this.busy = Boolean(busy);
    this.button.disabled = this.busy || !this.tab || bus.isRestrictedUrl(this.tab.url);
    this.progressBox.classList.toggle('hidden', !this.busy);
    if (this.busy) {
      setText(this.progressText, '准备中…');
      this.progressFill.style.width = '0%';
    }
  }

  updateProgress(progress) {
    if (!progress) return;
    const percent = Number.isFinite(progress.percent) ? progress.percent : 0;
    this.progressFill.style.width = Math.max(0, Math.min(100, percent)) + '%';
    setText(this.progressText, progress.text || '');
  }

  clearMessage() {
    clear(this.resultBox);
    this.resultBox.classList.add('hidden');
  }

  showMessage(text, kind) {
    clear(this.resultBox);
    const card = el('div', { class: 'archive-message ' + (kind || 'info') });
    card.appendChild(el('div', { class: 'archive-message-text', text: text }));
    this.resultBox.appendChild(card);
    this.resultBox.classList.remove('hidden');
  }

  async run() {
    if (this.busy) return;
    if (!this.tab || !this.tab.id) {
      bus.showToast('没有可保存的标签页', 'error');
      return;
    }
    if (bus.isRestrictedUrl(this.tab.url)) {
      bus.showToast('浏览器内部页面无法保存', 'error');
      return;
    }

    const settings = this.settings || {};
    const options = {
      removeScripts: this.optScripts.checked,
      inlineImages: this.optImages.checked,
      embedFrames: this.optFrames.checked,
      removeHidden: this.optHidden.checked,
      removeUnusedCss: this.optUnusedCss.checked,
      onlySelection: this.optSelection.checked,
      limits: {
        maxResourceBytes: Math.max(1, Number(settings.archiveMaxResourceMB) || 4) * MB,
        maxTotalBytes: Math.max(1, Number(settings.archiveMaxTotalMB) || 40) * MB
      }
    };

    this.clearMessage();
    this.setBusy(true);

    let result;
    try {
      result = await archivePage({
        tabId: this.tab.id,
        pageUrl: this.tab.url || '',
        options: options,
        settings: settings,
        onProgress: (progress) => this.updateProgress(progress)
      });
    } catch (error) {
      result = { ok: false, error: 'ARCHIVE_FAILED', message: (error && error.message) || String(error) };
    }

    this.setBusy(false);

    if (!result || !result.ok) {
      this.showMessage((result && result.message) || '保存失败', 'error');
      bus.showToast('整页保存失败', 'error');
      return;
    }

    this.renderResult(result);
    bus.showToast('已保存：' + result.filename, 'success', 2600);
  }

  renderResult(result) {
    clear(this.resultBox);

    const card = el('div', { class: 'archive-result-card' });
    card.appendChild(el('div', { class: 'archive-result-title', text: result.filename }));

    const stats = result.stats || {};
    const summary = [
      bus.formatBytes(result.bytes),
      '图片 ' + (stats.images || 0),
      '样式 ' + (stats.styles || 0),
      '字体 ' + (stats.fonts || 0)
    ];
    if (stats.frames) summary.push('iframe ' + stats.frames);
    if (stats.scriptsRemoved) summary.push('移除脚本 ' + stats.scriptsRemoved);
    if (stats.hiddenRemoved) summary.push('移除隐藏元素 ' + stats.hiddenRemoved);
    if (stats.cssPrunedBytes) summary.push('样式省 ' + bus.formatBytes(stats.cssPrunedBytes));
    if (stats.skipped) summary.push('跳过 ' + stats.skipped);
    card.appendChild(el('div', { class: 'archive-result-meta', text: summary.filter(Boolean).join(' · ') }));

    if (result.frames && result.frames.failed > 0) {
      card.appendChild(el('div', {
        class: 'archive-result-warn',
        text: result.frames.failed + ' 个 iframe 没能抓取（跨域限制或未加载），已保留原地址。'
      }));
    }

    if (stats.canvas > 0) {
      card.appendChild(el('div', {
        class: 'archive-result-warn',
        text: stats.canvas + ' 块画布没有内联：画布内容是运行时绘制的，需要页面脚本才能重绘。'
      }));
    }

    const skipped = Array.isArray(result.skipped) ? result.skipped : [];
    if (skipped.length > 0) {
      const list = el('ul', { class: 'archive-skip-list' });
      for (const item of skipped.slice(0, 5)) {
        list.appendChild(el('li', {
          class: 'archive-skip-item',
          text: (item.message || item.reason || '已跳过') + ' · ' + this.shorten(item.url, 60)
        }));
      }
      if (skipped.length > 5) {
        list.appendChild(el('li', { class: 'archive-skip-item', text: '还有 ' + (skipped.length - 5) + ' 项未内联' }));
      }
      card.appendChild(list);
    }

    const actions = el('div', { class: 'archive-result-actions' });
    if (Number.isFinite(result.downloadId)) {
      const showBtn = el('button', { class: 'action-btn-sm', text: '打开所在文件夹' });
      showBtn.addEventListener('click', () => {
        try {
          chrome.downloads.show(result.downloadId);
        } catch (e) {
          bus.showToast('无法打开下载目录', 'error');
        }
      });
      actions.appendChild(showBtn);
    }
    card.appendChild(actions);

    this.resultBox.appendChild(card);
    this.resultBox.classList.remove('hidden');
  }

  shorten(value, limit) {
    const text = String(value || '');
    return text.length > limit ? text.slice(0, limit) + '…' : text;
  }
}
