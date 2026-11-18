/**
 * 容器魔数嗅探（I5：保真）
 *
 * 问题（AUDIT A6）：旧实现用 URL 后缀猜容器，于是 .m4s 分片被标成 mp4、
 * HEVC 与 fMP4 全都叫 mp4、无后缀的签名 URL 只能靠域名关键词碰运气。
 *
 * 这里用首 1KB 字节做判定，纯函数、可单测；鉴权与网络在 core/probe.js。
 */

const ASCII = (bytes, start, end) => {
  let out = '';
  for (let i = start; i < end && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
};

const ISO_BMFF_BRAND_TO_CONTAINER = {
  isom: 'mp4', iso2: 'mp4', iso4: 'mp4', iso5: 'mp4', iso6: 'mp4',
  mp41: 'mp4', mp42: 'mp4', avc1: 'mp4', dash: 'mp4', msnv: 'mp4',
  'M4V ': 'm4v', 'M4A ': 'm4a', 'M4B ': 'm4a', 'qt  ': 'mov',
  avif: 'avif', avis: 'avif', heic: 'heic', heix: 'heic', mif1: 'heic'
};

const ISO_BMFF_AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'mp4a']);

/**
 * @param {Uint8Array} bytes 至少 16 字节；建议 1024
 * @returns {{kind: string, container: string, detail?: string}|null}
 */
export function sniffBytes(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const head4 = ASCII(bytes, 0, 4);

  // ISO BMFF：ftyp 在第 4 字节
  if (bytes.length >= 12 && ASCII(bytes, 4, 8) === 'ftyp') {
    const brand = ASCII(bytes, 8, 12);
    const container = ISO_BMFF_BRAND_TO_CONTAINER[brand] || 'mp4';
    if (ISO_BMFF_AUDIO_BRANDS.has(brand)) return { kind: 'audio', container: container, detail: brand };
    if (container === 'avif' || container === 'heic') return { kind: 'image', container: container, detail: brand };
    return { kind: 'video', container: container, detail: brand };
  }
  if (bytes.length >= 8 && ASCII(bytes, 4, 8) === 'styp') {
    return { kind: 'video', container: 'fmp4-segment', detail: 'styp' };
  }
  if (bytes.length >= 8 && ASCII(bytes, 4, 8) === 'moof') {
    return { kind: 'video', container: 'fmp4-segment', detail: 'moof' };
  }

  // Matroska / WebM
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const text = ASCII(bytes, 0, Math.min(bytes.length, 64));
    return { kind: 'video', container: text.includes('webm') ? 'webm' : 'mkv', detail: 'ebml' };
  }

  // MPEG-TS：同步字节 0x47，间隔 188。
  // 必须凑够 189 字节才能验证第二个同步字节，否则 'GIF8...' 这种首字节恰好是 0x47
  // 的内容会被误判成 TS（0x47 就是 ASCII 的 'G'）。
  if (bytes.length >= 189 && bytes[0] === 0x47 && bytes[188] === 0x47) {
    return { kind: 'video', container: 'ts', detail: 'mpegts' };
  }

  // 文本型播放列表
  const headText = ASCII(bytes, 0, Math.min(bytes.length, 256));
  if (headText.startsWith('#EXTM3U') || headText.startsWith('\uFEFF#EXTM3U')) {
    return { kind: 'playlist', container: 'm3u8', detail: 'hls' };
  }
  if (headText.includes('<MPD')) {
    return { kind: 'playlist', container: 'mpd', detail: 'dash' };
  }

  // 音频
  if (head4 === 'OggS') {
    const text = ASCII(bytes, 0, Math.min(bytes.length, 256));
    return { kind: 'audio', container: 'ogg', detail: text.includes('OpusHead') ? 'opus' : 'vorbis' };
  }
  if (head4 === 'fLaC') return { kind: 'audio', container: 'flac' };
  if (ASCII(bytes, 0, 3) === 'ID3') return { kind: 'audio', container: 'mp3', detail: 'id3' };
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return { kind: 'audio', container: 'mp3', detail: 'mpeg-audio-sync' };
  }
  if (head4 === 'RIFF' && bytes.length >= 12) {
    const form = ASCII(bytes, 8, 12);
    if (form === 'WAVE') return { kind: 'audio', container: 'wav' };
    if (form === 'WEBP') return { kind: 'image', container: 'webp' };
    if (form === 'AVI ') return { kind: 'video', container: 'avi' };
  }

  // 图片
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: 'image', container: 'jpg' };
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && ASCII(bytes, 1, 4) === 'PNG') {
    return { kind: 'image', container: 'png' };
  }
  if (head4 === 'GIF8') return { kind: 'image', container: 'gif' };
  if (headText.trimStart().startsWith('<svg') || (headText.includes('<?xml') && headText.includes('<svg'))) {
    return { kind: 'image', container: 'svg' };
  }

  // 文档 / 归档
  if (head4 === '%PDF') return { kind: 'document', container: 'pdf' };
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05)) {
    return { kind: 'document', container: 'zip' };
  }
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return { kind: 'document', container: 'exe' };
  if (bytes[0] === 0x7f && ASCII(bytes, 1, 4) === 'ELF') return { kind: 'document', container: 'elf' };

  return null;
}

/** 嗅探结果是否可以当作"可下载的媒体" */
export function isSniffedMedia(sniffed) {
  return Boolean(sniffed) && (sniffed.kind === 'video' || sniffed.kind === 'audio');
}

/** 嗅探出的容器是否直接可作为文件扩展名 */
export function sniffExtension(sniffed) {
  if (!sniffed || !sniffed.container) return '';
  const container = String(sniffed.container);
  if (container === 'fmp4-segment') return 'mp4';
  if (container === 'm3u8') return 'm3u8';
  return container;
}
