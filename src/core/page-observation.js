/**
 * 把适配器产出的变体翻译成后台可以直接消费的观测（P4）
 *
 * 适配器只描述"页面里有什么"，这里负责翻译成资源图的输入：
 * 统一 group_key（同一条逻辑媒体的多个变体归到一张卡）、统一变体 id（按 URL 稳定）、
 * 统一标题（标题 + 画质标签）。
 */

import { resourceKey, shortId } from './identity.js';

const AUDIO_CONTAINERS = new Set(['m4a', 'mp3', 'aac', 'opus', 'ogg', 'flac', 'wav', 'weba']);

function guessExtension(variant) {
  if (variant.container) return String(variant.container).toLowerCase();
  const url = String(variant.url || '').split('?')[0];
  const match = url.match(/\.([a-zA-Z0-9]{2,5})$/);
  return match ? match[1].toLowerCase() : (variant.kind === 'audio' ? 'm4a' : 'mp4');
}

/**
 * @param {Object} input
 * @param {string} input.adapterId
 * @param {string} input.mediaId
 * @param {string} input.title
 * @param {Array} input.variants 来自 extractWithAdapter
 * @param {Object} [input.scope] { tabId, frameId, documentId, generation }
 * @param {string} [input.provenance]
 * @returns {Array} media 形状的观测数组
 */
export function variantsToObservations(input) {
  const opts = input || {};
  const variants = Array.isArray(opts.variants) ? opts.variants : [];
  const adapterKey = String(opts.adapterId || 'site');
  const mediaId = opts.mediaId == null ? '' : String(opts.mediaId);
  const observations = [];

  for (const variant of variants) {
    if (!variant || !variant.url) continue;
    const key = resourceKey(variant.url);
    if (!key) continue;

    const extension = guessExtension(variant);
    const isAudio = variant.kind === 'audio' || AUDIO_CONTAINERS.has(extension);
    const label = variant.label || (variant.height ? variant.height + 'P' : (variant.quality != null ? String(variant.quality) : extension.toUpperCase()));

    // 站点适配器给了媒体 id，就把多个变体归到同一张卡；
    // 通用 DOM 适配器没有 id，这时按变体地址各自成卡——一页上放两个不同视频时，
    // 合并成一张卡会让用户选到"另一个视频"的画质。
    const groupKey = adapterKey + ':' + (mediaId || key);

    observations.push({
      key: key,
      hash: shortId(key),
      group_key: groupKey,
      // 标题只放媒体名：画质已经是变体自己的 label，UI 会单独展示。
      // 以前把 label 拼进标题会导致资源卡上出现"某视频 [1080P]"这种重复信息。
      title: opts.title ? String(opts.title) : label,
      type: isAudio ? 'audio' : 'video',
      extension: extension,
      is_audio: isAudio,
      video_only: Boolean(variant.videoOnly),
      size: null,
      duration: opts.duration == null ? null : opts.duration,
      has_drm: Boolean(variant.drm),
      headers: opts.headers || null,
      frame_id: opts.scope ? opts.scope.frameId : 0,
      document_id: opts.scope ? opts.scope.documentId : '',
      provenance: opts.provenance || 'page-json',
      qualities: [{
        index: 0,
        label: label,
        width: variant.width == null ? null : variant.width,
        height: variant.height == null ? null : variant.height,
        bitrate: variant.bitrate == null ? null : variant.bitrate,
        demuxer: extension,
        videoUrl: isAudio ? '' : String(variant.url),
        audioUrl: isAudio ? String(variant.url) : ''
      }]
    });
  }

  return observations;
}
