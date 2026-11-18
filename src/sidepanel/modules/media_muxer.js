/**
 * 音画合流（侧边栏侧）：并发拉取两条流 → core/remux 采样级合流 → 落盘
 *
 * 历史（AUDIT A1）：这里曾经用"把两个文件拼在一起"的方式合流，
 * moov 变长后 mdat 后移，而 stco 偏移没有重写，输出必然无法播放。
 * 现在真正的重排在 src/core/remux.js，且有字节级单测守着。
 */

import { REMUX_ERRORS, remuxAuto } from '../../core/remux.js';
import { finalizeBlobDownload } from './download_finalize.js';
import { checkMuxBudget, describeBudgetFailure } from '../../core/limits.js';
import { probeResource } from '../../core/probe.js';

/** 探测两轨体积并给出预算判定；探测失败按"未知"放行 */
async function probeSizes(videoUrl, audioUrl) {
  const probeOne = async (url) => {
    try {
      const result = await probeResource(url, { limit: 1 });
      return result && Number.isFinite(result.sizeBytes) ? result.sizeBytes : null;
    } catch (e) {
      return null;
    }
  };
  const [videoBytes, audioBytes] = await Promise.all([probeOne(videoUrl), probeOne(audioUrl)]);
  return { videoBytes, audioBytes };
}

