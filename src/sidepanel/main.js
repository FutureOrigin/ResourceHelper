import { bus } from './modules/bus.js';
import { VideoTab } from './modules/video_tab.js';
import { AudioTab } from './modules/audio_tab.js';
import { HistoryTab } from './modules/history_tab.js';
import { ImageTab } from './modules/image_tab.js';
import { TextTab } from './modules/text_tab.js';
import { PageTab } from './modules/page_tab.js';

class App {
  constructor() {
    this.currentTab = 'video';
    this.activeTabInfo = null;
    this.videoTab = new VideoTab();
    this.audioTab = new AudioTab();
    this.imageTab = new ImageTab();
    this.textTab = new TextTab();
    this.pageTab = new PageTab();
    this.historyTab = new HistoryTab();
  }

  async init() {
    this.bindHeaderElements();
    this.bindNavTabs();
    this.initModules();
    this.bindTabEvents();
    this.bindServiceWorkerListener();

    await this.refreshActiveTab();
  }

  bindHeaderElements() {
    this.domainChip = document.getElementById('current-domain-chip');
    this.favIcon = document.getElementById('current-fav-icon');
    this.refreshBtn = document.getElementById('global-refresh-btn');
    this.sidePanelBtn = document.getElementById('open-sidepanel-btn');

    // 面板本身已是默认入口，这个按钮改为"在独立窗口中打开"：
    // 既能在弹窗/侧边栏里安全使用（不会反过来关掉自己），也方便边浏览边操作。
    this.sidePanelBtn?.addEventListener('click', async () => {
      try {
        await chrome.windows.create({
          url: chrome.runtime.getURL('sidepanel/index.html'),
          type: 'popup',
          width: 420,
          height: 640
        });
      } catch (e) {
        console.warn('[App] Could not open standalone window:', e);
        bus.showToast('无法打开独立窗口', 'error');
      }
    });

    this.refreshBtn?.addEventListener('click', () => {
      bus.showToast('正在重新嗅探当前页面资源...', 'info');
      this.refreshActiveTab(true);
    });

    window.addEventListener('request-resniff', () => {
      this.refreshActiveTab(true);
    });
  }

