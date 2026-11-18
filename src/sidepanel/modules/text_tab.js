import { bus } from './bus.js';
import { decodeExtractedText, describeDecodeFailure, discoverFontInTab, pushCopyMap } from './font_text_decode.js';
import { collectPrivateUse } from '../../core/font-deobfuscate.js';

export class TextTab {
  constructor() {
    this.container = null;
    this.badge = null;
    this.activeTabId = null;
    this.extractedContent = '';
    this.extractedTitle = '';
    this.isUnlocked = false;
  }

  init(containerEl, badgeEl) {
    this.container = containerEl;
    this.badge = badgeEl;
    this.renderLayout();
  }

  renderLayout() {
    this.container.innerHTML = `
      <div class="text-panel-wrap">
        <div class="unlock-banner" id="unlock-status-box">
          <div class="banner-status-dot"></div>
          <div class="banner-text">
            <strong id="banner-title">网页防复制防护检测中</strong>
            <span id="banner-desc">不可选中 / 禁止右键 → 点【一键解禁】；复制出来缺字、方框 → 那是字体加密，点【提取纯净正文】</span>
          </div>
        </div>

        <div class="text-action-group">
          <button class="action-btn unlock-btn" id="force-unlock-btn">
            <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
            </svg>
            一键解禁复制与右键
          </button>
          <button class="action-btn-secondary" id="extract-reader-btn">
            <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
            </svg>
            提取纯净正文
          </button>
        </div>

        <div class="text-output-section">
          <div class="output-header">
            <span class="output-title">正文预览与编辑</span>
            <span class="output-stats" id="text-stats">0 字</span>
            <div class="spacer"></div>
            <button class="icon-tool-btn" id="copy-text-btn" title="一键复制全部文本">
              <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              复制全文
            </button>
            <button class="icon-tool-btn" id="export-md-btn" title="导出为 Markdown">
              <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              导出 MD
            </button>
          </div>
          <textarea class="text-editor" id="extracted-textarea" placeholder="点击上方【提取纯净正文】自动抓取文章段落，或在此直接粘贴编辑..."></textarea>
        </div>
      </div>
    `;

    this.statusBox = this.container.querySelector('#unlock-status-box');
    this.bannerTitle = this.container.querySelector('#banner-title');
    this.bannerDesc = this.container.querySelector('#banner-desc');
    this.unlockBtn = this.container.querySelector('#force-unlock-btn');
    this.extractBtn = this.container.querySelector('#extract-reader-btn');
    this.textarea = this.container.querySelector('#extracted-textarea');
    this.statsEl = this.container.querySelector('#text-stats');
    this.copyBtn = this.container.querySelector('#copy-text-btn');
    this.exportBtn = this.container.querySelector('#export-md-btn');

    this.unlockBtn.addEventListener('click', () => {
      this.executeForceUnlock();
    });

    this.extractBtn.addEventListener('click', () => {
      this.extractCleanContent();
    });

    this.copyBtn.addEventListener('click', () => {
      const text = this.textarea.value;
      if (!text) {
        bus.showToast('暂无内容可复制', 'info');
        return;
      }
      navigator.clipboard.writeText(text).then(() => {
        bus.showToast('正文已成功复制到剪贴板', 'success');
      });
    });

    this.exportBtn.addEventListener('click', () => {
      this.exportMarkdownFile();
    });

    this.textarea.addEventListener('input', () => {
      this.updateStats();
    });
  }

  setActiveTab(tabId) {
    this.activeTabId = tabId;
    this.isUnlocked = false;
    if (this.statusBox) {
      this.statusBox.classList.remove('unlocked');
      this.bannerTitle.textContent = '网页防复制防护检测中';
      this.bannerDesc.textContent = '不可选中 / 禁止右键 → 点【一键解禁】；复制出来缺字、方框 → 那是字体加密，点【提取纯净正文】';
    }
  }

