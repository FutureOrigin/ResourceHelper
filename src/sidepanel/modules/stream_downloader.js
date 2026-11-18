/**
 * HLS 下载器：解析 → 并发拉分片 → 解密 → 按序拼装 → 落盘
 *
 * 相比旧实现（185 行手写正则）：
 *   · 解析交给 core/hls.js（支持音轨组、BYTERANGE、密钥状态机、init segment）
 *   · 请求带 credentials，避免需要登录态的 CDN 403（AUDIT D2）
 *   · 分片支持 #EXT-X-BYTERANGE（用 Range 头精确取段）
 *   · AES-128 按分片密钥解密，密钥按 URI 缓存
 *   · 指数退避重试；字节级进度（有 Content-Length 时）
 *
 * 仍未做（已在 ROADMAP 登记）：独立音轨组合并、流式落盘（当前分片仍在内存里拼）。
 */

import {
  detectContainer,
  detectDrm,
  ivForSegment,
  parseMasterPlaylist,
  parseMediaPlaylist,
  pickAudioRendition,
  pickBestVariant
} from '../../core/hls.js';
import { ChunkedBlobSink, OrderedWriter } from '../../core/sink.js';
import { remuxFragmented } from '../../core/remux.js';
import { finalizeBlobDownload } from './download_finalize.js';

const CONCURRENCY = 5;
const MAX_RETRIES = 3;

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

async function fetchText(url) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error('获取播放列表失败 (HTTP ' + response.status + ')');
  return { text: await response.text(), url: response.url || url };
}

async function fetchBuffer(url, options) {
  const opts = options || {};
  let attempt = 0;
  let lastError = null;

  while (attempt <= MAX_RETRIES) {
    try {
      const init = { credentials: 'include' };
      if (opts.range) init.headers = { Range: 'bytes=' + opts.range.offset + '-' + (opts.range.offset + opts.range.length - 1) };
      const response = await fetch(url, init);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return { data: await response.arrayBuffer(), totalBytes: Number.parseInt(response.headers.get('content-length') || '', 10) };
    } catch (e) {
      lastError = e;
      attempt += 1;
      if (attempt > MAX_RETRIES) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 250 * Math.pow(2, attempt))));
    }
  }
  throw new Error('分片拉取失败: ' + ((lastError && lastError.message) || '网络错误'));
}

async function importKey(keyUri, cache) {
  if (cache.has(keyUri)) return cache.get(keyUri);
  const response = await fetch(keyUri, { credentials: 'include' });
  if (!response.ok) throw new Error('获取解密密钥失败 (HTTP ' + response.status + ')');
  const raw = await response.arrayBuffer();
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
  cache.set(keyUri, key);
  return key;
}

/**
 * 把一条播放列表拉成一个完整 Uint8Array（初始化段 + 所有分片，按序）。
 * 只有"要合流"时才会用：合流必须拿到全量字节，无法边下边写。
 */
async function collectTrack(media, onProgress, keyCache, label) {
  const total = media.segments.length;
  const parts = new Array(total);
  let completed = 0;

  if (media.initSegment) {
    const init = await fetchBuffer(media.initSegment.uri, { range: media.initSegment.byteRange });
    parts.init = new Uint8Array(init.data);
  }

  const worker = async (indices) => {
    for (const index of indices) {
      const segment = media.segments[index];
      const fetched = await fetchBuffer(segment.uri, { range: segment.byteRange });
      let data = new Uint8Array(fetched.data);

      if (segment.key && segment.key.method === 'AES-128' && segment.key.uri) {
        const key = await importKey(segment.key.uri, keyCache);
        data = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivForSegment(segment.key, segment.sequence) }, key, data));
      } else if (segment.key && segment.key.method && segment.key.method !== 'NONE') {
        throw new Error('不支持的分片加密方式: ' + segment.key.method);
      }

      parts[index] = data;
      completed += 1;
      if (onProgress) onProgress(label + ' (' + completed + '/' + total + ')...');
    }
  };

  const chunks = Array.from({ length: CONCURRENCY }, () => []);
  for (let i = 0; i < total; i += 1) chunks[i % CONCURRENCY].push(i);
  await Promise.all(chunks.map((list) => worker(list)));

  const buffers = parts.init ? [parts.init] : [];
  for (let i = 0; i < total; i += 1) if (parts[i]) buffers.push(parts[i]);

  let size = 0;
  for (const item of buffers) size += item.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const item of buffers) {
    out.set(item, offset);
    offset += item.length;
  }
  return out;
}

