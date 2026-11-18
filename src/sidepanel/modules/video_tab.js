import { streamDownloader } from './stream_downloader.js';
import { dashDownloader } from './dash_downloader.js';
import { MseRecorder } from '../../core/mse-record.js';
import { LiveRecorder } from './live_recorder.js';
import { TaskQueue } from '../../core/task-queue.js';
import { finalizeBlobDownload } from './download_finalize.js';
import { mediaMuxer } from './media_muxer.js';
import { bus } from './bus.js';
import { el, clear } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';

const PURE_AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'flac', 'ogg', 'wav', 'opus']);

export class VideoTab {
  constructor() {
    this.container = null;
    this.badge = null;
    this.rawMedia = [];
    this.videos = [];
    this.filter = 'all';
    this.activeTabId = null;
    this.renderTimer = null;
    this.downloads = new Map(); // download_id -> { percent, status, el }

    // 引擎下载串行执行（HLS / DASH / 合流），避免多张卡同时抢带宽
    this.queue = new TaskQueue({
      concurrency: 1,
      onChange: (snapshot) => {
        const waiting = snapshot.pending.length;
        if (this.badge) this.badge.dataset.queue = waiting > 0 ? String(waiting) : '';
        this.renderQueueBar(waiting, snapshot.running);
      }
    });
  }