function hostOfUrl(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

function explainRemuxError(error) {
  const code = error && error.code;
  if (code === 'OVER_MUX_BUDGET') {
    return (error && error.message) || '文件过大，已跳过合流';
  }
  if (code === REMUX_ERRORS.FRAGMENTED) {
    return '该视频是分片流（fMP4），当前版本仅支持整文件合流';
  }
  if (code === REMUX_ERRORS.NO_MOOV) {
    return '音轨不是标准 MP4 容器（可能没有 moov），无法无损合流';
  }
  if (code === REMUX_ERRORS.NO_TRAK) {
    return '音轨里没有找到可用的轨道（trak）';
  }
  if (code === REMUX_ERRORS.EMPTY) {
    return '音轨或视频轨拉取结果为空';
  }
  return '合流失败：' + ((error && error.message) || '未知原因');
}

export const mediaMuxer = {
  /** 这条资源是否带着分离的音轨 */
  hasSeparatedStreams(item) {
    if (!item) return false;
    if (item.videoUrl && item.audioUrl && item.videoUrl !== item.audioUrl) return true;
    if (Array.isArray(item.qualities) && item.qualities.length > 0) {
      const quality = item.qualities[0];
      return Boolean(quality && quality.videoUrl && quality.audioUrl && quality.videoUrl !== quality.audioUrl);
    }
    return false;
  },

  /**
   * @param {string} videoUrl
   * @param {string} audioUrl
   * @param {string} title
   * @param {(percent:number, status:string)=>void} onProgress
   * @returns {Promise<number>} chrome.downloads 的 downloadId
   */
  /** 探测两轨体积并判定是否值得合流 */
  async checkBudget(videoUrl, audioUrl) {
    const sizes = await probeSizes(videoUrl, audioUrl);
    return checkMuxBudget(sizes);
  },

  /** 只下视频轨（超预算降级时使用），带字节进度 */
  async fetchStreamOnce(url, onProgress) {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error('拉取视频轨失败 (HTTP ' + response.status + ')');
    const total = Number.parseInt(response.headers.get('content-length') || '', 10);
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (Number.isFinite(total) && total > 0) {
        onProgress(6 + Math.round((received / total) * 85), '正在保存视频轨 (' + Math.round((received / total) * 100) + '%)...');
      }
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  },

  /**
   * 只构建、不落盘：返回 { kind:'blob', blob, filename, meta }。
   * 超预算或合流不可行时，返回"仅视频轨"的构建结果而不是抛错。
   */
  async buildMergedBlob(videoUrl, audioUrl, title, onProgress = () => {}) {
    if (!videoUrl || !audioUrl) throw new Error('缺少视频轨或音频轨地址');

    // 合流必须把两轨完整读进内存。先探一下体积，超预算就降级为"只保存视频轨"，
    // 而不是让标签页在 1.5GB 的视频上被系统杀掉。
    onProgress(3, '正在检查文件体积...');
    const budget = await this.checkBudget(videoUrl, audioUrl);
    if (!budget.ok) {
      onProgress(6, describeBudgetFailure(budget));
      const videoBytes = await this.fetchStreamOnce(videoUrl, onProgress);
      return this.packVideoOnly(videoBytes, title, {
        code: 'OVER_MUX_BUDGET',
        message: describeBudgetFailure(budget)
      });
    }

    onProgress(5, '正在建立音视频双轨并发连接...');

    let vLoaded = 0;
    let vTotal = 1;
    let aLoaded = 0;
    let aTotal = 1;

    const report = () => {
      const combined = Math.min(85, Math.round(5 + ((vLoaded / vTotal + aLoaded / aTotal) / 2) * 80));
      onProgress(combined, '正在并发拉取画质与音轨 (' + combined + '%)...');
    };

    const fetchStream = async (url, isVideo) => {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        throw new Error('拉取' + (isVideo ? '视频轨' : '音频轨') + '失败 (HTTP ' + response.status + ')');
      }
      const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
      if (Number.isFinite(contentLength)) {
        if (isVideo) vTotal = contentLength || 1;
        else aTotal = contentLength || 1;
      }
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        if (isVideo) vLoaded = received;
        else aLoaded = received;
        report();
      }
      const merged = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return merged;
    };

    let videoBytes;
    let audioBytes;
    try {
      [videoBytes, audioBytes] = await Promise.all([
        fetchStream(videoUrl, true),
        fetchStream(audioUrl, false)
      ]);
    } catch (e) {
      throw new Error('音视频轨拉取失败: ' + ((e && e.message) || '网络错误'));
    }

    onProgress(88, '双轨已就绪，正在重写采样偏移并合并容器...');

    let merged;
    try {
      merged = remuxAuto(videoBytes, audioBytes);
    } catch (e) {
      // 容器里没有可合流的轨道（例如裸 MP3 音轨）：降级为"仅视频轨"，
      // 明确告诉用户这一单只有画面，而不是整单失败、也不是产出坏文件。
      if (e && (e.code === REMUX_ERRORS.NO_MOOV || e.code === REMUX_ERRORS.NO_TRAK)) {
        return this.packVideoOnly(videoBytes, title, e);
      }
      throw new Error(explainRemuxError(e));
    }

    onProgress(95, '正在封装为完整 MP4（' + (merged.data.length / 1048576).toFixed(1) + ' MB）...');

    const safeTitle = (title || 'video').replace(/[/\\:*?"<>|]/g, '_').trim().slice(0, 70);
    return {
      kind: 'blob',
      blob: new Blob([merged.data], { type: 'video/mp4' }),
      filename: safeTitle + '.mp4',
      meta: {
        title: title || '',
        url: videoUrl || '',
        audioUrl: audioUrl || '',
        mode: 'mux',
        site: hostOfUrl(videoUrl)
      }
    };
  },

  /** 合流不可行时的兜底：只保存视频轨，并明确标注为无声 */
  packVideoOnly(videoBytes, title, cause) {
    const safeTitle = (title || 'video').replace(/[/\\:*?"<>|]/g, '_').trim().slice(0, 70);
    return {
      kind: 'blob',
      blob: new Blob([videoBytes], { type: 'video/mp4' }),
      filename: safeTitle + ' [仅视频轨].mp4',
      meta: { title: title || '', url: '', mode: 'mux', site: '', warning: explainRemuxError(cause) }
    };
  },

  /** 落盘（侧边栏路径） */
  async mergeAndDownload(videoUrl, audioUrl, title, onProgress = () => {}) {
    const built = await this.buildMergedBlob(videoUrl, audioUrl, title, onProgress);
    onProgress(98, '正在保存至本地磁盘...');
    const downloadId = await finalizeBlobDownload(built);
    onProgress(100, built.meta && built.meta.warning ? '✓ 已保存视频轨（' + built.meta.warning + '）' : '✓ 音画合流完成');
    return downloadId;
  }
};