export const streamDownloader = {
  /**
   * 只构建、不落盘：返回 { blob, filename, meta }。
   * 抽出来是为了让构建可以跑在 offscreen（关闭侧边栏也能继续），
   * 而落盘留在有 chrome.downloads 的上下文里。
   *
   * @param {string} m3u8Url
   * @param {string} title
   * @param {(percent:number, status:string)=>void} onProgress
   * @param {{height?: number}} options
   * @returns {Promise<{blob:Blob, filename:string, meta:Object}>}
   */
  async buildM3u8Blob(m3u8Url, title, onProgress = () => {}, options = {}) {
    onProgress(2, '正在解析播放列表...');
    const root = await fetchText(m3u8Url);

    const drm = detectDrm(root.text);
    if (drm) throw new Error('该视频使用 ' + drm + ' 加密（DRM），无法直接下载');

    let mediaUrl = root.url;
    let mediaText = root.text;
    let variantInfo = null;
    let master = null;

    if (parseMasterPlaylist(root.text, root.url).variants.length > 0) {
      master = parseMasterPlaylist(root.text, root.url);
      const best = pickBestVariant(master.variants, { height: options.height });
      if (!best) throw new Error('播放列表里没有可用的清晰度');
      variantInfo = best;
      mediaUrl = best.uri;
      mediaText = (await fetchText(mediaUrl)).text;
    }

    const media = parseMediaPlaylist(mediaText, mediaUrl);
    if (media.segments.length === 0) throw new Error('播放列表里没有可用分片');

    const total = media.segments.length;
    const container = detectContainer(media.segments, media.initSegment);
    const mime = container === 'ts' ? 'video/mp2t' : 'video/mp4';

    // 分块滚动落盘：内存里只留"一个块"，而不是整部影片（AUDIT D1）
    const sink = new ChunkedBlobSink({ mime: mime });
    const writer = new OrderedWriter(sink);
    const keyCache = new Map();

    // 独立音轨组（#EXT-X-MEDIA）+ fMP4：两轨都是分片 MP4 时才能无损合流
    const audioRendition = variantInfo ? pickAudioRendition(master, variantInfo) : null;
    const canMuxAudio = Boolean(audioRendition && audioRendition.uri && container === 'mp4');
    if (canMuxAudio) {
      onProgress(4, '该流含独立音轨组，正在同时拉取画面与音轨...');
      const audioPlaylistUrl = audioRendition.uri;
      const audioRoot = await fetchText(audioPlaylistUrl);
      const audioDrm = detectDrm(audioRoot.text);
      if (audioDrm) throw new Error('音轨使用 ' + audioDrm + ' 加密（DRM），无法合流');

      const audioMedia = parseMediaPlaylist(audioRoot.text, audioRoot.url);
      if (audioMedia.segments.length === 0) throw new Error('音轨播放列表里没有分片');

      const [videoBytes, audioBytes] = await Promise.all([
        collectTrack(media, (text) => onProgress(20, '视频轨 ' + text), keyCache, ''),
        collectTrack(audioMedia, (text) => onProgress(60, '音轨 ' + text), keyCache, '')
      ]);

      onProgress(92, '正在合流画面与独立音轨...');
      let merged;
      try {
        merged = remuxFragmented(videoBytes, audioBytes);
      } catch (e) {
        throw new Error('独立音轨合流失败：' + ((e && e.message) || '未知错误'));
      }

      const muxTitle = (title || 'video').replace(/[\/\\:*?"<>|]/g, '_').trim().slice(0, 70);
      const muxHeight = variantInfo && variantInfo.resolution ? ' [' + variantInfo.resolution.height + 'P]' : '';
      return {
        kind: 'blob',
        blob: new Blob([merged.data], { type: 'video/mp4' }),
        filename: muxTitle + muxHeight + '.mp4',
        meta: { title: title || '', url: m3u8Url, mode: 'stream', site: hostOf(m3u8Url) }
      };
    }

    if (master && variantInfo && variantInfo.audioGroup && !canMuxAudio) {
      onProgress(3, '该流含独立音轨组，但容器是 ' + container + '，暂不能无损合流，只保存视频轨');
    }

    if (media.initSegment) {
      onProgress(5, '正在获取初始化段...');
      const init = await fetchBuffer(media.initSegment.uri, { range: media.initSegment.byteRange });
      sink.add(new Uint8Array(init.data));
    }

    let completed = 0;
    let receivedBytes = 0;
    const report = (status) => {
      const percent = Math.min(94, Math.round(5 + (completed / total) * 89));
      onProgress(percent, status || ('下载分片中 (' + completed + '/' + total + ')...'));
    };

    const worker = async (indices) => {
      for (const index of indices) {
        const segment = media.segments[index];
        const fetched = await fetchBuffer(segment.uri, { range: segment.byteRange });
        let data = new Uint8Array(fetched.data);

        if (segment.key && segment.key.method === 'AES-128' && segment.key.uri) {
          const key = await importKey(segment.key.uri, keyCache);
          const iv = ivForSegment(segment.key, segment.sequence);
          data = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, key, data));
        } else if (segment.key && segment.key.method && segment.key.method !== 'NONE') {
          throw new Error('不支持的分片加密方式: ' + segment.key.method);
        }

        // 乱序完成、按序写入：轮到谁就立刻交给 sink 并释放
        writer.push(index, data);
        completed += 1;
        receivedBytes += data.length;
        report();
      }
    };

    const chunks = Array.from({ length: CONCURRENCY }, () => []);
    for (let i = 0; i < total; i += 1) chunks[i % CONCURRENCY].push(i);
    await Promise.all(chunks.map((list) => worker(list)));

    if (writer.pendingCount > 0) {
      onProgress(96, '等待剩余 ' + writer.pendingCount + ' 个分片按序归位...');
    }
    onProgress(96, '正在封装 ' + total + ' 个分片（' + (receivedBytes / 1048576).toFixed(1) + ' MB）...');

    const blob = writer.finish();

    const safeTitle = (title || 'video').replace(/[\/\\:*?"<>|]/g, '_').trim().slice(0, 70);
    const qualityTag = variantInfo && variantInfo.resolution ? ' [' + variantInfo.resolution.height + 'P]' : '';
    const filename = safeTitle + qualityTag + '.' + container;

    return {
      blob: blob,
      filename: filename,
      meta: { title: title || '', url: m3u8Url, mode: 'stream', site: hostOf(m3u8Url) }
    };
  },

  /** 构建 + 落盘（侧边栏本地路径；offscreen 可用时由它构建、后台落盘） */
  async downloadM3u8(m3u8Url, title, onProgress = () => {}, options = {}) {
    const built = await this.buildM3u8Blob(m3u8Url, title, onProgress, options);
    onProgress(98, '正在保存完整文件...');
    const downloadId = await finalizeBlobDownload(built);
    onProgress(100, '✓ 完整视频下载完成');
    return downloadId;
  }
};
