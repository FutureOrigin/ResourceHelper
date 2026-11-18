/**
 * HLS 播放列表解析（P3d 地基）
 *
 * 现有 stream_downloader.js 是 185 行的手写正则拼接：只看 BANDWIDTH、只认第一个
 * #EXT-X-KEY、忽略 #EXT-X-MEDIA 音轨组与 #EXT-X-BYTERANGE（AUDIT D4）。
 * 这里把解析抽成纯函数，才能被单测覆盖、也才能逐步补齐 RFC 8216 的能力。
 */

/** 按逗号切分属性串，但忽略引号内的逗号（CODECS="avc1.4d401f,mp4a.40.2" 很常见） */
export function splitAttributes(text) {
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === ',' && !inQuotes) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** 解析 KEY=VALUE 属性列表，去掉引号，数字转 number，YES/NO 转 boolean */
export function parseAttributes(text) {
  const out = {};
  for (const part of splitAttributes(String(text || ''))) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim().toUpperCase();
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key === 'DEFAULT' || key === 'AUTOSELECT' || key === 'FORCED') out[key] = value.toUpperCase() === 'YES';
    else if (/^-?\d+$/.test(value)) out[key] = Number.parseInt(value, 10);
    else out[key] = value;
  }
  return out;
}

function absolute(uri, baseUrl) {
  if (!uri) return '';
  try {
    return new URL(uri, baseUrl).href;
  } catch (e) {
    return uri;
  }
}

/** "1920x1080" -> { width, height } */
export function parseResolution(value) {
  const match = String(value || '').match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  return { width: Number.parseInt(match[1], 10), height: Number.parseInt(match[2], 10) };
}

/** "795@0" -> { length: 795, offset: 0 } */
export function parseByteRange(value) {
  const match = String(value || '').match(/^(\d+)(?:@(\d+))?$/);
  if (!match) return null;
  return { length: Number.parseInt(match[1], 10), offset: match[2] == null ? null : Number.parseInt(match[2], 10) };
}

function tagValue(line) {
  const index = line.indexOf(':');
  return index < 0 ? '' : line.slice(index + 1);
}

export function isMasterPlaylist(text) {
  return /#EXT-X-STREAM-INF/i.test(text);
}

export function isMediaPlaylist(text) {
  return /#EXTINF/i.test(text) || /#EXT-X-TARGETDURATION/i.test(text);
}

/**
 * 解析 master playlist。
 * @returns {{variants: Array, audioRenditions: Array, subtitles: Array}}
 */
export function parseMasterPlaylist(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/);
  const variants = [];
  const audioRenditions = [];
  const subtitles = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttributes(tagValue(line));
      // URI 在下一个非注释行
      let uri = '';
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j].trim();
        if (!next) continue;
        if (next.startsWith('#')) break;
        uri = next;
        i = j;
        break;
      }
      variants.push({
        uri: absolute(uri, baseUrl),
        bandwidth: attrs.BANDWIDTH || 0,
        averageBandwidth: attrs['AVERAGE-BANDWIDTH'] || 0,
        codecs: attrs.CODECS || '',
        resolution: parseResolution(attrs.RESOLUTION),
        audioGroup: attrs.AUDIO || '',
        subtitleGroup: attrs.SUBTITLES || '',
        frameRate: attrs['FRAME-RATE'] || 0
      });
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(tagValue(line));
      const entry = {
        type: String(attrs.TYPE || '').toUpperCase(),
        groupId: attrs['GROUP-ID'] || '',
        name: attrs.NAME || '',
        language: attrs.LANGUAGE || '',
        isDefault: attrs.DEFAULT === true,
        autoselect: attrs.AUTOSELECT === true,
        uri: absolute(attrs.URI || '', baseUrl),
        channels: attrs.CHANNELS || ''
      };
      if (entry.type === 'AUDIO') audioRenditions.push(entry);
      else if (entry.type === 'SUBTITLES') subtitles.push(entry);
      continue;
    }
  }

  return { variants: variants, audioRenditions: audioRenditions, subtitles: subtitles };
}

/** 选出最适合下载的那个变体：分辨率优先，其次码率 */
export function pickBestVariant(variants, options) {
  const opts = options || {};
  const list = (variants || []).filter((v) => v && v.uri);
  if (list.length === 0) return null;

  if (Number.isInteger(opts.height) && opts.height > 0) {
    const matched = list.filter((v) => v.resolution && v.resolution.height === opts.height);
    if (matched.length > 0) list.splice(0, list.length, ...matched);
  }

  return list.slice().sort((a, b) => {
    const heightA = a.resolution ? a.resolution.height : 0;
    const heightB = b.resolution ? b.resolution.height : 0;
    if (heightA !== heightB) return heightB - heightA;
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  })[0];
}

