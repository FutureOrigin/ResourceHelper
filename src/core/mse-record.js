/**
 * MSE 录制（P5 第二步的核心）
 *
 * 背景：blob/MSE 播放器在网络上只暴露分片，播放器把"初始化段 + 媒体段"直接
 * appendBuffer 给 MediaSource。这类站点以前只能提示"抓不到"，现在由页面钩子
 * 把这些字节按轨收集起来，交给这里组装成可播放的文件。
 *
 * 纯逻辑、不碰 chrome API：后台/侧边栏只负责把字节喂进来。
 */

import { REMUX_ERRORS, remuxFragmented } from './remux.js';

export const MSE_RECORD_ERRORS = Object.freeze({
  EMPTY: 'MSE_RECORD_EMPTY',
  NO_DATA: 'MSE_RECORD_NO_DATA'
});

/** 512MB：超过这个量说明用户录的是一整部电影，侧边栏内存扛不住 */
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

const VIDEO_PREFIX = 'video/';
const AUDIO_PREFIX = 'audio/';

function kindOf(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith(VIDEO_PREFIX)) return 'video';
  if (mime.startsWith(AUDIO_PREFIX)) return 'audio';
  return 'other';
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** 首个 box 是不是 ftyp/styp（判断有没有拿到初始化段） */
function startsWithInitSegment(bytes) {
  if (!bytes || bytes.length < 8) return false;
  const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  return type === 'ftyp' || type === 'styp';
}

export class MseRecorder {
  constructor(options) {
    const opts = options || {};
    this.maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES;
    this.tracks = new Map();   // mimeType -> [Uint8Array]
    this.totalBytes = 0;
    this.droppedBytes = 0;
  }

  /**
   * 追加一段数据。
   * @returns {{accepted:boolean, totalBytes:number, reason?:string}}
   */
  add(mimeType, bytes) {
    const key = String(mimeType || 'unknown');
    if (!bytes || bytes.length === 0) return { accepted: false, totalBytes: this.totalBytes, reason: 'EMPTY_CHUNK' };
    if (this.totalBytes + bytes.length > this.maxBytes) {
      this.droppedBytes += bytes.length;
      return { accepted: false, totalBytes: this.totalBytes, reason: 'TOO_LARGE' };
    }
    if (!this.tracks.has(key)) this.tracks.set(key, []);
    this.tracks.get(key).push(bytes);
    this.totalBytes += bytes.length;
    return { accepted: true, totalBytes: this.totalBytes };
  }

  get trackCount() {
    return this.tracks.size;
  }

  /** 按"视频优先、再音频、再其它"的顺序列出轨道 */
  trackList() {
    const order = { video: 0, audio: 1, other: 2 };
    return Array.from(this.tracks.entries())
      .map(([mimeType, chunks]) => ({
        mimeType: mimeType,
        kind: kindOf(mimeType),
        chunks: chunks,
        bytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      }))
      .sort((a, b) => (order[a.kind] - order[b.kind]) || (b.bytes - a.bytes));
  }

  /**
   * 组装成文件。
   * @returns {{mode:'mux'|'single'|'audio', data:Uint8Array, tracks:number, warnings:string[]}}
   */
  assemble() {
    const list = this.trackList();
    if (this.totalBytes === 0 || list.length === 0) {
      const error = new Error('没有录制到任何数据');
      error.code = MSE_RECORD_ERRORS.EMPTY;
      throw error;
    }

    const warnings = [];
    const buffers = list.map((track) => {
      const data = concat(track.chunks);
      if (!startsWithInitSegment(data)) warnings.push('MISSING_INIT');
      return Object.assign({ data }, track);
    });

    const video = buffers.find((item) => item.kind === 'video') || buffers[0];
    const audio = buffers.find((item) => item.kind === 'audio' && item !== video) || null;

    if (!video) {
      const error = new Error('没有可用的轨道');
      error.code = MSE_RECORD_ERRORS.NO_DATA;
      throw error;
    }

    if (!audio) {
      return {
        mode: video.kind === 'audio' ? 'audio' : 'single',
        data: video.data,
        tracks: 1,
        warnings: warnings
      };
    }

    try {
      const merged = remuxFragmented(video.data, audio.data);
      return { mode: 'mux', data: merged.data, tracks: 2, warnings: warnings };
    } catch (e) {
      // 合流失败也要把视频轨交出去，而不是让用户白录
      if (!e || e.code !== REMUX_ERRORS.EMPTY) warnings.push('MUX_FAILED');
      warnings.push(String((e && e.code) || REMUX_ERRORS.NO_MOOV));
      return { mode: 'single', data: video.data, tracks: 1, warnings: warnings };
    }
  }
}

export { startsWithInitSegment, kindOf };
