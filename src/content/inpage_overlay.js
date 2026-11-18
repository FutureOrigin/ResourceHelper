/**
 * ResourceHelper - In-page Video Overlay Download Helper
 * Automatically detects HTML5 <video> elements on pages, attaches floating download capsule.
 */

(function () {
  if (window.__RH_OVERLAY_INITIALIZED__) return;
  window.__RH_OVERLAY_INITIALIZED__ = true;

  const overlayInstances = new Map(); // videoEl -> OverlayInstance
  let pageMediaList = [];
  const activeDownloads = new Map(); // download_id -> OverlayInstance

  // Inject Styles into Shadow DOM for strict style isolation
  const STYLES = `
    :host {
      all: initial;
      /* 固定在视口上：不再要求宿主元素 position:relative，也就不改宿主样式 */
      position: fixed;
      z-index: 2147483647;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.4;
    }

    .rh-overlay-wrap {
      position: absolute;
      top: 14px;
      right: 14px;
      pointer-events: auto;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      opacity: 0;
      transform: translateY(-4px) scale(0.96);
      transition: opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1), transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .rh-overlay-wrap.visible {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    .rh-pill-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: rgba(15, 23, 42, 0.85);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: #f8fafc;
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 9999px;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
      user-select: none;
      transition: all 0.18s ease;
      position: relative;
      overflow: hidden;
      font-weight: 500;
    }

    .rh-pill-btn:hover {
      background: rgba(30, 41, 59, 0.95);
      border-color: rgba(255, 255, 255, 0.35);
      transform: translateY(-1px);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
    }

    .rh-pill-btn:active {
      transform: translateY(0) scale(0.98);
    }

    .rh-logo-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
    }

    .rh-logo-dots {
      display: flex;
      gap: 2px;
      align-items: center;
    }

    .rh-dot {
      width: 4px;
      height: 4px;
      border-radius: 50%;
    }
    .rh-dot-1 { background-color: #3b82f6; }
    .rh-dot-2 { background-color: #eab308; }
    .rh-dot-3 { background-color: #ef4444; }

    .rh-label {
      font-size: 12px;
      letter-spacing: 0.2px;
      white-space: nowrap;
    }

    .rh-badge {
      font-size: 10px;
      padding: 1px 5px;
      background: #0284c7;
      color: #ffffff;
      border-radius: 4px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    .rh-arrow {
      width: 12px;
      height: 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      opacity: 0.7;
      transition: transform 0.2s ease;
    }

    .rh-arrow.open {
      transform: rotate(180deg);
    }

    .rh-dropdown {
      position: absolute;
      top: 100%;
      right: 0;
      margin-top: 8px;
      background: rgba(15, 23, 42, 0.94);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 10px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
      min-width: 220px;
      max-width: 320px;
      max-height: 280px;
      overflow-y: auto;
      display: none;
      flex-direction: column;
      padding: 6px;
      animation: rhFadeDown 0.18s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .rh-dropdown.open {
      display: flex;
    }

    @keyframes rhFadeDown {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .rh-dropdown-header {
      font-size: 11px;
      font-weight: 600;
      color: #94a3b8;
      padding: 6px 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      margin-bottom: 4px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .rh-menu-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 10px;
      border-radius: 6px;
      color: #f1f5f9;
      cursor: pointer;
      font-size: 12px;
      transition: background 0.15s ease;
      gap: 8px;
    }

    .rh-menu-item:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #ffffff;
    }

    .rh-item-left {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .rh-item-title {
      font-weight: 500;
      color: #f8fafc;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .rh-item-sub {
      font-size: 10px;
      color: #94a3b8;
    }

    .rh-item-action {
      background: rgba(2, 132, 199, 0.2);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.3);
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      flex-shrink: 0;
      transition: all 0.15s ease;
    }

    .rh-menu-item:hover .rh-item-action {
      background: #0284c7;
      color: #ffffff;
      border-color: #0284c7;
    }

    .rh-progress-bar {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      background: linear-gradient(90deg, #0284c7, #38bdf8);
      opacity: 0.35;
      transition: width 0.2s ease;
      pointer-events: none;
    }

    .rh-progress-content {
      position: relative;
      z-index: 1;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .rh-status-success {
      background: rgba(16, 185, 129, 0.9) !important;
      border-color: rgba(16, 185, 129, 0.5) !important;
      color: #ffffff !important;
    }

    .rh-status-error {
      background: rgba(239, 68, 68, 0.9) !important;
      border-color: rgba(239, 68, 68, 0.5) !important;
      color: #ffffff !important;
    }
  `;

  // 内容脚本不能 import，这里放最简 DOM 构造器：
  // 标题/画质标签来自站点数据（不可信），必须走 textContent 而不是 innerHTML 插值。
  function mk(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function mkMenuItem(title, subtitle, action) {
    const item = mk("div", "rh-menu-item");
    const left = mk("div", "rh-item-left");
    left.appendChild(mk("div", "rh-item-title", title));
    left.appendChild(mk("div", "rh-item-sub", subtitle));
    item.appendChild(left);
    item.appendChild(mk("div", "rh-item-action", action));
    return item;
  }

  class VideoOverlay {
    constructor(video) {
      this.video = video;
      this.hostEl = document.createElement("div");
      this.hostEl.className = "rh-inpage-overlay-root";

      this.shadow = this.hostEl.attachShadow({ mode: "open" });

      const styleTag = document.createElement("style");
      styleTag.textContent = STYLES;
      this.shadow.appendChild(styleTag);

      this.wrap = document.createElement("div");
      this.wrap.className = "rh-overlay-wrap";

      this.btn = document.createElement("div");
      this.btn.className = "rh-pill-btn";
      this.btn.innerHTML = `
        <div class="rh-progress-bar" style="width: 0%;"></div>
        <div class="rh-progress-content">
          <span class="rh-logo-icon">
            <span class="rh-logo-dots">
              <span class="rh-dot rh-dot-1"></span>
              <span class="rh-dot rh-dot-2"></span>
              <span class="rh-dot rh-dot-3"></span>
            </span>
          </span>
          <span class="rh-label">资源嗅探下载</span>
          <span class="rh-badge" style="display:none;">1080P</span>
          <span class="rh-arrow">
            <svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </span>
        </div>
      `;

      this.progressBar = this.btn.querySelector(".rh-progress-bar");
      this.label = this.btn.querySelector(".rh-label");
      this.badge = this.btn.querySelector(".rh-badge");
      this.arrow = this.btn.querySelector(".rh-arrow");

      this.dropdown = document.createElement("div");
      this.dropdown.className = "rh-dropdown";

      this.wrap.appendChild(this.btn);
      this.wrap.appendChild(this.dropdown);
      this.shadow.appendChild(this.wrap);

      this.isMenuOpen = false;
      this.hideTimer = null;
      this.currentMedia = null;
      this.downloadId = null;

      this.bindEvents();
      this.mount();
    }

    mount() {
      try {
        (document.body || document.documentElement).appendChild(this.hostEl);
        this.updatePosition();
        return true;
      } catch (err) {
        console.warn("[ResourceHelper Overlay] mount failed:", err);
        return false;
      }
    }

    /** 用视口坐标定位（fixed），滚动/缩放时由全局 rAF 调度统一刷新 */
    updatePosition() {
      if (!this.video || !this.hostEl) return;
      const rect = this.video.getBoundingClientRect();
      const offScreen = rect.bottom <= 0
        || rect.top >= window.innerHeight
        || rect.right <= 0
        || rect.left >= window.innerWidth
        || rect.width < 120
        || rect.height < 90;

      if (offScreen) {
        this.hostEl.style.display = "none";
        return;
      }

      this.hostEl.style.display = "";
      this.hostEl.style.top = `${rect.top}px`;
      this.hostEl.style.left = `${rect.left}px`;
      this.hostEl.style.width = `${rect.width}px`;
      this.hostEl.style.height = `${rect.height}px`;
    }

    bindEvents() {
      const showOverlay = () => {
        clearTimeout(this.hideTimer);
        this.updatePosition();
        this.wrap.classList.add("visible");
      };

      const scheduleHideOverlay = () => {
        if (this.isMenuOpen) return;
        this.hideTimer = setTimeout(() => {
          this.wrap.classList.remove("visible");
        }, 1200);
      };

      this.video.addEventListener("mouseenter", showOverlay);
      this.video.addEventListener("mousemove", showOverlay);
      this.video.addEventListener("mouseleave", scheduleHideOverlay);

      this.wrap.addEventListener("mouseenter", () => {
        clearTimeout(this.hideTimer);
        this.wrap.classList.add("visible");
      });

      this.wrap.addEventListener("mouseleave", scheduleHideOverlay);

      this.btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.isMenuOpen) {
          this.closeDropdown();
        } else {
          this.openDropdown();
        }
      });

      // 点击外部关闭、窗口缩放/滚动刷新位置都改为模块级单例监听，
      // 不再每个视频各挂一份（AUDIT C6，无限滚动页面会把监听器堆到几千个）
    }

    openDropdown() {
      this.isMenuOpen = true;
      this.arrow.classList.add("open");
      this.renderDropdownItems();
      this.dropdown.classList.add("open");
    }

    closeDropdown() {
      this.isMenuOpen = false;
      this.arrow.classList.remove("open");
      this.dropdown.classList.remove("open");
    }

    updateState() {
      const matched = findBestMediaForVideo(this.video, pageMediaList);
      this.currentMedia = matched;

      if (!matched) {
        this.badge.style.display = "none";
        this.label.textContent = "资源嗅探下载";
        return;
      }

      let bestQualityLabel = null;
      if (matched.qualities && matched.qualities.length > 0) {
        const first = matched.qualities[0];
        if (first.height) {
          bestQualityLabel = `${first.height}P`;
        } else if (first.demuxer) {
          bestQualityLabel = first.demuxer.toUpperCase();
        }
      }

      if (bestQualityLabel) {
        this.badge.textContent = bestQualityLabel;
        this.badge.style.display = "inline-block";
        this.label.textContent = "下载本视频";
      } else {
        this.badge.style.display = "none";
        this.label.textContent = "下载本视频";
      }
    }

    renderDropdownItems() {
      this.dropdown.innerHTML = "";

      const matched = this.currentMedia || findBestMediaForVideo(this.video, pageMediaList);
      if (!matched) {
        const empty = document.createElement("div");
        empty.style.padding = "12px";
        empty.style.textAlign = "center";
        empty.style.color = "#94a3b8";
        empty.style.fontSize = "12px";
        empty.textContent = "正在等待视频播放嗅探流...";
        this.dropdown.appendChild(empty);
        return;
      }

      const header = mk("div", "rh-dropdown-header");
      header.appendChild(mk("span", null, "选择下载画质"));
      header.appendChild(mk("span", null, (matched.qualities ? matched.qualities.length : 1) + " 个流"));
      this.dropdown.appendChild(header);

      if (matched.qualities && matched.qualities.length > 0) {
        matched.qualities.forEach((q, idx) => {
          const label = q.label || (q.height ? q.height + "P" : "原画");
          const meta = (q.demuxer || "mp4").toUpperCase()
            + (q.bitrate ? " · " + formatBitrate(q.bitrate) : "")
            + (q.audioUrl ? " · 音画合流" : "");
          const item = mkMenuItem(label, meta, "下载");
          item.addEventListener("click", () => {
            this.startDownload(matched, idx, false);
            this.closeDropdown();
          });
          this.dropdown.appendChild(item);
        });
      } else {
        const item = mkMenuItem("默认原画流", "标准 MP4 / 流媒体切片", "下载");
        item.addEventListener("click", () => {
          this.startDownload(matched, 0, false);
          this.closeDropdown();
        });
        this.dropdown.appendChild(item);
      }

      const audioItem = mkMenuItem("🎵 提取独立音频", "原生音轨 / 无损", "音频");
      audioItem.style.borderTop = "1px solid rgba(255, 255, 255, 0.08)";
      audioItem.style.marginTop = "4px";
      audioItem.style.paddingTop = "8px";
      audioItem.addEventListener("click", () => {
        this.startDownload(matched, 0, true);
        this.closeDropdown();
      });
      this.dropdown.appendChild(audioItem);
    }

    startDownload(media, playlistIndex, audioOnly) {
      if (!media || !(media.key || media.hash)) return;

      this.label.textContent = audioOnly ? "准备音频..." : "准备下载...";
      this.progressBar.style.width = "10%";
      this.badge.style.display = "none";

      chrome.runtime.sendMessage({
        type: "RH_DOWNLOAD",
        media_key: media.key,
        media_hash: media.hash,
        playlist_index: playlistIndex,
        audio_only: audioOnly
      }, (response) => {
        if (!response || !response.success) {
          this.showError(response ? response.error : "调度失败");
          return;
        }

        this.downloadId = response.download_id;
        activeDownloads.set(response.download_id, this);
        if (response.is_m3u8) {
          this.label.textContent = "侧边栏拼装中...";
          this.progressBar.style.width = "15%";
        } else {
          this.label.textContent = "0%";
          this.progressBar.style.width = "5%";
        }
      });
    }

    destroy() {
      try {
        clearTimeout(this.hideTimer);
        if (videoObserver) videoObserver.unobserve(this.video);
        if (this.hostEl && this.hostEl.parentElement) {
          this.hostEl.parentElement.removeChild(this.hostEl);
        }
      } catch (e) {}
    }

    onProgress(progress) {
      if (!progress) return;
      if (progress.status === "downloading" || typeof progress.percent === "number") {
        const pct = Math.max(0, Math.min(100, Math.round(progress.percent)));
        this.progressBar.style.width = `${pct}%`;
        this.label.textContent = `${pct}%`;
      } else if (progress.status === "completed") {
        this.onComplete();
      } else if (progress.status === "error") {
        this.showError(progress.error || "下载失败");
      }
    }

    onComplete() {
      this.progressBar.style.width = "100%";
      this.label.textContent = "✓ 已完成";
      this.btn.classList.add("rh-status-success");

      setTimeout(() => {
        this.progressBar.style.width = "0%";
        this.btn.classList.remove("rh-status-success");
        this.updateState();
      }, 3500);
    }

    showError(msg) {
      this.progressBar.style.width = "0%";
      this.label.textContent = "✕ 失败";
      this.btn.classList.add("rh-status-error");

      setTimeout(() => {
        this.btn.classList.remove("rh-status-error");
        this.updateState();
      }, 3500);
    }
  }

  function formatBitrate(bps) {
    if (!bps) return "";
    if (bps >= 1000000) return `${(bps / 1000000).toFixed(1)} Mbps`;
    if (bps >= 1000) return `${Math.round(bps / 1000)} Kbps`;
    return `${bps} bps`;
  }

  function findBestMediaForVideo(videoEl, mediaList) {
    if (!videoEl || !mediaList || mediaList.length === 0) return null;

    const currentSrc = videoEl.currentSrc || videoEl.src || "";
    if (currentSrc) {
      for (const media of mediaList) {
        if (media.url === currentSrc) return media;
        if (media.qualities && media.qualities.some(q => q.videoUrl === currentSrc || q.url === currentSrc)) {
          return media;
        }
      }
    }

    for (const media of mediaList) {
      if (media.type === "video" || media.demuxer === "mp4" || media.url?.includes(".m3u8")) {
        return media;
      }
    }

    return mediaList[0] || null;
  }

  function scanAndMountVideos() {
    // 1. 清理已离开文档的实例
    for (const [videoEl, instance] of overlayInstances.entries()) {
      if (!document.contains(videoEl)) {
        instance.destroy();
        overlayInstances.delete(videoEl);
        if (videoObserver) videoObserver.unobserve(videoEl);
      }
    }

    // 2. 新出现的视频先交给 IntersectionObserver：只有进入视口才真的挂载内核
    const videos = document.querySelectorAll("video");
    videos.forEach((video) => {
      try {
        if (overlayInstances.has(video)) {
          overlayInstances.get(video).updatePosition();
          return;
        }
        const rect = video.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 90) return;

        const observerRef = ensureObserver();
        if (observerRef) observerRef.observe(video);
        else mountOverlayFor(video);   // 老内核没有 IntersectionObserver：直接挂
      } catch (e) {
        console.warn("[ResourceHelper Overlay] scan video error:", e);
      }
    });
  }

  function updateAllInstances() {
    overlayInstances.forEach((inst) => {
      if (document.contains(inst.video)) {
        inst.updateState();
      }
    });
  }

  /** 增量：按身份合并一条资源，避免每次发现都全量重取 */
  function upsertPageMedia(media) {
    if (!media) return;
    const index = pageMediaList.findIndex((item) => item.key === media.key || (item.hash && item.hash === media.hash));
    if (index >= 0) pageMediaList[index] = media;
    else pageMediaList.push(media);
    updateAllInstances();
  }

  function refreshMediaFromBackground() {
    chrome.runtime.sendMessage({ type: "RH_GET_MEDIA" }, (response) => {
      if (chrome.runtime.lastError || !response || !response.success) return;
      pageMediaList = response.media || [];
      updateAllInstances();
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;

    if (msg.type === "RH_MEDIA_UPSERTED") {
      upsertPageMedia(msg.media);
    } else if (msg.type === "RH_MEDIA_DETECTED") {
      refreshMediaFromBackground();
    } else if (msg.type === "RH_DOWNLOAD_PROGRESS") {
      const instance = activeDownloads.get(msg.download_id);
      if (instance) {
        instance.onProgress(msg.progress);
        if (msg.progress && msg.progress.percent >= 100) {
          instance.onComplete();
          activeDownloads.delete(msg.download_id);
        }
      }
    } else if (msg.type === "RH_DOWNLOAD_COMPLETE") {
      const instance = activeDownloads.get(msg.download_id);
      if (instance) {
        instance.onComplete();
        activeDownloads.delete(msg.download_id);
      }
    }
  });

  // ---- 全局单例监听（C6）：无论页面上有多少视频，只挂这一份 ----

  let positionRaf = null;
  function schedulePositionUpdate() {
    if (positionRaf) return;
    positionRaf = requestAnimationFrame(() => {
      positionRaf = null;
      overlayInstances.forEach((instance) => instance.updatePosition());
    });
  }

  // 捕获阶段处理，避免被站点自己的 stopPropagation 吃掉
  document.addEventListener("click", (event) => {
    overlayInstances.forEach((instance) => {
      if (!instance.isMenuOpen) return;
      // 阴影树内的点击会被重定向到宿主元素，这里用 hostEl 判断即可
      if (!instance.hostEl.contains(event.target)) instance.closeDropdown();
    });
  }, true);

  window.addEventListener("resize", schedulePositionUpdate, { passive: true });
  window.addEventListener("scroll", schedulePositionUpdate, { passive: true, capture: true });

  let videoObserver = null;
  function ensureObserver() {
    if (videoObserver || typeof IntersectionObserver === "undefined") return videoObserver;
    videoObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const video = entry.target;
        if (!document.contains(video)) {
          if (videoObserver) videoObserver.unobserve(video);
          return;
        }
        if (entry.isIntersecting) mountOverlayFor(video);
        else {
          const instance = overlayInstances.get(video);
          if (instance && instance.hostEl) instance.hostEl.style.display = "none";
        }
      });
    }, { threshold: 0, rootMargin: "120px" });
    return videoObserver;
  }

  function mountOverlayFor(video) {
    const existing = overlayInstances.get(video);
    if (existing) {
      existing.updatePosition();
      return;
    }
    try {
      overlayInstances.set(video, new VideoOverlay(video));
    } catch (e) {
      console.warn("[ResourceHelper Overlay] mount video error:", e);
    }
  }

  let debounceScanTimer = null;
  const observer = new MutationObserver(() => {
    if (debounceScanTimer) clearTimeout(debounceScanTimer);
    debounceScanTimer = setTimeout(scanAndMountVideos, 300);
  });
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });

  scanAndMountVideos();
  refreshMediaFromBackground();

  console.log("[ResourceHelper] In-page Video Overlay Download Helper mounted.");
})();