/**
 * 解析 media playlist。
 * @returns {{segments: Array, initSegment: Object|null, endList: boolean, mediaSequence: number, targetDuration: number}}
 */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/);
  const segments = [];
  let initSegment = null;
  let endList = false;
  let mediaSequence = 0;
  let targetDuration = 0;

  let pendingDuration = null;
  let pendingByteRange = null;
  let pendingKey = null;
  let pendingDiscontinuity = false;
  let previousRangeEnd = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const value = tagValue(line).split(',')[0];
      pendingDuration = Number.parseFloat(value) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = parseByteRange(tagValue(line));
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(tagValue(line));
      const method = String(attrs.METHOD || '').toUpperCase();
      pendingKey = method === 'NONE'
        ? null
        : {
          method: method,
          uri: absolute(attrs.URI || '', baseUrl),
          iv: attrs.IV || '',
          keyFormat: attrs.KEYFORMAT || 'identity'
        };
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(tagValue(line));
      initSegment = {
        uri: absolute(attrs.URI || '', baseUrl),
        byteRange: attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE) : null,
        key: pendingKey
      };
      continue;
    }
    if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      pendingDiscontinuity = true;
      continue;
    }
    if (line.startsWith('#EXT-X-ENDLIST')) {
      endList = true;
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number.parseInt(tagValue(line), 10) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number.parseFloat(tagValue(line)) || 0;
      continue;
    }
    if (line.startsWith('#')) continue;

    // 媒体分片行
    let byteRange = pendingByteRange;
    if (byteRange && byteRange.offset == null) {
      byteRange = { length: byteRange.length, offset: previousRangeEnd };
    }
    if (byteRange) previousRangeEnd = byteRange.offset + byteRange.length;

    segments.push({
      uri: absolute(line, baseUrl),
      duration: pendingDuration || 0,
      byteRange: byteRange,
      key: pendingKey,
      discontinuity: pendingDiscontinuity,
      sequence: mediaSequence + segments.length
    });

    pendingDuration = null;
    pendingByteRange = null;
    pendingDiscontinuity = false;
  }

  return {
    segments: segments,
    initSegment: initSegment,
    endList: endList,
    mediaSequence: mediaSequence,
    targetDuration: targetDuration
  };
}

/** 播放列表里出现的加密方式是否包含 DRM（这些不能直接下） */
/**
 * 给某个视频变体挑一条音轨。
 *
 * 主播放列表里的音轨是独立播放列表（#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=...），
 * 变体通过 AUDIO 属性引用组；没引用就说明音轨混在视频里。
 *
 * 选择顺序：DEFAULT=YES 且带 URI > 带 URI 的第一条 > 无。
 */
export function pickAudioRendition(master, variant, options) {
  const opts = options || {};
  if (!master || !variant) return null;
  const group = variant.audioGroup || '';
  if (!group) return null;

  const candidates = (master.audioRenditions || [])
    .filter((item) => item && item.groupId === group && item.uri);

  if (candidates.length === 0) return null;

  if (opts.language) {
    const byLang = candidates.find((item) => String(item.language || '').toLowerCase() === String(opts.language).toLowerCase());
    if (byLang) return byLang;
  }

  // 解析器把 DEFAULT=YES 存成 isDefault；兼容手写的 default 字段
  const preferred = candidates.find((item) => item.isDefault === true || item.default === true) || candidates[0];
  return preferred;
}

export function detectDrm(text) {
  const value = String(text || '');
  if (/METHOD\s*=\s*SAMPLE-AES/i.test(value)) return 'SAMPLE-AES';
  if (/METHOD\s*=\s*SAMPLE-AES-CTR/i.test(value)) return 'SAMPLE-AES-CTR';
  if (/com\.apple\.streamingkeydelivery|urn:uuid:edef8ba9|widevine/i.test(value)) return 'WIDEVINE';
  return null;
}

/**
 * 分片 IV：显式 IV 优先，否则按 HLS 规范用 media sequence 的高 8 字节。
 * 这是 AES-128 最容易写错的地方（写反字节序会解出一堆乱码），所以单独可测。
 */
export function ivForSegment(key, sequence) {
  if (key && key.iv) {
    const hex = String(key.iv).replace(/^0x/i, '').padStart(32, '0').slice(-32);
    const iv = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) iv[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return iv;
  }
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, sequence >>> 0);
  return iv;
}

/** 依据分片地址与 init 段判断产物容器，决定扩展名与 MIME */
export function detectContainer(segments, initSegment) {
  const first = (segments && segments[0] && segments[0].uri) || '';
  if (initSegment || /\.(m4s|mp4)(\?|$)/i.test(first)) return 'mp4';
  if (/\.(ts)(\?|$)/i.test(first)) return 'ts';
  return 'ts';
}