  async executeForceUnlock() {
    if (!this.activeTabId) return;

    // 浏览器内部页面无法注入脚本，提前提示而不是抛异常
    if (!(await bus.canInject(this.activeTabId))) {
      bus.showToast('当前页面为浏览器内部页面，无法解除限制', 'error');
      return;
    }

    try {
      let resp = await bus.sendToTab(this.activeTabId, { type: "SNIFFER_UNLOCK_TEXT" });
      if (!resp || !resp.success) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: this.activeTabId, allFrames: true },
            files: ["content/text_unlocker.js"]
          });
          resp = await bus.sendToTab(this.activeTabId, { type: "SNIFFER_UNLOCK_TEXT" });
        } catch (injErr) {
          console.warn("[TextTab] Unlock injection fallback:", injErr);
        }
      }

      if (!resp || !resp.success) {
      await chrome.scripting.executeScript({
        target: { tabId: this.activeTabId, allFrames: true },
        // 必须进主世界：window/document 上的复制拦截只存在于页面自己的 JS 环境里，
        // 隔离世界赋值只影响自己那份 window（AUDIT F5）。
        world: "MAIN",
        func: () => {
          // 1. Force style override for selection
          const styleId = '__sniffer_unlock_style__';
          let style = document.getElementById(styleId);
          if (!style) {
            style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
              *, html, body, div, p, span, article, section, pre, code {
                -webkit-user-select: text !important;
                -moz-user-select: text !important;
                -ms-user-select: text !important;
                user-select: text !important;
                pointer-events: auto !important;
              }
              ::selection {
                background-color: rgba(56, 189, 248, 0.4) !important;
                color: inherit !important;
              }
            `;
            (document.head || document.documentElement).appendChild(style);
          }

          // 2. Kill and swallow all defensive events
          const blockerEvents = [
            'copy', 'cut', 'contextmenu', 'selectstart', 'selectionchange',
            'dragstart', 'beforecopy'
          ];
          blockerEvents.forEach(evtName => {
            window.addEventListener(evtName, (e) => {
              e.stopImmediatePropagation();
            }, true);
            document.addEventListener(evtName, (e) => {
              e.stopImmediatePropagation();
            }, true);
          });

          // 3. Nullify document inline handlers
          ['oncopy', 'oncut', 'oncontextmenu', 'onselectstart', 'ondragstart'].forEach(prop => {
            try {
              document[prop] = null;
              if (document.body) document.body[prop] = null;
              window[prop] = null;
            } catch (e) {}
          });

          return true;
        }
      });
      }

      this.isUnlocked = true;
      this.statusBox.classList.add('unlocked');
      this.bannerTitle.textContent = '网页限制已解除！';
      this.bannerDesc.textContent = '现在您可以在该网页任意划选文字、按 Ctrl+C 复制并随意右键。';
      bus.showToast('已强制解除页面所有防复制限制', 'success');
      void this.prepareCopyMap();
    } catch (e) {
      console.warn('[TextTab] Unlock error:', e);
      bus.showToast('当前页面不支持注入脚本', 'error');
    }
  }

  async extractCleanContent() {
    if (!this.activeTabId) return;

    // 浏览器内部页面无法注入脚本，提前提示而不是抛异常
    if (!(await bus.canInject(this.activeTabId))) {
      bus.showToast('当前页面为浏览器内部页面，无法提取正文', 'error');
      return;
    }

    this.extractBtn.disabled = true;
    this.extractBtn.innerHTML = `
      <span class="spinner"></span>
      提取中...
    `;

    try {
      // V2 才带私用区统计与字体线索；老标签页里还是旧内容脚本时，先就地升级
      let resp = await bus.sendToTab(this.activeTabId, { type: 'SNIFFER_EXTRACT_CONTENT_V2' });
      if (!resp || !resp.success) {
        await this.upgradeContentScript();
        resp = await bus.sendToTab(this.activeTabId, { type: 'SNIFFER_EXTRACT_CONTENT_V2' });
      }
      if (!resp || !resp.success) {
        // 升不上去（受限页面 / 注入被拒）就退回老接口，字体线索改由侧边栏自己找
        resp = await bus.sendToTab(this.activeTabId, { type: 'SNIFFER_EXTRACT_CONTENT' });
      }

      if (resp && resp.success && resp.content) {
        this.extractedTitle = resp.title || "提取文章";
        const decoded = await this.applyFontDecode(resp, this.activeTabId);
        this.extractedContent = decoded.content;
        this.textarea.value = `# ${this.extractedTitle}\n\n${this.extractedContent}`;
        this.updateStats();
        if (decoded.ok) {
          this.statusBox.classList.add('unlocked');
          this.bannerTitle.textContent = '正文已还原字体加密';
          this.bannerDesc.textContent = decoded.note + '；页面里的 Ctrl+C 也已同步修正。';
          bus.showToast("正文智能提取完成 · " + decoded.note, "success", 3200);
        } else if (decoded.note) {
          bus.showToast("正文已提取，但" + decoded.note, "error", 4200);
        } else {
          bus.showToast("正文智能提取完成", "success");
        }
      } else {
      const results = await chrome.scripting.executeScript({
        target: { tabId: this.activeTabId },
        func: () => {
          const pageTitle = document.title || '提取文章';

          // Find likely article container
          const candidates = document.querySelectorAll('article, [class*="article"], [class*="content"], [class*="post"], main, .entry-content');
          let targetEl = null;
          let maxLen = 0;

          candidates.forEach(el => {
            const len = el.innerText ? el.innerText.length : 0;
            if (len > maxLen) {
              maxLen = len;
              targetEl = el;
            }
          });

          if (!targetEl || maxLen < 200) {
            targetEl = document.body;
          }

          // Extract semantic paragraphs and headings
          const blocks = [];
          targetEl.querySelectorAll('h1, h2, h3, h4, p, pre, blockquote, li').forEach(node => {
            // Ignore invisible elements or nav/ad segments
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return;
            if (node.closest('nav, footer, header, aside, .comment, .sidebar')) return;

            const text = node.innerText.trim();
            if (!text) return;

            const tag = node.tagName.toLowerCase();
            if (tag === 'h1') blocks.push(`# ${text}\n`);
            else if (tag === 'h2') blocks.push(`## ${text}\n`);
            else if (tag === 'h3') blocks.push(`### ${text}\n`);
            else if (tag === 'pre') blocks.push(`\`\`\`\n${text}\n\`\`\`\n`);
            else if (tag === 'blockquote') blocks.push(`> ${text}\n`);
            else if (tag === 'li') blocks.push(`- ${text}`);
            else blocks.push(`${text}\n`);
          });

          return {
            title: pageTitle,
            content: blocks.join('\n')
          };
        }
      });

      if (results && results[0] && results[0].result) {
        const { title, content } = results[0].result;
        this.extractedTitle = title;
        this.extractedContent = content;
        this.textarea.value = `# ${title}\n\n${content}`;
        this.updateStats();
        bus.showToast('正文智能提取完成', 'success');
      }
      }
    } catch (e) {
      console.warn('[TextTab] Extract content failed:', e);
      bus.showToast('正文提取受限', 'error');
    } finally {
      this.extractBtn.disabled = false;
      this.extractBtn.innerHTML = `
        <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
        </svg>
        提取纯净正文
      `;
    }
  }

  /** 就地升级页面里的内容脚本（扩展刚更新、标签页还是旧脚本时用） */
  async upgradeContentScript() {
    if (!(await bus.canInject(this.activeTabId))) return false;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: this.activeTabId, allFrames: true },
        files: ['content/text_unlocker.js']
      });
      return true;
    } catch (err) {
      console.warn('[TextTab] content script upgrade failed:', err);
      return false;
    }
  }

  /**
   * 私用区码位（字体反爬）还原：提取结果里带 pua 统计与字体线索，
   * 这里做真正的换字，并把映射推回页面，让页面内复制也正常。
   */
  async applyFontDecode(resp, tabId) {
    const content = resp.content || '';
    // 私用区统计在侧边栏本地也能算：内容脚本没给（旧版本）就用本地结果
    const localPua = collectPrivateUse(content);
    const puaTotal = (resp.pua && resp.pua.total) || localPua.total;
    if (!puaTotal) return { content, ok: false, note: '' };

    let font = resp.font || null;
    if (!font) font = await discoverFontInTab(tabId);

    let result;
    try {
      result = await decodeExtractedText({ content, font });
    } catch (err) {
      return { content, ok: false, note: '字体解码失败：' + ((err && err.message) || err) };
    }

    // 页面里的内容脚本还是旧版（扩展刚升级、标签页没刷新）时，把话说清楚，
    // 否则用户看到的只是"点完还是乱码"，无从判断问题在哪
    const stale = resp.unlockerVersion === undefined ? '；页面里的脚本还是旧版本，请刷新本页再试' : '';

    if (!result.changed) {
      return {
        content,
        ok: false,
        note: '正文含 ' + puaTotal + ' 个字体加密字符，未能还原（' + describeDecodeFailure(result.reason) + '）' + stale
      };
    }

    const pushed = await pushCopyMap(tabId, result.mapping);
    return {
      content: result.text,
      ok: true,
      note: '已还原字体加密文字 ' + result.matched + '/' + puaTotal + ' 处'
        + (result.family ? '（字体 ' + result.family + '）' : '')
        + (pushed ? '' : '；页面内 Ctrl+C 未同步，请刷新本页再试' + stale)
    };
  }

  /** 解禁后顺手把复制修好：页面上 Ctrl+C 拿到的就是真字 */
  async prepareCopyMap() {
    if (!this.activeTabId) return;
    try {
      const resp = await bus.sendToTab(this.activeTabId, { type: 'SNIFFER_EXTRACT_CONTENT' });
      if (!resp || !resp.success || !resp.pua || !resp.pua.total) return;
      const decoded = await decodeExtractedText({ content: resp.content || '', font: resp.font || null });
      if (!decoded.changed) return;
      const pushed = await pushCopyMap(this.activeTabId, decoded.mapping);
      if (pushed) {
        this.bannerDesc.textContent = '复制已修正：本页 Ctrl+C 得到的是正常文字（已还原 ' + decoded.matched + ' 处）。';
      }
    } catch (err) {
      console.warn('[TextTab] prepareCopyMap failed:', err);
    }
  }

  updateStats() {
    const text = this.textarea.value || '';
    const charCount = text.length;
    this.statsEl.textContent = `${charCount} 字`;
    if (this.badge) {
      this.badge.textContent = charCount > 0 ? `${Math.round(charCount / 100) / 10}k` : '';
    }
  }

  exportMarkdownFile() {
    const text = this.textarea.value;
    if (!text) {
      bus.showToast('暂无内容可导出', 'info');
      return;
    }
    const safeTitle = (this.extractedTitle || 'extracted_article')
      .replace(/[\/\\:*?"<>|]/g, '_')
      .slice(0, 50);
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeTitle}.md`;
    a.click();
    URL.revokeObjectURL(url);
    bus.showToast('已导出 Markdown 文件', 'success');
  }
}
