/**
 * media -> 资源图观测 的翻译层（从 background.js 抽出来，为了可测）
 *
 * 抓包路径（webRequest）与页面数据路径（适配器）最终都会产出同样的 media 形状，
 * 这里统一翻译成图能吃的观测，避免两处各写一份、慢慢走样。
 */

/** 单个变体能独立播放的判定要用到的容器集合 */
const MUXED_EXTENSIONS = new Set(['mp4', 'webm', 'mkv', 'mov', 'flv', 'f4v', 'avi', 'wmv', 'ogv', 'm4s', 'ts']);

export function extensionOf(media) {
  return String((media && media.extension) || '').toLowerCase();
}

/**
 * @param {Object} media 抓包/适配器产出的媒体描述
 * @param {number} tabId
 * @param {number} generation 导航代次
 * @returns {Object} ResourceGraph.upsert 需要的观测
 */
export function mediaToObservation(media, tabId, generation) {
  const source = media || {};
  const extension = extensionOf(source);
  const isAudio = Boolean(source.is_audio);
  const quality = Array.isArray(source.qualities) && source.qualities.length > 0 ? source.qualities[0] : null;
  const ownAudioUrl = (quality && quality.audioUrl) || source.audioUrl || '';
  const ownVideoUrl = (quality && quality.videoUrl) || '';
  // 少数来源（例如适配器路径）可能只给了 key 而没给 url，key 本身是规范化 URL 时可以直接用
  const keyAsUrl = typeof source.key === 'string' && source.key.startsWith('http') ? source.key : '';
  const url = source.url || ownVideoUrl || keyAsUrl;

  return {
    key: source.key,
    groupKey: source.group_key || source.groupKey || source.key,
    kind: isAudio ? 'audio' : 'media',
    title: source.title || '',
    site: source.site || '',
    scope: {
      tabId: tabId,
      frameId: Number.isInteger(source.frame_id) ? source.frame_id : 0,
      documentId: source.document_id || '',
      generation: Number.isInteger(source.generation) ? source.generation : generation
    },
    provenance: source.provenance || 'webRequest',
    duration: source.duration == null ? null : source.duration,
    variant: {
      id: source.hash || source.key,
      label: (quality && quality.label) || '',
      url: url,
      videoUrl: isAudio ? '' : (ownVideoUrl || url),
      audioUrl: isAudio ? url : (ownAudioUrl && ownAudioUrl !== url ? ownAudioUrl : ''),
      extension: extension,
      type: source.type || '',
      isAudio: isAudio,
      videoOnly: Boolean(source.video_only),
      width: quality && quality.width != null ? quality.width : null,
      height: quality && quality.height != null ? quality.height : null,
      bitrate: quality && quality.bitrate != null ? quality.bitrate : null,
      sizeBytes: source.size == null ? null : source.size,
      drm: Boolean(source.has_drm),
      headers: source.headers || null,
      container: (quality && quality.container) || ''
    }
  };
}

export function isMuxedContainer(extension) {
  return MUXED_EXTENSIONS.has(String(extension || '').toLowerCase());
}
