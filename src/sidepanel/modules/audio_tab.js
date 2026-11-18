import { bus } from './bus.js';
import { el, clear } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';

export class AudioTab {
  constructor() {
    this.container = null;
    this.badge = null;
    this.rawMedia = [];
    this.audioItems = [];
    this.filter = 'all';
    this.activeTabId = null;
    this.renderTimer = null;
    this.downloads = new Map();
  }

  init(containerEl, badgeEl) {
    this.container = containerEl;
    this.badge = badgeEl;
    this.renderLayout();
  }

  renderLayout() {
    this.container.innerHTML = `
      <div class="tab-toolbar">
        <div class="filter-group">
          <button class="filter-btn active" data-filter="all">全部</button>
          <button class="filter-btn" data-filter="native">原生音频</button>
          <button class="filter-btn" data-filter="extract">音轨提取</button>
        </div>
        <div class="search-wrap">
          <input type="text" class="search-input" id="audio-search-input" placeholder="搜索音频名称..." />
        </div>
      </div>
      <div class="resource-list" id="audio-list"></div>
    `;

    this.listEl = this.container.querySelector('#audio-list');
    this.searchInput = this.container.querySelector('#audio-search-input');

    this.container.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.container.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.filter = btn.dataset.filter;
        this.renderList();
      });
    });

    this.searchInput.addEventListener('input', () => {
      this.renderList();
    });

    this.renderList();
  }

  setMedia(mediaList, activeTabId) {
    this.activeTabId = activeTabId;
    this.rawMedia = Array.isArray(mediaList) ? mediaList.slice() : [];
    this.refreshFromRaw();
  }

  /** 增量更新：只处理这一条，避免整页资源反复全量重算（AUDIT E3） */
  upsertMedia(media) {
    if (!media) return;
    const index = this.rawMedia.findIndex((item) => item.key === media.key || (item.hash && item.hash === media.hash));
    if (index >= 0) this.rawMedia[index] = media;
    else this.rawMedia.unshift(media);
    this.refreshFromRaw();
  }

  refreshFromRaw() {
    this.audioItems = [];

    this.rawMedia.forEach(m => {
      const isAudio = m.is_audio || ['mp3', 'm4a', 'aac', 'flac', 'ogg', 'wav', 'opus'].includes((m.extension || '').toLowerCase());
      const quality = (Array.isArray(m.qualities) && m.qualities[0]) || null;
      const audioTracks = Array.isArray(m.audio_qualities) ? m.audio_qualities : [];
      const hasSeparateAudio = Boolean(
        m.audioUrl
        || (quality && quality.audioUrl && quality.audioUrl !== quality.videoUrl)
        || audioTracks.length > 0
      );

      if (isAudio) {
        this.audioItems.push({
          ...m,
          category: 'native',
          displayFormat: (m.extension || 'MP3').toUpperCase()
        });
      } else if (hasSeparateAudio) {
        // 音画分离流：音轨本身是成品，截取不需要重新编码
        const trackFormat = audioTracks.length > 0 && audioTracks[0].demuxer
          ? String(audioTracks[0].demuxer).toUpperCase()
          : 'M4A';
        this.audioItems.push({
          ...m,
          category: 'extract',
          audioTrackUrl: audioTracks.length > 0 ? audioTracks[0].audioUrl : '',
          displayFormat: trackFormat + ' (音轨)'
        });
      }
      // 只有视频轨的资源不再出现在音频页：本版本无法无损提取音轨，
      // 放进列表只会诱导用户拿到一个改了后缀的坏文件（AUDIT A5）。
    });

    if (this.badge) {
      this.badge.textContent = this.audioItems.length > 0 ? this.audioItems.length : '';
    }
    this.scheduleRender();
  }

  scheduleRender() {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.renderList();
    }, 120);
  }

  getFilteredAudios() {
    const query = (this.searchInput?.value || '').trim().toLowerCase();
    return this.audioItems.filter(item => {
      if (this.filter === 'native' && item.category !== 'native') return false;
      if (this.filter === 'extract' && item.category !== 'extract') return false;

      if (query) {
        const title = (item.title || '').toLowerCase();
        if (!title.includes(query)) return false;
      }
      return true;
    });
  }

  renderList() {
    if (!this.listEl) return;
    const list = this.getFilteredAudios();

    if (list.length === 0) {
      this.listEl.innerHTML = `
        <div class="empty-state">
          <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M9 18V5l12-2v13"></path>
            <circle cx="6" cy="18" r="3"></circle>
            <circle cx="18" cy="16" r="3"></circle>
          </svg>
          <div class="empty-title">未发现音频资源</div>
          <div class="empty-desc">页面中的音频文件与音画分离流会出现在这里；只有视频轨的资源需等下载引擎支持后开放无损提取。</div>
          <button class="action-btn-outline" id="resniff-audio-btn">
            <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M23 4v6h-6"></path>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
            </svg>
            重新嗅探
          </button>
        </div>
      `;
      this.listEl.querySelector('#resniff-audio-btn')?.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('request-resniff'));
      });
      return;
    }

    clear(this.listEl);
    list.forEach(item => {
      const card = this.createAudioCard(item);
      this.listEl.appendChild(card);
    });
  }

  createAudioCard(item) {
    const card = document.createElement('div');
    card.className = 'resource-card';
    card.dataset.hash = item.hash;

    const title = item.title || '未知音频文件';
    const durationText = bus.formatDuration(item.duration);
    const isNative = item.category === 'native';

    const sizeText = bus.formatBytes(item.size);
    card.appendChild(el('div', { class: 'card-header' }, [
      el('span', { class: 'type-pill audio-pill', text: item.displayFormat || 'AUDIO' }),
      durationText ? el('span', { class: 'duration-badge', text: durationText }) : null,
      sizeText ? el('span', { class: 'size-badge', text: sizeText }) : null,
      el('div', { class: 'spacer' }),
      el('span', {
        class: isNative ? 'status-pill green' : 'status-pill cyan',
        text: isNative ? '原生音频' : '无损音轨'
      })
    ]));

    card.appendChild(el('div', { class: 'card-title', title: title, text: title }));

    const playable = isNative && typeof item.url === 'string' && item.url.startsWith('http');
    if (playable) {
      card.appendChild(el('div', { class: 'audio-player-wrap' }, [
        el('audio', { controls: true, preload: 'none', src: item.url, class: 'mini-audio-player' })
      ]));
    }

    card.appendChild(el('div', { class: 'card-progress hidden' }, [
      el('div', { class: 'progress-info' }, [
        el('span', { class: 'progress-status', text: '准备提取音频...' }),
        el('span', { class: 'progress-percent', text: '0%' })
      ]),
      el('div', { class: 'progress-bar-bg' }, [
        el('div', { class: 'progress-bar-fill audio-fill', style: { width: '0%' } })
      ])
    ]));

    card.appendChild(el('div', { class: 'card-actions' }, [
      el('button', { class: 'action-btn audio-download-btn' }, [icon('download'), isNative ? '下载音频' : '提取音轨']),
      el('button', { class: 'action-btn-secondary copy-audio-link-btn', title: '复制链接' }, [icon('copy')])
    ]));

    const downloadBtn = card.querySelector('.audio-download-btn');
    const copyBtn = card.querySelector('.copy-audio-link-btn');

    downloadBtn.addEventListener('click', async () => {
      downloadBtn.disabled = true;
      downloadBtn.innerHTML = `
        <span class="spinner"></span>
        调度中...
      `;

      const resp = await bus.sendToService({
        type: 'RH_DOWNLOAD',
        tabId: this.activeTabId,
        media_key: item.key,
        media_hash: item.hash,
        audio_url: item.audioTrackUrl || '',
        audio_only: true
      });

      if (resp && resp.success) {
        bus.showToast('音频提取任务已启动', 'success');
        if (resp.download_id) {
          this.downloads.set(resp.download_id, {
            card,
            item,
            progressEl: card.querySelector('.card-progress'),
            statusEl: card.querySelector('.progress-status'),
            percentEl: card.querySelector('.progress-percent'),
            fillEl: card.querySelector('.progress-bar-fill')
          });
          card.querySelector('.card-progress').classList.remove('hidden');
        }
      } else {
        bus.showToast(`音频下载失败: ${resp?.message || resp?.error || '未知错误'}`, 'error');
        downloadBtn.disabled = false;
        downloadBtn.textContent = isNative ? '下载音频' : '提取音轨';
      }
    });

    copyBtn.addEventListener('click', () => {
      const url = item.url || '';
      if (url) {
        navigator.clipboard.writeText(url).then(() => {
          bus.showToast('音频直链已复制', 'success');
        }).catch(() => {
          bus.showToast('复制失败', 'error');
        });
      } else {
        bus.showToast('该资源为复合分片流，无单一直链', 'info');
      }
    });

    return card;
  }

  updateProgress(downloadId, progress) {
    const dl = this.downloads.get(downloadId);
    if (!dl) return;

    dl.progressEl.classList.remove('hidden');
    const percent = Math.min(100, Math.max(0, Math.round(progress.percent || 0)));
    dl.fillEl.style.width = `${percent}%`;
    dl.percentEl.textContent = `${percent}%`;

    if (progress.status === 'queuing') {
      dl.statusEl.textContent = '音频任务排队中...';
    } else if (progress.status === 'downloading') {
      dl.statusEl.textContent = `音频拉取中 (${percent}%)`;
    } else if (progress.status === 'finalizing') {
      dl.statusEl.textContent = '音频处理与保存中...';
    } else if (progress.status === 'completed' || percent >= 100) {
      dl.statusEl.textContent = '音频已保存';
      dl.fillEl.style.backgroundColor = '#10b981';
      setTimeout(() => {
        const dlBtn = dl.card.querySelector('.audio-download-btn');
        if (dlBtn) {
          dlBtn.disabled = false;
          dlBtn.textContent = '再次下载';
        }
      }, 2000);
    }
  }
}
