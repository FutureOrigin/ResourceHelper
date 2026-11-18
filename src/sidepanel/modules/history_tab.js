/**
 * 下载历史页（P6）
 *
 * 只读 + 清空。真正的记录发生在后台（直接下载）与各下载器（引擎路径），
 * 这里通过 RH_GET_HISTORY 拉取，并监听 RH_HISTORY_CHANGED 增量刷新。
 */
import { bus } from './bus.js';
import { el, clear } from '../../ui/dom.js';
import { formatRelativeTime } from '../../core/history.js';
import { streamDownloader } from './stream_downloader.js';
import { dashDownloader } from './dash_downloader.js';
import { mediaMuxer } from './media_muxer.js';

const MODE_LABEL = {
  direct: '直链',
  stream: 'HLS',
  dash: 'DASH',
  mux: '合流',
  page: '整页快照'
};

const STATUS_LABEL = {
  completed: '已完成',
  failed: '失败',
  initiated: '进行中'
};

export class HistoryTab {
  init(container, badgeEl) {
    this.container = container;
    this.badgeEl = badgeEl;
    this.entries = [];
    this.stats = null;
    this.render();
  }

  async refresh() {
    const response = await bus.sendToService({ type: 'RH_GET_HISTORY' });
    if (response && response.success) {
      this.entries = Array.isArray(response.entries) ? response.entries : [];
      this.stats = response.stats || null;
      this.render();
    }
  }

  /** 后台推送的整份列表（历史量小，直接替换比增量合并简单可靠） */
  setEntries(entries, stats) {
    this.entries = Array.isArray(entries) ? entries : [];
    this.stats = stats || null;
    this.render();
  }

  async clearAll() {
    await bus.sendToService({ type: 'RH_CLEAR_HISTORY' });
    this.entries = [];
    this.stats = { total: 0, completed: 0, failed: 0, initiated: 0, bytes: 0 };
    this.render();
  }

  /**
   * 按记录里的模式重下。
   * 直链可以交给浏览器；HLS/DASH/合流必须回到各自的下载器，
   * 否则会把播放列表或视频轨当成完整文件存下来。
   */
  async retry(item) {
    const mode = item.mode || 'direct';
    const title = item.title || 'resource';

    if (mode === 'page') {
      throw new Error('整页快照要在"快照"页重新保存，直链下载只会拿到未内联的 HTML');
    }
    if (mode === 'stream') {
      return streamDownloader.downloadM3u8(item.url, title, () => {});
    }
    if (mode === 'dash') {
      return dashDownloader.download(item.url, title, () => {});
    }
    if (mode === 'mux' && item.audioUrl) {
      return mediaMuxer.mergeAndDownload(item.url, item.audioUrl, title, () => {});
    }
    return chrome.downloads.download({
      url: item.url,
      filename: item.filename || undefined,
      saveAs: false
    });
  }

  render() {
    if (!this.container) return;
    clear(this.container);

    if (this.badgeEl) {
      this.badgeEl.textContent = this.entries.length > 0 ? String(Math.min(this.entries.length, 99)) : '';
    }

    const toolbar = el('div', { class: 'tab-toolbar' });
    const summary = this.stats
      ? this.stats.total + ' 条 · 完成 ' + this.stats.completed + ' · 失败 ' + this.stats.failed
      : '';
    toolbar.appendChild(el('span', { class: 'history-summary', text: summary || '还没有下载记录' }));

    if (this.entries.length > 0) {
      const clearBtn = el('button', { class: 'action-btn-outline', text: '清空' });
      clearBtn.addEventListener('click', () => this.clearAll());
      toolbar.appendChild(clearBtn);
    }
    this.container.appendChild(toolbar);

    if (this.entries.length === 0) {
      const empty = el('div', { class: 'empty-state' });
      empty.appendChild(el('div', { class: 'empty-title', text: '还没有下载记录' }));
      empty.appendChild(el('div', {
        class: 'empty-desc',
        text: '在视频或音频页点下载后，这里会保留最近 30 天的记录（最多 300 条）。'
      }));
      this.container.appendChild(empty);
      return;
    }

    const list = el('div', { class: 'resource-list' });
    for (const item of this.entries) list.appendChild(this.createRow(item));
    this.container.appendChild(list);
  }

  createRow(item) {
    const row = el('div', { class: 'history-row' });

    const main = el('div', { class: 'history-main' });
    main.appendChild(el('div', { class: 'history-title', text: item.title || '未命名资源' }));

    const meta = [];
    if (MODE_LABEL[item.mode]) meta.push(MODE_LABEL[item.mode]);
    if (item.size) meta.push(bus.formatBytes(item.size));
    if (item.filename) meta.push(item.filename);
    if (item.ts) meta.push(formatRelativeTime(item.ts));
    main.appendChild(el('div', { class: 'history-meta', text: meta.join(' · ') }));

    row.appendChild(main);

    const status = el('span', {
      class: 'history-status ' + (item.status || 'initiated'),
      text: STATUS_LABEL[item.status] || item.status || ''
    });
    row.appendChild(status);

    // 整页快照不能"再下一次"：它需要重新跑一遍归档流水线，直链下载只会得到未内联的 HTML
    if (item.url && item.mode !== 'page') {
      const retry = el('button', { class: 'action-btn-sm', text: '再下一次' });
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        try {
          await this.retry(item);
          bus.showToast('已重新开始下载', 'success');
        } catch (e) {
          bus.showToast('重新下载失败：' + ((e && e.message) || '未知错误'), 'error');
        } finally {
          retry.disabled = false;
        }
      });
      row.appendChild(retry);
    }

    return row;
  }
}
