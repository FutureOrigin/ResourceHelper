/**
 * 下载决策层（纯函数，零依赖，可单测）
 *
 * 为什么单独存在：旧实现把"选哪个资源 / 下哪个 URL / 叫什么名字"写在
 * service worker 的消息分支里，于是出现了两个会静默产出坏文件的行为
 * （AUDIT B5、A5）：
 *   - 找不到目标时"取资源列表里的第一条"，于是下载了错误的视频；
 *   - 音频 Tab 的"提取 MP3"在无独立音轨时回退到视频 URL，再改后缀成 .mp3。
 *
 * 这里把决策收敛成两个纯函数，任何"猜"的行为都必须显式返回错误码，
 * 由 UI 用人话告诉用户原因，而不是给一个坏文件。
 */

import { renderFilenameTemplate } from './settings.js';

export const AUDIO_EXTENSIONS = Object.freeze(['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wav']);
export const VIDEO_EXTENSIONS = Object.freeze(['mp4', 'webm', 'mkv', 'mov', 'flv', 'f4v', 'm4v']);

export const ERROR_CODES = Object.freeze({
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  NO_PLAYABLE_URL: 'NO_PLAYABLE_URL',
  AUDIO_TRACK_UNAVAILABLE: 'AUDIO_TRACK_UNAVAILABLE',
  STREAM_FORMAT_UNSUPPORTED: 'STREAM_FORMAT_UNSUPPORTED',
  DRM_PROTECTED: 'DRM_PROTECTED'
});

const ERROR_MESSAGES = {
  RESOURCE_NOT_FOUND: '该资源已从列表中失效，请刷新页面后重新嗅探',
  NO_PLAYABLE_URL: '该资源没有可下载的地址',
  AUDIO_TRACK_UNAVAILABLE: '该站只暴露了视频轨，没有可无损提取的独立音轨；需要重新封装，将在引擎重构后支持',
  STREAM_FORMAT_UNSUPPORTED: '该流格式暂不支持（例如直播型 DASH 或加密分片）',
  DRM_PROTECTED: '该内容受数字版权保护（DRM），无法下载'
};

export function errorMessage(code) {
  return ERROR_MESSAGES[code] || '未知错误';
}

function fail(code, extra) {
  const result = { ok: false, code: code, message: errorMessage(code) };
  if (extra) Object.assign(result, extra);
  return result;
}

/** 从 URL 路径取扩展名（忽略 query/hash），拿不到返回空串 */
export function extensionFromUrl(url) {
  const text = String(url || '');
  const pathOnly = text.split('#')[0].split('?')[0];
  const match = pathOnly.match(/\.([a-zA-Z0-9]{2,5})$/);
  return match ? match[1].toLowerCase() : '';
}

function pickExtension(candidates, fallback) {
  for (const value of candidates) {
    const ext = String(value || '').toLowerCase().replace(/^\./, '');
    if (ext) return ext;
  }
  return fallback;
}

/**
 * 选中目标资源。
 * 只接受"身份命中"（hash 或 URL 精确匹配），绝不退化成"取第一条"。
 */
export function pickTargetMedia(mediaList, options) {
  const opts = options || {};
  const list = Array.isArray(mediaList) ? mediaList.filter(Boolean) : [];
  if (list.length === 0) return fail(ERROR_CODES.RESOURCE_NOT_FOUND);

  if (opts.mediaKey) {
    const byKey = list.find(function (m) { return m.key === opts.mediaKey; });
    if (byKey) return { ok: true, media: byKey };
  }

  if (opts.mediaHash) {
    const byHash = list.find(function (m) { return m.hash === opts.mediaHash; });
    if (byHash) return { ok: true, media: byHash };
  }

  if (opts.url) {
    const byUrl = list.find(function (m) {
      if (m.url === opts.url) return true;
      if (!Array.isArray(m.qualities)) return false;
      return m.qualities.some(function (q) {
        return Boolean(q) && (q.videoUrl === opts.url || q.audioUrl === opts.url || q.url === opts.url);
      });
    });
    if (byUrl) return { ok: true, media: byUrl };
  }

  return fail(ERROR_CODES.RESOURCE_NOT_FOUND);
}

