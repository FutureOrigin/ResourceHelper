/**
 * offscreen 文档的生命周期（P3c）
 *
 * 只有"构建"需要它：拉流、解密、拼装、合流需要 DOM（Blob / URL.createObjectURL），
 * 而落盘必须回到有 chrome.downloads 的上下文。见 docs/OFFSCREEN.md。
 *
 * 关键约定：
 *   1. 全局只存在一个 offscreen 文档，任务期间保持存活；
 *   2. 没有任务、也没有未释放的 blob URL 时才关闭；
 *   3. 任何一步失败都返回 false，调用方回退到"侧边栏本地构建"。
 */

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const OFFSCREEN_REASONS = ['BLOBS', 'WORKERS'];
const JUSTIFICATION = '在后台完成用户已经开始的大文件下载，关闭侧边栏也不会中断';

let creating = null;

export function isSupported() {
  return Boolean(chrome.offscreen && typeof chrome.offscreen.createDocument === 'function');
}

async function hasDocument() {
  try {
    if (chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') {
      return await chrome.offscreen.hasDocument();
    }
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
    });
    return Array.isArray(contexts) && contexts.length > 0;
  } catch (e) {
    return false;
  }
}

/** 确保 offscreen 文档存在；不支持或失败时返回 false（调用方回退） */
export async function ensureOffscreen() {
  if (!isSupported()) return false;
  if (await hasDocument()) return true;
  if (creating) return creating;

  creating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: OFFSCREEN_REASONS,
        justification: JUSTIFICATION
      });
      return true;
    } catch (error) {
      // 已经存在（并发创建）也算成功；其它错误一律回退
      if (/single offscreen/i.test(String(error && error.message))) return true;
      return false;
    } finally {
      creating = null;
    }
  })();

  return creating;
}

/** 没有活跃任务时关闭文档，避免常驻一个空页面 */
export async function closeOffscreenIfIdle() {
  if (!isSupported()) return false;
  if (await hasDocument() === false) return true;
  try {
    await chrome.offscreen.closeDocument();
    return true;
  } catch (e) {
    return false;
  }
}