  bindNavTabs() {
    const navBtns = document.querySelectorAll('.nav-tab-btn');
    navBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        this.switchTab(target);
      });
    });
  }

  switchTab(tabName) {
    this.currentTab = tabName;
    document.querySelectorAll('.nav-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-pane').forEach(pane => {
      pane.classList.toggle('active', pane.id === `pane-${tabName}`);
    });

    if (tabName === 'history') {
      // 历史是全局的（不随标签页变化），切过去时拉一次最新
      this.historyTab.refresh();
    }

    if (tabName === 'page') {
      // 快照页要跟着当前标签页走（标题/地址/是否可保存）
      this.pageTab.setActiveTab(this.activeTabInfo);
    }

    if (tabName === 'image' && this.activeTabInfo?.id) {
      // If image tab is selected and empty, auto trigger scan
      if (this.imageTab.images.length === 0) {
        this.imageTab.scanPageImages();
      }
    }
  }

  initModules() {
    this.videoTab.init(
      document.getElementById('pane-video'),
      document.getElementById('badge-video')
    );
    this.audioTab.init(
      document.getElementById('pane-audio'),
      document.getElementById('badge-audio')
    );
    this.imageTab.init(
      document.getElementById('pane-image'),
      document.getElementById('badge-image')
    );
    this.textTab.init(
      document.getElementById('pane-text'),
      document.getElementById('badge-text')
    );
    this.pageTab.init(
      document.getElementById('pane-page'),
      document.getElementById('badge-page')
    );
    this.historyTab.init(
      document.getElementById('pane-history'),
      document.getElementById('badge-history')
    );
  }

  bindTabEvents() {
    // When user changes active browser tab, re-sync side panel
    if (chrome.tabs?.onActivated) {
      chrome.tabs.onActivated.addListener(() => {
        this.refreshActiveTab();
      });
    }

    if (chrome.tabs?.onUpdated) {
      chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (this.activeTabInfo && tabId === this.activeTabInfo.id && changeInfo.status === 'complete') {
          this.refreshActiveTab();
        }
      });
    }
  }

  bindServiceWorkerListener() {
    bus.onMessage((msg) => {
      if (!msg) return;
      if (msg.type === 'RH_MEDIA_UPSERTED' && msg.media) {
        // 增量：后台只推变化的那一条，这里按 key upsert，不再全量重取（AUDIT E3）
        if (!msg.tab_id || (this.activeTabInfo && msg.tab_id === this.activeTabInfo.id)) {
          this.videoTab.upsertMedia(msg.media);
          this.audioTab.upsertMedia(msg.media);
        }
      } else if (msg.type === 'RH_MEDIA_DETECTED') {
        // 旧消息（悬浮层/兼容路径）：退化为一次全量同步
        if (!msg.tab_id || (this.activeTabInfo && msg.tab_id === this.activeTabInfo.id)) {
          this.fetchMediaFromService();
        }
      } else if (msg.type === 'RH_MEDIA_CLEARED') {
        if (!msg.tab_id || (this.activeTabInfo && msg.tab_id === this.activeTabInfo.id)) {
          this.videoTab.setVideos([], this.activeTabInfo?.id);
          this.audioTab.setMedia([], this.activeTabInfo?.id);
        }
      } else if (msg.type === 'START_STREAM_DOWNLOAD') {
        if (msg.media) {
          this.switchTab('video');
          this.videoTab.startStreamDownload(msg.media, msg.download_id);
        }
      } else if (msg.type === 'RH_HOOK_HINT') {
        if (this.activeTabInfo && msg.tab_id === this.activeTabInfo.id) this.videoTab.setHookHint(msg.hint);
      } else if (msg.type === 'RH_BUILD_PROGRESS') {
        this.videoTab.handleBuildProgress(msg);
      } else if (msg.type === 'RH_BUILD_RESULT') {
        this.videoTab.handleBuildResult(msg);
      } else if (msg.type === 'RH_HISTORY_CHANGED') {
        this.historyTab.setEntries(msg.entries, msg.stats);
      } else if (msg.type === 'RH_RECORD_CHUNK') {
        this.videoTab.acceptRecordChunk(msg);
      } else if (msg.type === 'RH_RECORD_STATE') {
        if (msg.state === 'stopped') this.videoTab.setRecording({ active: false });
      } else if (msg.type === 'START_DASH_DOWNLOAD') {
        if (msg.media) {
          this.switchTab('video');
          this.videoTab.startDashDownload(msg.media, msg.download_id);
        }
      } else if (msg.type === 'START_SEPARATED_MUX_DOWNLOAD') {
        if (msg.videoUrl && msg.audioUrl) {
          this.switchTab('video');
          this.videoTab.startSeparatedMuxDownload(msg.videoUrl, msg.audioUrl, msg.title, msg.download_id);
        }
      } else if (msg.type === 'RH_DOWNLOAD_PROGRESS') {
        if (msg.download_id && msg.progress) {
          this.videoTab.updateProgress(msg.download_id, msg.progress);
          this.audioTab.updateProgress(msg.download_id, msg.progress);
        }
      }
    });
  }

  async refreshActiveTab(force = false) {
    const tab = await bus.getActiveTab();
    if (!tab) return;

    const isSameTab = this.activeTabInfo && this.activeTabInfo.id === tab.id;
    // 换标签页后上一页的 MSE 提示不再适用
    if (!isSameTab) this.videoTab.setHookHint(null);
    this.activeTabInfo = tab;

    // Update UI Header
    try {
      const urlObj = new URL(tab.url || '');
      if (this.domainChip) {
        this.domainChip.textContent = urlObj.hostname || '当前网页';
      }
      if (this.favIcon) {
        if (tab.favIconUrl) {
          this.favIcon.src = tab.favIconUrl;
          this.favIcon.classList.remove('hidden');
        } else {
          this.favIcon.classList.add('hidden');
        }
      }
    } catch (e) {
      if (this.domainChip) this.domainChip.textContent = '当前网页';
    }

    // Notify text and image tabs
    this.textTab.setActiveTab(tab.id);
    this.pageTab.setActiveTab(tab);
    if (!isSameTab || force) {
      this.imageTab.setActiveTab(tab.id);
    }

    // Fetch media from service
    await this.fetchMediaFromService();
  }

  async fetchMediaFromService() {
    if (!this.activeTabInfo?.id) return;
    const resp = await bus.sendToService({
      type: 'RH_GET_MEDIA',
      tabId: this.activeTabInfo.id
    });

    if (resp && resp.success && Array.isArray(resp.media)) {
      this.videoTab.setHookHint(resp.hint || null);
      this.videoTab.setVideos(resp.media, this.activeTabInfo.id);
      this.audioTab.setMedia(resp.media, this.activeTabInfo.id);
    } else {
      this.videoTab.setVideos([], this.activeTabInfo.id);
      this.audioTab.setMedia([], this.activeTabInfo.id);
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});
