import { bus } from './bus.js';
import { el, clear } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { filenameForResource } from '../../core/decision.js';
import { finalizeBlobDownload } from './download_finalize.js';

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

/**
 * 先带凭证抓一次再落盘：
 * 很多图床校验 Referer/Cookie，直接用 chrome.downloads.download({url}) 会 403，
 * 而且浏览器给的默认文件名是 "download (17)"。抓不到时再退回直链下载。
 */
async function fetchAndSave(url) {
  const filename = filenameForResource(url, { extension: 'jpg', prefix: 'image' });
  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const blob = await response.blob();
    await finalizeBlobDownload({
      blob: blob,
      filename: filename,
      meta: { title: filename, url: url, mode: 'direct', site: hostOf(url) }
    });
    return true;
  } catch (e) {
    // 退回浏览器直链下载：至少能让用户拿到东西
    await chrome.downloads.download({ url: url, filename: filename, saveAs: false });
    return false;
  }
}

export class ImageTab {
  constructor() {
    this.container = null;
    this.badge = null;
    this.images = [];
    this.selected = new Set();
    this.filter = 'all'; // all | large | medium
    this.activeTabId = null;
    this.isScanning = false;
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
          <button class="filter-btn" data-filter="large">大图(&gt;500px)</button>
          <button class="filter-btn" data-filter="medium">中图(&gt;200px)</button>
        </div>
        <div class="toolbar-actions">
          <button class="action-btn-sm" id="scan-images-btn">
            <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
            </svg>
            扫描图片
          </button>
        </div>
      </div>

      <div class="image-sub-bar hidden" id="image-batch-bar">
        <label class="select-all-label">
          <input type="checkbox" id="select-all-checkbox" />
          <span>全选 (<span id="selected-count">0</span>)</span>
        </label>
        <div class="spacer"></div>
        <button class="action-btn-sm primary" id="download-selected-btn">
          <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
          批量下载
        </button>
      </div>

      <div class="image-grid-container" id="image-grid"></div>
    `;

    this.gridEl = this.container.querySelector('#image-grid');
    this.batchBar = this.container.querySelector('#image-batch-bar');
    this.selectAllCb = this.container.querySelector('#select-all-checkbox');
    this.selectedCountEl = this.container.querySelector('#selected-count');
    this.scanBtn = this.container.querySelector('#scan-images-btn');
    this.downloadSelectedBtn = this.container.querySelector('#download-selected-btn');

    this.container.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.container.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.filter = btn.dataset.filter;
        this.renderGrid();
      });
    });

    this.scanBtn.addEventListener('click', () => {
      this.scanPageImages();
    });

    this.selectAllCb.addEventListener('change', (e) => {
      const filtered = this.getFilteredImages();
      if (e.target.checked) {
        filtered.forEach(img => this.selected.add(img.src));
      } else {
        filtered.forEach(img => this.selected.delete(img.src));
      }
      this.updateSelectionUI();
    });

    this.downloadSelectedBtn.addEventListener('click', () => {
      this.downloadSelectedImages();
    });

    this.renderGrid();
  }

  setActiveTab(tabId) {
    if (this.activeTabId !== tabId) {
      this.activeTabId = tabId;
      this.images = [];
      this.selected.clear();
      if (this.badge) this.badge.textContent = '';
      this.renderGrid();
      // Auto-scan on tab switch
      this.scanPageImages();
    }
  }

  setImages(images) {
    this.images = images || [];
    this.selected.clear();
    if (this.badge) {
      this.badge.textContent = this.images.length > 0 ? this.images.length : '';
    }
    this.renderGrid();
  }

  async scanPageImages() {
    if (!this.activeTabId || this.isScanning) return;

    // chrome://、扩展商店等页面无法注入内容脚本，提前给出提示而不是抛异常
    if (!(await bus.canInject(this.activeTabId))) {
      bus.showToast('当前页面为浏览器内部页面，无法扫描图片', 'error');
      return;
    }

    this.isScanning = true;
    this.scanBtn.disabled = true;
    this.scanBtn.innerHTML = `
      <span class="spinner"></span>
      扫描中...
    `;

    try {
      // 1. Try sending message to existing content script
      let resp = await bus.sendToTab(this.activeTabId, { type: "SNIFFER_SCAN_IMAGES" });

      // 2. If content script is not yet injected, inject it
      if (!resp || !resp.success) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: this.activeTabId, allFrames: true },
            files: ["content/extractor.js"]
          });
          resp = await bus.sendToTab(this.activeTabId, { type: "SNIFFER_SCAN_IMAGES" });
        } catch (injErr) {
          console.warn("[ImageTab] Content script injection fallback:", injErr);
        }
      }

      if (resp && resp.success && Array.isArray(resp.images)) {
        this.setImages(resp.images);
        bus.showToast("已深度嗅探到 " + resp.images.length + " 张页面图片", "success");
      } else {
        // Fallback: fast inline execution
      const results = await chrome.scripting.executeScript({
        target: { tabId: this.activeTabId, allFrames: true },
        func: () => {
          const found = new Map();

          function addImg(url, width, height, alt) {
            if (!url || typeof url !== 'string') return;
            const clean = url.trim();
            if (clean.startsWith('data:image/svg') || clean.length < 5) return;
            if (!found.has(clean)) {
              found.set(clean, {
                src: clean,
                width: width || 0,
                height: height || 0,
                alt: (alt || '').slice(0, 80)
              });
            } else {
              const cur = found.get(clean);
              if ((!cur.width || cur.width < width) && width) cur.width = width;
              if ((!cur.height || cur.height < height) && height) cur.height = height;
            }
          }

          // 1. Scan <img>
          document.querySelectorAll('img').forEach(img => {
            const src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original');
            const w = img.naturalWidth || img.width || 0;
            const h = img.naturalHeight || img.height || 0;
            addImg(src, w, h, img.alt);

            // Check srcset
            if (img.srcset) {
              img.srcset.split(',').forEach(part => {
                const u = part.trim().split(/\s+/)[0];
                addImg(u, w, h, img.alt);
              });
            }
          });

          // 2. Scan <picture> <source>
          document.querySelectorAll('picture source').forEach(source => {
            if (source.srcset) {
              source.srcset.split(',').forEach(part => {
                const u = part.trim().split(/\s+/)[0];
                addImg(u, 0, 0, '');
              });
            }
          });

          // 3. Scan computed background-image for large elements
          document.querySelectorAll('div, section, article, header, a').forEach(el => {
            const bg = window.getComputedStyle(el).backgroundImage;
            if (bg && bg.startsWith('url(')) {
              const match = bg.match(/url\(["']?([^"']+)["']?\)/);
              if (match && match[1] && !match[1].startsWith('data:')) {
                const rect = el.getBoundingClientRect();
                addImg(match[1], Math.round(rect.width), Math.round(rect.height), '');
              }
            }
          });

          return Array.from(found.values());
        }
      });

      const merged = new Map();
      if (Array.isArray(results)) {
        results.forEach(frameRes => {
          if (frameRes && Array.isArray(frameRes.result)) {
            frameRes.result.forEach(img => {
              if (!merged.has(img.src)) {
                merged.set(img.src, img);
              } else {
                const cur = merged.get(img.src);
                if (img.width > cur.width) cur.width = img.width;
                if (img.height > cur.height) cur.height = img.height;
              }
            });
          }
        });
      }

      this.setImages(Array.from(merged.values()));
      bus.showToast(`已捕获 ${this.images.length} 张页面图片`, 'success');
      }
    } catch (e) {
      console.warn('[ImageTab] Scan error:', e);
      bus.showToast('图片扫描受限（该页面不允许脚本注入）', 'error');
    } finally {
      this.isScanning = false;
      this.scanBtn.disabled = false;
      this.scanBtn.innerHTML = `
        <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
        </svg>
        扫描图片
      `;
    }
  }

  getFilteredImages() {
    return this.images.filter(img => {
      const maxDim = Math.max(img.width || 0, img.height || 0);
      if (this.filter === 'large') {
        return maxDim >= 500 || maxDim === 0;
      }
      if (this.filter === 'medium') {
        return maxDim >= 200 || maxDim === 0;
      }
      return true;
    });
  }

  renderGrid() {
    if (!this.gridEl) return;
    const list = this.getFilteredImages();

    if (this.images.length === 0) {
      this.batchBar.classList.add('hidden');
      this.gridEl.innerHTML = `
        <div class="empty-state">
          <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <circle cx="8.5" cy="8.5" r="1.5"></circle>
            <polyline points="21 15 16 10 5 21"></polyline>
          </svg>
          <div class="empty-title">等待扫描页面图片</div>
          <div class="empty-desc">深度提取当前页面中的插图、封面、轮播图与高清大图，支持按分辨率智能过滤与批量下载。</div>
          <button class="action-btn-outline" id="scan-now-empty-btn">
            <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
            </svg>
            立即扫描当前页
          </button>
        </div>
      `;
      this.gridEl.querySelector('#scan-now-empty-btn')?.addEventListener('click', () => {
        this.scanPageImages();
      });
      return;
    }

    this.batchBar.classList.remove('hidden');
    clear(this.gridEl);

    list.forEach(img => {
      const item = this.createImageItem(img);
      this.gridEl.appendChild(item);
    });

    this.updateSelectionUI();
  }

  createImageItem(img) {
    const item = document.createElement('div');
    item.className = 'image-card';
    const isSelected = this.selected.has(img.src);
    if (isSelected) item.classList.add('selected');

    const dimText = (img.width && img.height) ? `${img.width}×${img.height}` : '未知尺寸';

    item.appendChild(el('div', { class: 'image-thumb-wrap' }, [
      el('img', {
        class: 'image-thumb',
        src: img.src,
        loading: 'lazy',
        alt: img.alt || 'img',
        referrerpolicy: 'no-referrer'
      }),
      el('div', { class: 'image-overlay' }, [
        el('label', { class: 'image-checkbox-label' }, [
          el('input', { type: 'checkbox', class: 'image-cb', checked: isSelected })
        ]),
        el('button', { class: 'image-action-btn dl-img-btn', title: '单张下载' }, [icon('download')]),
        el('button', { class: 'image-action-btn copy-img-btn', title: '复制图片链接' }, [icon('copy')])
      ]),
      el('span', { class: 'dim-badge', text: dimText })
    ]));

    const cb = item.querySelector('.image-cb');
    const dlBtn = item.querySelector('.dl-img-btn');
    const copyBtn = item.querySelector('.copy-img-btn');

    cb.addEventListener('change', () => {
      if (cb.checked) {
        this.selected.add(img.src);
        item.classList.add('selected');
      } else {
        this.selected.delete(img.src);
        item.classList.remove('selected');
      }
      this.updateSelectionUI();
    });

    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.downloadSingleImage(img.src);
    });

    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(img.src).then(() => {
        bus.showToast('图片链接已复制', 'success');
      });
    });

    return item;
  }

  updateSelectionUI() {
    const filtered = this.getFilteredImages();
    let count = 0;
    filtered.forEach(img => {
      if (this.selected.has(img.src)) count++;
    });

    this.selectedCountEl.textContent = count;
    this.selectAllCb.checked = filtered.length > 0 && count === filtered.length;
    this.downloadSelectedBtn.disabled = count === 0;
    clear(this.downloadSelectedBtn);
    this.downloadSelectedBtn.appendChild(icon('download'));
    this.downloadSelectedBtn.appendChild(document.createTextNode('下载 (' + count + ')'));
  }

  async downloadSingleImage(url) {
    try {
      const viaExtension = await fetchAndSave(url);
      bus.showToast(viaExtension ? '图片已下载' : '已触发浏览器下载', viaExtension ? 'success' : 'info');
    } catch (e) {
      console.warn('[ImageTab] Download single failed:', e);
      bus.showToast('下载失败，请直接复制直链', 'error');
    }
  }

  async downloadSelectedImages() {
    const targets = Array.from(this.selected);
    if (targets.length === 0) return;

    bus.showToast(`正在批量下载 ${targets.length} 张图片...`, 'info');
    let success = 0;
    for (let i = 0; i < targets.length; i++) {
      try {
        await fetchAndSave(targets[i]);
        success++;
        // Small throttle to prevent browser flood
        await new Promise(r => setTimeout(r, 120));
      } catch (err) {
        console.warn('[ImageTab] download batch error:', err);
      }
    }
    bus.showToast(`批量下载完成 (${success}/${targets.length})`, 'success');
  }
}