  /** 队列可见性：让用户知道"点了但还没开始"以及能取消 */
  renderQueueBar(waiting, running) {
    if (!this.queueBar) return;
    if (!waiting && !running) {
      this.queueBar.classList.add('hidden');
      return;
    }
    this.queueBar.classList.remove('hidden');
    const parts = [];
    if (running) parts.push('1 个下载进行中');
    if (waiting) parts.push(waiting + ' 个排队中');
    if (this.queueText) this.queueText.textContent = parts.join(' · ');
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
          <button class="filter-btn" data-filter="hls">HLS / M3U8</button>
          <button class="filter-btn" data-filter="mp4">MP4 原画</button>
        </div>
        <div class="search-wrap">
          <input type="text" class="search-input" id="video-search-input" placeholder="搜索标题或清晰度..." />
        </div>
      </div>
      <div class="queue-bar hidden" id="queue-bar">
        <span class="queue-text" id="queue-text"></span>
        <button class="action-btn-sm" id="queue-cancel-btn">取消排队</button>
      </div>
      <div class="resource-list" id="video-list"></div>
    `;

    this.listEl = this.container.querySelector('#video-list');
    this.searchInput = this.container.querySelector('#video-search-input');
    this.queueBar = this.container.querySelector('#queue-bar');
    this.queueText = this.container.querySelector('#queue-text');

    const cancelBtn = this.container.querySelector('#queue-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        const cancelled = this.queue.cancelPending();
        bus.showToast(cancelled > 0 ? `已取消 ${cancelled} 个排队任务` : '没有排队中的任务', 'info');
      });
    }

    this.container.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
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

  setVideos(videos, activeTabId) {
    this.activeTabId = activeTabId;
    this.rawMedia = Array.isArray(videos) ? videos.slice() : [];
    this.refreshFromRaw();
  }

  /** 增量更新：后台发现新资源时只推这一条，不再全量重取（AUDIT E3） */
  upsertMedia(media) {
    if (!media) return;
    const index = this.rawMedia.findIndex((item) => item.key === media.key || (item.hash && item.hash === media.hash));
    if (index >= 0) this.rawMedia[index] = media;
    else this.rawMedia.unshift(media);
    this.refreshFromRaw();
  }

  refreshFromRaw() {
    this.videos = this.rawMedia.filter((item) => {
      if (item.is_audio) return false;
      return !PURE_AUDIO_EXTS.has((item.extension || '').toLowerCase());
    });
    if (this.badge) {
      this.badge.textContent = this.videos.length > 0 ? this.videos.length : '';
    }
    this.scheduleRender();
  }

  /** 合并 120ms 内的多次更新，避免一次页面加载触发几十次全列表重绘 */
  /** P5：页面里有 MSE 播放器 / blob 播放时给出的解释性提示 */
  setHookHint(hint) {
    this.hookHint = hint || null;
    this.scheduleRender();
  }

  /** 录制中的状态（P5 第二步） */
  setRecording(state) {
    this.recording = Object.assign({ active: false, chunks: 0, bytes: 0, error: '' }, this.recording || {}, state || {});
    this.scheduleRender();
  }

  async startRecording() {
    const tabId = this.activeTabId;
    if (!tabId) return;
    this.recorder = new MseRecorder();
    this.setRecording({ active: true, chunks: 0, bytes: 0, error: '' });
    const response = await bus.sendToTab(tabId, { type: 'RH_RECORD_COMMAND', action: 'start' });
    if (!response || response.reason === 'no_receiver') {
      this.setRecording({ active: false, error: '该页面没有响应录制指令（内容脚本可能未注入）' });
      return;
    }
    bus.showToast('已开始录制，请把视频从头播到尾', 'info');
  }

  /** 钩子推来的 MSE 分片 */
  acceptRecordChunk(message) {
    if (!this.recorder || !this.recording || !this.recording.active) return;
    let bytes;
    try {
      const binary = atob(String(message.b64 || ''));
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
    } catch (e) {
      return;
    }
    const result = this.recorder.add(message.mimeType, bytes);
    this.setRecording({
      chunks: this.recording.chunks + (result.accepted ? 1 : 0),
      bytes: this.recorder.totalBytes,
      error: result.accepted ? '' : (result.reason === 'TOO_LARGE' ? '已达到录制上限，后续数据被丢弃' : '')
    });
  }

  async stopRecording() {
    const tabId = this.activeTabId;
    if (tabId) await bus.sendToTab(tabId, { type: 'RH_RECORD_COMMAND', action: 'stop' });
    const recorder = this.recorder;
    this.setRecording({ active: false });
    if (!recorder || recorder.totalBytes === 0) {
      this.setRecording({ error: '没有录到数据，请确认播放器在录制期间有播放' });
      return;
    }

    try {
      const assembled = recorder.assemble();
      const blob = new Blob([assembled.data], { type: 'video/mp4' });
      const title = (this.hookHint && this.hookHint.title) || document.title || 'recording';
      const filename = String(title).replace(/[\/:*?"<>|]/g, '_').slice(0, 60) + ' [录制].mp4';
      await finalizeBlobDownload({
        blob: blob,
        filename: filename,
        meta: { title: title, url: '', mode: 'mse', site: '' }
      });

      const warning = assembled.warnings.includes('MISSING_INIT')
        ? '（缺少初始化段，可能无法播放——录制请在视频开头开始）'
        : '';
      bus.showToast('录制完成，已保存' + warning, assembled.warnings.includes('MISSING_INIT') ? 'info' : 'success');
      this.setRecording({ error: '', chunks: 0, bytes: 0 });
    } catch (e) {
      this.setRecording({ error: '组装失败：' + (e && e.message ? e.message : '未知错误') });
    }
  }

  createHookHint(hint) {
    const wrap = el('div', { class: 'hook-hint' });
    const mime = (hint.mseMimeTypes || []).join('、') || '未知编码';
    const lines = [
      hint.mseAppends > 0
        ? `MediaSource 已喂入 ${hint.mseAppends} 段数据${hint.container ? '（容器 ' + hint.container + '）' : ''}`
        : '页面创建了 MediaSource',
      '编码：' + mime
    ];
    if (hint.blobSource) lines.push('播放地址是 blob: 伪地址，网络层抓不到真实文件');
    if (hint.hookUrlCount > 0) lines.push(`已从页面 JS 中补捞 ${hint.hookUrlCount} 个媒体地址`);

    wrap.appendChild(el('div', { class: 'hook-hint-title', text: '该页使用 MSE 流式播放' }));
    wrap.appendChild(el('div', {
      class: 'hook-hint-desc',
      text: lines.join('；') + '。这类流不在网络层暴露完整文件，可以边播边录。'
    }));

    const recording = this.recording || { active: false };
    const actions = el('div', { class: 'hook-hint-actions' });

    if (!recording.active) {
      const startBtn = el('button', { class: 'action-btn-outline', text: '边播边录' });
      startBtn.addEventListener('click', () => this.startRecording());
      actions.appendChild(startBtn);
    } else {
      const stopBtn = el('button', { class: 'action-btn', text: '停止并保存' });
      stopBtn.addEventListener('click', () => this.stopRecording());
      actions.appendChild(stopBtn);
      actions.appendChild(el('span', {
        class: 'hook-hint-progress',
        text: '已录 ' + (recording.chunks || 0) + ' 段 / ' + bus.formatBytes(recording.bytes || 0)
      }));
    }

    wrap.appendChild(actions);
    if (recording.error) {
      wrap.appendChild(el('div', { class: 'hook-hint-desc', text: recording.error }));
    }
    return wrap;
  }

  scheduleRender() {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.renderList();
    }, 120);
  }

  getFilteredVideos() {
    const query = (this.searchInput?.value || '').trim().toLowerCase();
    return this.videos.filter(v => {
      // Filter by type
      if (this.filter === 'hls' && !v.type?.includes('m3u8')) return false;
      if (this.filter === 'mp4' && (v.type?.includes('m3u8') || v.demuxer === 'm3u8')) return false;

      // Filter by search query
      if (query) {
        const title = (v.title || '').toLowerCase();
        const qualities = (v.qualities || []).map(q => q.label).join(' ').toLowerCase();
        if (!title.includes(query) && !qualities.includes(query)) return false;
      }
      return true;
    });
  }

  renderList() {
    if (!this.listEl) return;
    const list = this.getFilteredVideos();

    const hintNode = this.hookHint && ((this.hookHint.mseMimeTypes || []).length > 0 || this.hookHint.blobSource)
      ? this.createHookHint(this.hookHint)
      : null;

    if (list.length === 0) {
      this.listEl.innerHTML = `
        <div class="empty-state">
          <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polygon points="23 7 16 12 23 17 23 7"></polygon>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
          </svg>
          <div class="empty-title">未发现视频资源</div>
          <div class="empty-desc">请在网页中点击播放视频，或刷新页面后再次嗅探。</div>
          <button class="action-btn-outline" id="resniff-video-btn">
            <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M23 4v6h-6"></path>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
            </svg>
            重新嗅探当前页
          </button>
        </div>
      `;
      this.listEl.querySelector('#resniff-video-btn')?.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('request-resniff'));
      });
      if (hintNode) this.listEl.insertBefore(hintNode, this.listEl.firstChild);
      return;
    }

    clear(this.listEl);
    if (hintNode) this.listEl.appendChild(hintNode);
    list.forEach(video => {
      const card = this.createVideoCard(video);
      this.listEl.appendChild(card);
    });
  }

  createVideoCard(video) {
    const card = document.createElement('div');
    card.className = 'resource-card';
    card.dataset.hash = video.hash;

    const title = video.title || '未知视频标题';
    const durationText = bus.formatDuration(video.duration);
    const isM3u8 = video.type?.includes('m3u8') || (video.demuxer && video.demuxer.includes('m3u8'));
    const tagType = isM3u8 ? 'HLS 切片' : (video.extension || 'MP4').toUpperCase();

    const sizeText = bus.formatBytes(video.size);
    card.appendChild(el('div', { class: 'card-header' }, [
      el('span', { class: 'type-pill video-pill', text: tagType }),
      durationText ? el('span', { class: 'duration-badge', text: durationText }) : null,
      sizeText ? el('span', { class: 'size-badge', text: sizeText }) : null,
      el('div', { class: 'spacer' }),
      buildQualityControl(video.qualities || [])
    ]));

    card.appendChild(el('div', { class: 'card-title', title: title, text: title }));

    card.appendChild(el('div', { class: 'card-progress hidden' }, [
      el('div', { class: 'progress-info' }, [
        el('span', { class: 'progress-status', text: '准备下载...' }),
        el('span', { class: 'progress-percent', text: '0%' })
      ]),
      el('div', { class: 'progress-bar-bg' }, [
        el('div', { class: 'progress-bar-fill', style: { width: '0%' } })
      ])
    ]));

    const isHlsVideo = (video.url && video.url.includes('.m3u8')) || (video.type && video.type.includes('m3u8'));

    card.appendChild(el('div', { class: 'card-actions' }, [
      el('button', { class: 'action-btn download-btn' }, [icon('download'), '下载视频']),
      isHlsVideo ? el('button', { class: 'action-btn-outline live-record-btn', title: '直播边播边录' }, '录制直播') : null,
      el('button', { class: 'action-btn-secondary copy-link-btn', title: '复制直链' }, [icon('copy')])
    ].filter(Boolean)));

    const downloadBtn = card.querySelector('.download-btn');
    const copyBtn = card.querySelector('.copy-link-btn');
    const liveBtn = card.querySelector('.live-record-btn');
    const qualitySelect = card.querySelector('.quality-select');

    if (liveBtn) {
      liveBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        await this.toggleLiveRecording(video, card, liveBtn);
      });
    }

    downloadBtn.addEventListener('click', async () => {
      let selectedQualityIndex = qualitySelect ? parseInt(qualitySelect.value, 10) : 0;
      downloadBtn.disabled = true;

      const progressEl = card.querySelector('.card-progress');
      const statusEl = card.querySelector('.progress-status');
      const percentEl = card.querySelector('.progress-percent');
      const fillEl = card.querySelector('.progress-bar-fill');

      progressEl.classList.remove('hidden');

      const isM3u8 = (video.url && video.url.includes('.m3u8')) || (video.type && video.type.includes('m3u8'));

      if (isM3u8) {
        const local = () => this.enqueueDownload(video.title, card, () => this.executeM3u8Download(video, card));
        if (await this.tryOffscreen('hls', { url: video.url, title: video.title }, card, local)) return;
        await local();
        return;
      }

      const isDash = (video.url && video.url.includes('.mpd')) || (video.type && video.type.includes('mpd'));
      if (isDash) {
        const local = () => this.enqueueDownload(video.title, card, () => this.executeDashDownload(video, card));
        if (await this.tryOffscreen('dash', { url: video.url, title: video.title }, card, local)) return;
        await local();
        return;
      }

      // Check for DASH / Bilibili / YouTube separated video and audio streams
      const selectedQuality = (video.qualities && video.qualities[selectedQualityIndex]) || video;
      const vUrl = selectedQuality.videoUrl || video.url;
      const aUrl = selectedQuality.audioUrl;

      if (vUrl && aUrl && vUrl !== aUrl) {
        const local = () => this.enqueueDownload(
          video.title,
          card,
          () => this.executeSeparatedMuxDownload(vUrl, aUrl, video.title, card)
        );
        if (await this.tryOffscreen('mux', { url: vUrl, audioUrl: aUrl, title: video.title }, card, local)) return;
        await local();
        return;
      }

      downloadBtn.innerHTML = `
        <span class="spinner"></span>
        调度中...
      `;

      const resp = await bus.sendToService({
        type: 'RH_DOWNLOAD',
        tabId: this.activeTabId,
        media_key: video.key,
        media_hash: video.hash,
        playlist_index: selectedQualityIndex,
        audio_only: false
      });

      if (resp && resp.success) {
        bus.showToast(resp.warning ? resp.warning : '已加入下载队列', resp.warning ? 'info' : 'success');
        if (resp.download_id) {
          this.downloads.set(resp.download_id, {
            card,
            video,
            progressEl: card.querySelector('.card-progress'),
            statusEl: card.querySelector('.progress-status'),
            percentEl: card.querySelector('.progress-percent'),
            fillEl: card.querySelector('.progress-bar-fill')
          });
          card.querySelector('.card-progress').classList.remove('hidden');
        }
      } else {
        bus.showToast(`下载启动失败: ${resp?.message || resp?.error || '未知错误'}`, 'error');
        downloadBtn.disabled = false;
        downloadBtn.textContent = '下载视频';
      }
    });

    copyBtn.addEventListener('click', () => {
      const url = video.url || '';
      if (url) {
        navigator.clipboard.writeText(url).then(() => {
          bus.showToast('视频直链已复制', 'success');
        }).catch(() => {
          bus.showToast('复制失败，请手动选择', 'error');
        });
      } else {
        bus.showToast('该视频为流媒体切片，无单一直链', 'info');
      }
    });

    return card;
  }

  async executeM3u8Download(video, card, downloadId) {
    const downloadBtn = card ? card.querySelector('.download-btn') : null;
    const progressEl = card ? card.querySelector('.card-progress') : null;
    const statusEl = card ? card.querySelector('.progress-status') : null;
    const percentEl = card ? card.querySelector('.progress-percent') : null;
    const fillEl = card ? card.querySelector('.progress-bar-fill') : null;

    if (downloadBtn) downloadBtn.disabled = true;
    if (progressEl) progressEl.classList.remove('hidden');
    if (fillEl) fillEl.style.backgroundColor = '#0284c7';

    const dlId = downloadId || `m3u8_${Date.now()}`;

    try {
      await streamDownloader.downloadM3u8(video.url, video.title, (percent, statusText) => {
        if (fillEl) fillEl.style.width = `${percent}%`;
        if (percentEl) percentEl.textContent = `${percent}%`;
        if (statusEl) statusEl.textContent = statusText;

        // Broadcast progress to active page overlay
        chrome.runtime.sendMessage({
          type: 'RH_DOWNLOAD_PROGRESS',
          download_id: dlId,
          progress: { percent, status: percent >= 100 ? 'completed' : 'downloading' }
        }).catch(() => {});
      });

      if (fillEl) fillEl.style.backgroundColor = '#10b981';
      bus.showToast('完整视频合并完成并已保存！', 'success');
      if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.textContent = '再次下载';
      }

      chrome.runtime.sendMessage({
        type: 'RH_DOWNLOAD_COMPLETE',
        download_id: dlId
      }).catch(() => {});
    } catch (err) {
      console.error('[VideoTab] M3U8 download error:', err);
      if (statusEl) statusEl.textContent = `失败: ${err.message}`;
      if (fillEl) fillEl.style.backgroundColor = '#ef4444';
      bus.showToast(`下载失败: ${err.message}`, 'error');
      if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.textContent = '重试下载';
      }
    }
  }

  /**
   * 优先交给后台的 offscreen 构建：关闭侧边栏也能继续。
   * 返回 true 表示"已经接管"；false 表示不支持/失败，调用方走本地构建。
   */
  async tryOffscreen(kind, payload, card, retry) {
    let response = null;
    try {
      response = await bus.sendToService({
        type: 'RH_OFFSCREEN_BUILD',
        kind: kind,
        payload: payload,
        tabId: this.activeTabId
      });
    } catch (e) {
      return false;
    }
    if (!response || !response.ok) return false;

    this.offscreenJobs = this.offscreenJobs || new Map();
    this.offscreenJobs.set(response.jobId, { card: card, retry: retry });

    const statusEl = card ? card.querySelector('.progress-status') : null;
    const progressEl = card ? card.querySelector('.card-progress') : null;
    if (progressEl) progressEl.classList.remove('hidden');
    if (statusEl) statusEl.textContent = '已交给后台构建（可以关闭侧边栏）…';
    return true;
  }

  /** offscreen 构建进度 */
  handleBuildProgress(message) {
    if (!message || !this.offscreenJobs) return;
    const job = this.offscreenJobs.get(message.job_id);
    if (!job || !job.card) return;
    const fillEl = job.card.querySelector('.progress-bar-fill');
    const percentEl = job.card.querySelector('.progress-percent');
    const statusEl = job.card.querySelector('.progress-status');
    if (fillEl) fillEl.style.width = message.percent + '%';
    if (percentEl) percentEl.textContent = message.percent + '%';
    if (statusEl && message.text) statusEl.textContent = message.text;
  }

  /** offscreen 构建结束：成功就等浏览器下载；失败回退到本地构建 */
  handleBuildResult(message) {
    if (!message || !this.offscreenJobs) return;
    const job = this.offscreenJobs.get(message.job_id);
    if (!job) return;
    this.offscreenJobs.delete(message.job_id);

    if (message.ok) {
      const statusEl = job.card ? job.card.querySelector('.progress-status') : null;
      if (statusEl) statusEl.textContent = '已交给浏览器下载';
      return;
    }

    bus.showToast('后台构建失败，改在本页继续：' + (message.error || '未知原因'), 'info');
    if (typeof job.retry === 'function') job.retry();
  }

  /**
   * 引擎下载统一排队：串行执行，避免多张卡同时各开几路并发把带宽打满。
   * 排队期间卡片上显示"前面还有几个"。
   */
  enqueueDownload(label, card, run) {
    if (!this.queue) return run();

    const statusEl = card ? card.querySelector('.progress-status') : null;
    const progressEl = card ? card.querySelector('.card-progress') : null;
    if (progressEl) progressEl.classList.remove('hidden');
    if (statusEl) {
      statusEl.textContent = this.queue.size > 0
        ? `排队中…（前面还有 ${this.queue.size} 个）`
        : '准备中…';
    }

    return this.queue.add({ label: label || '', run: run }).catch((error) => {
      if (error && error.code === 'TASK_CANCELLED') return null;
      if (statusEl) statusEl.textContent = '失败：' + ((error && error.message) || '未知错误');
      throw error;
    });
  }

  /** 直播边播边录（P7）：同一张卡再点一次即停止并保存 */
  async toggleLiveRecording(video, card, button) {
    if (!this.liveRecorder) this.liveRecorder = new LiveRecorder();

    if (this.liveRecorder.active) {
      button.disabled = true;
      try {
        const result = await this.liveRecorder.stop();
        const warning = result.failedSegments > 0 ? `（${result.failedSegments} 片失败）` : '';
        bus.showToast(`录制完成：${result.segments} 段 / ${bus.formatBytes(result.bytes)}${warning}`, 'success');
      } catch (e) {
        bus.showToast('录制失败：' + ((e && e.message) || '未知错误'), 'error');
      }
      button.textContent = '录制直播';
      button.disabled = false;
      button.classList.remove('recording');
      return;
    }

    try {
      await this.liveRecorder.start({
        url: video.url,
        title: video.title,
        onProgress: (info) => {
          button.textContent = `录制中 ${info.seconds}s · ${info.segments} 段`;
        }
      });
      button.textContent = '录制中 0s · 0 段';
      button.classList.add('recording');
    } catch (e) {
      bus.showToast('无法开始录制：' + ((e && e.message) || '未知错误'), 'error');
    }
  }

  async executeDashDownload(video, card, downloadId) {
    const downloadBtn = card ? card.querySelector('.download-btn') : null;
    const progressEl = card ? card.querySelector('.card-progress') : null;
    const statusEl = card ? card.querySelector('.progress-status') : null;
    const percentEl = card ? card.querySelector('.progress-percent') : null;
    const fillEl = card ? card.querySelector('.progress-bar-fill') : null;

    if (downloadBtn) downloadBtn.disabled = true;
    if (progressEl) progressEl.classList.remove('hidden');
    if (fillEl) fillEl.style.backgroundColor = '#0ea5e9';

    const dlId = downloadId || `dash_${Date.now()}`;

    try {
      await dashDownloader.download(video.url, video.title, (percent, statusText) => {
        if (fillEl) fillEl.style.width = `${percent}%`;
        if (percentEl) percentEl.textContent = `${percent}%`;
        if (statusEl) statusEl.textContent = statusText;
        chrome.runtime.sendMessage({
          type: 'RH_DOWNLOAD_PROGRESS',
          download_id: dlId,
          progress: { percent, status: percent >= 100 ? 'completed' : 'downloading' }
        }).catch(() => {});
      });

      if (fillEl) fillEl.style.backgroundColor = '#10b981';
      bus.showToast('DASH 视频已合流并保存', 'success');
      if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.textContent = '再次下载';
      }
    } catch (err) {
      console.error('[VideoTab] DASH download error:', err);
      if (statusEl) statusEl.textContent = `失败: ${err.message}`;
      if (fillEl) fillEl.style.backgroundColor = '#ef4444';
      bus.showToast(`DASH 下载失败: ${err.message}`, 'error');
      if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.textContent = '重试下载';
      }
    }
  }

  startDashDownload(media, downloadId) {
    const card = this.listEl ? this.listEl.querySelector(`.resource-card[data-hash="${media.hash}"]`) : null;
    this.executeDashDownload(media, card, downloadId);
  }

  async executeSeparatedMuxDownload(vUrl, aUrl, title, card, downloadId) {
    const downloadBtn = card ? card.querySelector('.download-btn') : null;
    const progressEl = card ? card.querySelector('.card-progress') : null;
    const statusEl = card ? card.querySelector('.progress-status') : null;
    const percentEl = card ? card.querySelector('.progress-percent') : null;
    const fillEl = card ? card.querySelector('.progress-bar-fill') : null;

    if (downloadBtn) downloadBtn.disabled = true;
    if (progressEl) progressEl.classList.remove('hidden');
    if (fillEl) fillEl.style.backgroundColor = '#8b5cf6';

    const dlId = downloadId || `mux_${Date.now()}`;

    try {
      await mediaMuxer.mergeAndDownload(vUrl, aUrl, title, (percent, statusText) => {
        if (fillEl) fillEl.style.width = `${percent}%`;
        if (percentEl) percentEl.textContent = `${percent}%`;
        if (statusEl) statusEl.textContent = statusText;

        // Broadcast progress to active page overlay
        chrome.runtime.sendMessage({
          type: 'RH_DOWNLOAD_PROGRESS',
          download_id: dlId,
          progress: { percent, status: percent >= 100 ? 'completed' : 'downloading' }
        }).catch(() => {});
      });

      if (fillEl) fillEl.style.backgroundColor = '#10b981';
      bus.showToast('音画合流完成并已保存！', 'success');
      if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.textContent = '再次下载';
      }

      chrome.runtime.sendMessage({
        type: 'RH_DOWNLOAD_COMPLETE',
        download_id: dlId
      }).catch(() => {});
    } catch (err) {
      console.error('[VideoTab] Mux error:', err);
      if (statusEl) statusEl.textContent = `失败: ${err.message}`;
      if (fillEl) fillEl.style.backgroundColor = '#ef4444';
      bus.showToast(`合流失败: ${err.message}`, 'error');
      if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.textContent = '重试下载';
      }
    }
  }

  startSeparatedMuxDownload(videoUrl, audioUrl, title, downloadId) {
    this.renderList();
    this.executeSeparatedMuxDownload(videoUrl, audioUrl, title, null, downloadId);
  }

  startStreamDownload(media, downloadId) {
    let card = this.listEl ? this.listEl.querySelector(`.resource-card[data-hash="${media.hash}"]`) : null;
    this.executeM3u8Download(media, card, downloadId);
  }

  updateProgress(downloadId, progress) {
    const dl = this.downloads.get(downloadId);
    if (!dl) return;

    dl.progressEl.classList.remove('hidden');
    const percent = Math.min(100, Math.max(0, Math.round(progress.percent || 0)));
    dl.fillEl.style.width = `${percent}%`;
    dl.percentEl.textContent = `${percent}%`;

    if (progress.status === 'queuing') {
      dl.statusEl.textContent = '排队中...';
    } else if (progress.status === 'downloading') {
      dl.statusEl.textContent = `下载中 (${percent}%)`;
    } else if (progress.status === 'finalizing') {
      dl.statusEl.textContent = '合流转码中...';
    } else if (progress.status === 'completed' || percent >= 100) {
      dl.statusEl.textContent = '下载完成';
      dl.fillEl.style.backgroundColor = '#10b981';
      setTimeout(() => {
        const dlBtn = dl.card.querySelector('.download-btn');
        if (dlBtn) {
          dlBtn.disabled = false;
          dlBtn.textContent = '再次下载';
        }
      }, 2000);
    }
  }
}

/**
 * 画质选择器：多个画质渲染成 select，单个渲染成徽标。
 * 用 DOM 构造而不是字符串拼接——画质标签来自站点数据，属于不可信输入。
 */
function buildQualityControl(qualities) {
  if (qualities.length > 1) {
    const select = el('select', { class: 'quality-select' });
    qualities.forEach((quality, index) => {
      const value = quality && Number.isInteger(quality.index) ? quality.index : index;
      const label = (quality && quality.label) ? String(quality.label) : '画质 ' + (index + 1);
      select.appendChild(el('option', { value: String(value), text: label }));
    });
    return select;
  }
  const label = qualities.length === 1 && qualities[0] && qualities[0].label
    ? String(qualities[0].label)
    : '原画';
  return el('span', { class: 'quality-badge', text: label });
}
