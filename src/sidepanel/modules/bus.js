/**
 * Unified Message Bus & Tab Helper for Side Panel
 */
export const bus = {
  async getActiveTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs && tabs.length > 0 ? tabs[0] : null;
    } catch (e) {
      console.warn('[Bus] getActiveTab failed:', e);
      return null;
    }
  },

  async sendToService(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (e) {
      console.warn('[Bus] sendToService failed:', e);
      return { success: false, error: e.message };
    }
  },

  async sendToTab(tabId, message) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      // 目标页没有内容脚本（浏览器内部页、扩展安装前就打开的标签页等）属于预期情况，
      // 不作为错误刷警告，由调用方回退到 chrome.scripting.executeScript 注入。
      if (/Receiving end does not exist|Could not establish connection/i.test(msg)) {
        console.debug(`[Bus] sendToTab (${tabId}): no content script receiver`);
        return { success: false, error: msg, reason: 'no_receiver' };
      }
      console.warn(`[Bus] sendToTab (${tabId}) failed:`, e);
      return { success: false, error: msg };
    }
  },

  /** 浏览器内部页面、应用商店页等无法注入内容脚本的地址 */
  isRestrictedUrl(url) {
    if (!url) return true;
    if (/^(chrome|edge|brave|opera|vivaldi|about|devtools|view-source|chrome-extension|moz-extension|edge-extension|chrome-search|chrome-untrusted):/i.test(url)) {
      return true;
    }
    return /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)\//i.test(url);
  },

  /** 该标签页是否允许注入内容脚本 */
  async canInject(tabId) {
    if (!tabId || tabId < 0) return false;
    try {
      const tab = await chrome.tabs.get(tabId);
      return !this.isRestrictedUrl(tab && (tab.url || tab.pendingUrl));
    } catch (e) {
      return false;
    }
  },

  onMessage(callback) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      try {
        callback(message, sender, sendResponse);
      } catch (e) {
        console.error('[Bus] onMessage callback error:', e);
      }
    });
  },

  formatBytes(bytes) {
    if (!bytes || isNaN(bytes) || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return `${val.toFixed(val >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  },

  formatDuration(seconds) {
    if (!seconds || isNaN(seconds) || seconds <= 0) return '';
    const s = Math.floor(seconds);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const remM = m % 60;
    const remS = s % 60;
    if (h > 0) {
      return `${h}:${String(remM).padStart(2, '0')}:${String(remS).padStart(2, '0')}`;
    }
    return `${remM}:${String(remS).padStart(2, '0')}`;
  },

  showToast(text, type = 'info', duration = 2400) {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast-item toast-${type}`;
    toast.textContent = text;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-fadeout');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
};
