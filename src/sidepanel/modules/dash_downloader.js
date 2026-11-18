/**
 * DASH 下载器：MPD → 选轨 → 拉取初始化段与分片 → 采样级合流 → 落盘
 *
 * 与 HLS 的区别：DASH 的音视频是两条独立的 Representation，必须分别下完再合流；
 * 合流交给 core/remux.js 的 remuxFragmented（采样级，不重编码）。
 */

import { parseMpd, pickBestRepresentations } from '../../core/dash.js';
import { REMUX_ERRORS, remuxFragmented } from '../../core/remux.js';
import { reportDownloadStarted } from './download_report.js';
import { finalizeBlobDownload } from './download_finalize.js';

const CONCURRENCY = 5;

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

async function fetchBytes(url) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchText(url) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error('获取 MPD 失败 (HTTP ' + response.status + ')');
  return { text: await response.text(), url: response.url || url };
}

/** 按 concurrency 并发拉取一组分片，结果按原顺序返回 */
async function fetchAll(urls, onOne, concurrency) {
  const results = new Array(urls.length);
  let cursor = 0;
  const limit = Math.max(1, concurrency || CONCURRENCY);

  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= urls.length) return;
      results[index] = await fetchBytes(urls[index]);
      if (onOne) onOne(index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, urls.length) }, () => worker()));
  return results;
}

function concatAll(init, parts) {
  let total = init ? init.length : 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  if (init) {
    out.set(init, 0);
    offset = init.length;
  }
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function downloadRepresentation(representation, onProgress) {
  const init = representation.initUrl ? await fetchBytes(representation.initUrl) : null;
  const urls = representation.segments.map((segment) => segment.url);
  const parts = await fetchAll(urls, onProgress, CONCURRENCY);
  return concatAll(init, parts);
}

function explain(error) {
  const code = error && error.code;
  if (code === REMUX_ERRORS.FRAGMENTED) return '分片封装异常，无法合流';
  if (code === REMUX_ERRORS.NO_MOOV) return '该 DASH 流缺少 moov，无法无损合流';
  if (code === REMUX_ERRORS.NO_TRAK) return '该 DASH 流缺少可用轨道';
  return (error && error.message) || '未知错误';
}

export const dashDownloader = {
  /**
   * @param {string} mpdUrl
   * @param {string} title
   * @param {(percent:number, status:string)=>void} onProgress
   * @param {{height?: number}} options
   * @returns {Promise<number>} chrome.downloads 的 downloadId
   */
  async download(mpdUrl, title, onProgress = () => {}, options = {}) {
    const built = await this.buildMpdBlob(mpdUrl, title, onProgress, options);
    return this.dispatch(built, onProgress);
  },

  /**
   * 只构建、不落盘。
   * 返回两种形态：
   *   { kind:'blob', blob, filename, meta }  —— 分片拼装 / 合流的结果
   *   { kind:'url',  url,  filename, meta }  —— SegmentBase 整文件，直接交给浏览器
   */
  async buildMpdBlob(mpdUrl, title, onProgress = () => {}, options = {}) {
    onProgress(2, '正在解析 DASH 清单...');
    const manifest = await fetchText(mpdUrl);
    const parsed = parseMpd(manifest.text, manifest.url);

    if (parsed.isLive) throw new Error('直播型 DASH（dynamic MPD）暂不支持下载');
    const best = pickBestRepresentations(parsed, { height: options.height });
    if (!best.video) throw new Error('DASH 清单里没有可下载的视频轨');

    // SegmentBase：整个 Representation 就是一个带 sidx 的 MP4，直接下这个文件
    if (best.video.segmentBase) {
      return this.buildProgressive(best.video, title, mpdUrl);
    }

    const totalSegments = best.video.segments.length + (best.audio ? best.audio.segments.length : 0);
    let finished = 0;
    const tick = (label) => () => {
      finished += 1;
      const percent = Math.min(90, Math.round(4 + (finished / totalSegments) * 86));
      onProgress(percent, label + ' (' + finished + '/' + totalSegments + ')...');
    };

    onProgress(4, '正在拉取视频轨（' + best.video.segments.length + ' 段）...');
    const video = await downloadRepresentation(best.video, tick('拉取视频轨'));

    if (!best.audio) {
      onProgress(95, '该清单没有独立音轨，仅保存视频轨...');
      return this.pack(new Blob([video], { type: 'video/mp4' }), title, ' [仅视频轨]', mpdUrl);
    }

    onProgress(60, '正在拉取音轨（' + best.audio.segments.length + ' 段）...');
    const audio = await downloadRepresentation(best.audio, tick('拉取音轨'));

    onProgress(92, '正在按采样重排两条轨...');
    let merged;
    try {
      merged = remuxFragmented(video, audio);
    } catch (e) {
      throw new Error('DASH 合流失败：' + explain(e));
    }

    const height = best.video.height ? ' [' + best.video.height + 'P]' : '';
    return this.pack(new Blob([merged.data], { type: 'video/mp4' }), title, height, mpdUrl);
  },

  /** SegmentBase 型 DASH：整文件直接交给浏览器，不产生 blob */
  buildProgressive(representation, title, sourceUrl) {
    const url = representation.fileUrl || representation.baseUrl;
    if (!url) throw new Error('该 DASH 清单没有给出文件地址');
    const height = representation.height ? ' [' + representation.height + 'P]' : '';
    const safeTitle = (title || 'video').replace(/[/\\:*?"<>|]/g, '_').trim().slice(0, 70);
    return {
      kind: 'url',
      url: url,
      filename: safeTitle + height + '.mp4',
      meta: { title: title || '', url: url, mode: 'dash', site: hostOf(sourceUrl || url) }
    };
  },

  /** 把已经拼好的 blob 包装成构建结果（不落盘） */
  pack(blob, title, suffix, sourceUrl) {
    const safeTitle = (title || 'video').replace(/[/\\:*?"<>|]/g, '_').trim().slice(0, 70);
    return {
      kind: 'blob',
      blob: blob,
      filename: safeTitle + (suffix || '') + '.mp4',
      meta: { title: title || '', url: sourceUrl || '', mode: 'dash', site: hostOf(sourceUrl || '') }
    };
  },

  /** 落盘：blob 走统一末端，url 交给浏览器 */
  async dispatch(built, onProgress = () => {}) {
    if (!built) throw new Error('没有可保存的内容');
    if (built.kind === 'url') {
      onProgress(30, '正在下载整文件（SegmentBase）...');
      const downloadId = await chrome.downloads.download({ url: built.url, filename: built.filename, saveAs: false });
      reportDownloadStarted(Object.assign({}, built.meta, {
        id: 'b' + downloadId,
        browserDownloadId: downloadId,
        filename: built.filename
      }));
      onProgress(100, '✓ 已开始下载（SegmentBase 整文件）');
      return downloadId;
    }

    onProgress(98, '正在保存（' + (built.blob.size / 1048576).toFixed(1) + ' MB）...');
    const downloadId = await finalizeBlobDownload({ blob: built.blob, filename: built.filename, meta: built.meta });
    onProgress(100, '✓ DASH 视频下载完成');
    return downloadId;
  }
};
