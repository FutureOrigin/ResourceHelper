/**
 * offscreen 构建器（P3c）
 *
 * 收到后台派发的构建任务后，调用侧边栏里同一套构建函数（拉流/解密/拼装/合流），
 * 把结果做成 blob URL 交回后台落盘。
 *
 * 为什么不让 offscreen 自己调 chrome.downloads：
 *   offscreen 文档只保留 chrome.runtime 等少数扩展 API，没有 chrome.downloads。
 *   所以这里只负责"构建"，落盘由后台完成（见 docs/OFFSCREEN.md）。
 */

import { MESSAGE } from '../core/offscreen-protocol.js';
import { streamDownloader } from '../sidepanel/modules/stream_downloader.js';
import { dashDownloader } from '../sidepanel/modules/dash_downloader.js';
import { mediaMuxer } from '../sidepanel/modules/media_muxer.js';

/** jobId -> { url } 已创建但还没释放的 blob URL */
const activeUrls = new Map();
/** jobId -> progress 回调（构建函数要求同步回调） */


function report(jobId) {
  // 构建函数要求同步回调，这里直接广播给后台，由后台转给侧边栏
  return (percent, text) => {
    try {
      chrome.runtime.sendMessage({ type: MESSAGE.PROGRESS, jobId: jobId, percent: percent, text: text });
    } catch (e) {}
  };
}

async function runBuild(job) {
  const jobId = job.jobId;
  const onProgress = report(jobId);

  if (job.kind === 'hls') {
    return streamDownloader.buildM3u8Blob(job.payload.url, job.payload.title, onProgress, {
      height: job.payload.height || undefined
    });
  }

  if (job.kind === 'dash') {
    const built = await dashDownloader.buildMpdBlob(job.payload.url, job.payload.title, onProgress, {
      height: job.payload.height || undefined
    });

    // SegmentBase 这类"整文件直链"没有 blob：直接把地址交给后台下载
    if (built && built.kind === 'url') {
      return { blob: null, url: built.url, filename: built.filename, meta: built.meta };
    }
    return built;
  }

  if (job.kind === 'mux') {
    return mediaMuxer.buildMergedBlob(job.payload.url, job.payload.audioUrl, job.payload.title, onProgress);
  }

  throw new Error('不支持的构建类型: ' + job.kind);
}

async function handleJob(job) {
  const jobId = job.jobId;
  try {
    const built = await runBuild(job);

    let blobUrl = '';
    if (built && built.blob) {
      blobUrl = URL.createObjectURL(built.blob);
      activeUrls.set(jobId, blobUrl);
    }

    if (!built || !built.filename) throw new Error('构建结果不完整');

    // blob 交回后台落盘；整文件直链没有 blob，直接把地址交回去
    const message = blobUrl
      ? { type: MESSAGE.READY, jobId: jobId, blobUrl: blobUrl, filename: built.filename, meta: built.meta || {} }
      : { type: MESSAGE.READY, jobId: jobId, directUrl: built.url || '', filename: built.filename, meta: built.meta || {} };

    await chrome.runtime.sendMessage(message);
  } catch (error) {
    try {
      await chrome.runtime.sendMessage({
        type: MESSAGE.RESULT,
        jobId: jobId,
        ok: false,
        error: (error && error.message) || '构建失败'
      });
    } catch (e) {}
  } finally {
    // 任务结束，无需清理额外状态
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === MESSAGE.JOB_START && message.job) {
    handleJob(message.job);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === MESSAGE.RELEASE && message.jobId) {
    const url = activeUrls.get(message.jobId);
    if (url) {
      try { URL.revokeObjectURL(url); } catch (e) {}
      activeUrls.delete(message.jobId);
    }
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