/** 解析出当前选中的画质项及其视频/音轨地址 */
export function resolveTracks(media, playlistIndex) {
  const qualities = media && Array.isArray(media.qualities) ? media.qualities : [];
  let quality = null;
  if (qualities.length > 0) {
    const index = Number.isInteger(playlistIndex) && playlistIndex >= 0 && playlistIndex < qualities.length
      ? playlistIndex
      : 0;
    quality = qualities[index] || null;
  }
  const videoUrl = (quality && (quality.videoUrl || quality.url)) || (media && media.url) || '';
  const rawAudioUrl = (quality && quality.audioUrl) || (media && media.audioUrl) || '';
  // 音轨地址与视频地址相同，说明这条资源本身就是音画一体的，不存在"独立音轨"
  const audioUrl = rawAudioUrl && rawAudioUrl !== videoUrl ? rawAudioUrl : '';
  return { quality: quality, videoUrl: videoUrl || '', audioUrl: audioUrl };
}

/** 判断一条地址是 HLS / DASH 播放列表还是一个普通文件 */
export function detectStreamKind(media, url) {
  const type = String((media && media.type) || '');
  const target = String(url || '');
  if (/\.m3u8(\?|#|$)/i.test(target) || /m3u8/i.test(type)) return 'hls';
  if (/\.mpd(\?|#|$)/i.test(target) || /mpd/i.test(type)) return 'dash';
  return 'file';
}

/**
 * 生成下载计划。
 * 返回 { ok, mode, url, extension, filename, basename, warnings } 或 { ok:false, code, message }
 * mode: 'direct' 交给 chrome.downloads | 'mux' 音画合流 | 'stream' HLS 分片下载
 */
export function buildDownloadPlan(media, options) {
  const opts = options || {};
  const filenameOptions = { template: opts.filenameTemplate, date: opts.date };
  const playlistIndex = Number.isInteger(opts.playlistIndex) ? opts.playlistIndex : 0;
  const audioOnly = Boolean(opts.audioOnly);
  const audioUrlOverride = typeof opts.audioUrl === 'string' ? opts.audioUrl : '';

  if (!media) return fail(ERROR_CODES.NO_PLAYABLE_URL);
  if (media.has_drm) return fail(ERROR_CODES.DRM_PROTECTED);

  // 音频页已经精确知道要下哪条音轨时，直接用它，不要再猜
  if (audioOnly && audioUrlOverride) {
    return directPlan(media, audioUrlOverride, pickExtension(
      [extensionFromUrl(audioUrlOverride), 'm4a'], 'm4a'
    ), '', [], filenameOptions);
  }

  const tracks = resolveTracks(media, playlistIndex);
  const qualityLabel = tracks.quality && tracks.quality.label ? String(tracks.quality.label) : '';
  const warnings = [];

  if (audioOnly) {
    if (media.is_audio && tracks.videoUrl) {
      return directPlan(media, tracks.videoUrl, pickExtension(
        [extensionFromUrl(tracks.videoUrl), media.extension], 'm4a'
      ), qualityLabel, warnings, filenameOptions);
    }
    if (tracks.audioUrl) {
      return directPlan(media, tracks.audioUrl, pickExtension(
        [extensionFromUrl(tracks.audioUrl), media.extension], 'm4a'
      ), qualityLabel, warnings, filenameOptions);
    }
    // 没有独立音轨：宁可明确拒绝，也不要把视频字节改名成 .mp3
    return fail(ERROR_CODES.AUDIO_TRACK_UNAVAILABLE);
  }

  if (!tracks.videoUrl) return fail(ERROR_CODES.NO_PLAYABLE_URL);

  const kind = detectStreamKind(media, tracks.videoUrl);

  if (kind === 'dash') {
    const plan = {
      ok: true,
      mode: 'dash',
      url: tracks.videoUrl,
      extension: 'mp4',
      qualityLabel: qualityLabel,
      warnings: warnings,
      media: media
    };
    plan.basename = stripExtension(mediaTitle(media));
    plan.filename = buildFilename(media, qualityLabel, 'mp4', filenameOptions);
    return plan;
  }

  if (kind === 'hls') {
    // 注意：HLS 的音轨跟随（#EXT-X-MEDIA）由下载引擎重构阶段补齐；
    // 当前发现层还不会为 m3u8 资源挂独立音轨，所以这里只做警告标记。
    if (tracks.audioUrl) warnings.push('AUDIO_TRACK_IGNORED');
    const plan = {
      ok: true,
      mode: 'stream',
      streamKind: 'hls',
      url: tracks.videoUrl,
      audioUrl: tracks.audioUrl,
      extension: 'mp4',
      qualityLabel: qualityLabel,
      warnings: warnings,
      media: media
    };
    plan.basename = stripExtension(mediaTitle(media));
    plan.filename = buildFilename(media, qualityLabel, 'mp4', filenameOptions);
    return plan;
  }

  if (tracks.audioUrl) {
    // 整文件 MP4 与 fMP4 分片都交给 engine 的 remuxAuto 处理；
    // 若容器里确实没有 moov（例如裸 MP3 音轨），engine 会降级为"仅视频轨"并提示。
    const plan = {
      ok: true,
      mode: 'mux',
      videoUrl: tracks.videoUrl,
      audioUrl: tracks.audioUrl,
      extension: 'mp4',
      qualityLabel: qualityLabel,
      warnings: warnings,
      media: media
    };
    plan.basename = stripExtension(mediaTitle(media));
    plan.filename = buildFilename(media, qualityLabel, 'mp4', filenameOptions);
    return plan;
  }

  return directPlan(media, tracks.videoUrl, pickExtension(
    [extensionFromUrl(tracks.videoUrl), media.extension], 'mp4'
  ), qualityLabel, warnings, filenameOptions);
}

function directPlan(media, url, extension, qualityLabel, warnings, filenameOptions) {
  const ext = pickExtension([extension], 'mp4');
  const plan = {
    ok: true,
    mode: 'direct',
    url: url,
    extension: ext,
    qualityLabel: qualityLabel,
    warnings: Array.isArray(warnings) ? warnings : [],
    media: media
  };
  plan.basename = stripExtension(mediaTitle(media));
  plan.filename = buildFilename(media, qualityLabel, ext, filenameOptions || {});
  return plan;
}

function mediaTitle(media) {
  const title = media && media.title ? String(media.title) : '';
  return title.trim() || 'media';
}

function stripExtension(name) {
  return String(name).replace(/\.[a-zA-Z0-9]{2,5}$/, '');
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 清洗文件名：去掉非法字符与 Windows 保留名，并按 UTF-8 字节数截断
 * （按字符截断会在中文/emoji 上超长或被截成半个字符）。
 */
export function sanitizeFilename(input, maxBytes) {
  const limit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : 120;
  let name = String(input == null ? '' : input)
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!name) name = 'media';
  if (WINDOWS_RESERVED.test(name)) name = '_' + name;

  const encoder = new TextEncoder();
  if (encoder.encode(name).length <= limit) return name;

  let out = '';
  let bytes = 0;
  for (const char of name) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) break;
    out += char;
    bytes += size;
  }
  return out.trim() || 'media';
}

/**
 * 给"直接下载的链接"生成一个可读文件名。
 * 图片/文档这类资源没有站点语义，只能从 URL 取；取不到就用时间戳兜底，
 * 总比让文件名变成 "download (17)" 强。
 */
export function filenameForResource(url, options) {
  const opts = options || {};
  const fallbackExt = pickExtension([opts.extension], 'bin');
  let base = '';
  try {
    const parsed = new URL(url);
    base = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
  } catch (e) {
    base = '';
  }
  if (base) {
    const cleaned = sanitizeFilename(base, 100);
    if (/\.[a-zA-Z0-9]{2,5}$/.test(cleaned)) return cleaned;
    return cleaned + '.' + fallbackExt;
  }
  const stamp = String(opts.timestamp || Date.now()).slice(-8);
  return sanitizeFilename((opts.prefix || 'resource') + '-' + stamp, 100) + '.' + fallbackExt;
}

/**
 * 生成最终文件名。
 * 默认是"标题 + 画质后缀（标题里已有该标签时不重复）"；
 * 设置里配了模板时按模板渲染，但无论哪种方式，扩展名都必须落在最后。
 */
export function buildFilename(media, qualityLabel, extension, options) {
  const opts = options || {};
  const ext = pickExtension([extension], 'mp4');

  if (opts.template) {
    const rendered = renderFilenameTemplate(opts.template, {
      title: mediaTitle(media),
      // 花括号里的画质是"裸标签"，加不加方括号由模板自己决定
      quality: qualityLabel || '',
      ext: ext,
      site: (media && media.site) || '',
      date: opts.date || ''
    });
    let name = sanitizeFilename(rendered, 120) || 'resource';
    if (!/\.[a-zA-Z0-9]{2,5}$/.test(name)) name += '.' + ext;
    return name;
  }

  const base = sanitizeFilename(mediaTitle(media), 100);
  const label = qualityLabel && base.indexOf(qualityLabel) === -1
    ? ' [' + sanitizeFilename(qualityLabel, 24) + ']'
    : '';
  return sanitizeFilename(base + label, 120) + '.' + ext;
}
