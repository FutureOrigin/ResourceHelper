/**
 * 音画合流（P3）：把两条"单轨 MP4"合成一条"双轨 MP4"
 *
 * 这是 AUDIT A1 的正解。旧实现把视频 moov 与音频 trak 拼在一起就完事，
 * 但 moov 变长会让 mdat 后移，而 stco/co64 里的采样偏移没有重写：
 * 探针实测视频轨偏移差 112 字节、音频轨差 1144 字节，输出必然无法播放。
 *
 * 本实现只在**字节层面重排并重写偏移**，不做任何重编码：
 *   ftyp + moov(video trak + audio trak) + video mdat(s) + audio mdat(s)
 * 两个来源的 chunk 偏移分别重定位到新位置，track_id 冲突时重新编号。
 */

import {
  buildBox,
  children,
  concatBytes,
  findChild,
  getTrackId,
  groupFragments,
  listBoxes,
  listTrex,
  parseTopLevel,
  payloadRange,
  readChunkOffsets,
  readFullBoxHeader,
  readMovieHeader,
  readUint32,
  readUint64,
  setTrackId,
  setTfhdTrackId,
  setTrexTrackId,
  shiftChunkOffsets,
  writeMfhdSequence,
  writeMovieDuration,
  writeUint32,
  findMvex
} from './mp4.js';

export const REMUX_ERRORS = Object.freeze({
  NO_MOOV: 'NO_MOOV',
  NO_TRAK: 'NO_TRAK',
  FRAGMENTED: 'FRAGMENTED_UNSUPPORTED',
  NO_FRAGMENTS: 'NO_FRAGMENTS',
  EMPTY: 'EMPTY_INPUT'
});

export class RemuxError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'RemuxError';
    this.code = code;
  }
}

/** 把一个"只含单个 box"的缓冲区当成 box 处理：子 box 从 8 字节处开始 */
function asBox(bytes, type) {
  return { type: type || 'root', start: 0, end: bytes.length, headerSize: 8, size: bytes.length };
}

function slice(bytes, start, end) {
  return bytes.slice(start, end);
}

function defaultFtyp() {
  // 最小可用的 ftyp：isom + iso2 + mp41
  return buildBox('ftyp', new Uint8Array([
    0x69, 0x73, 0x6f, 0x6d,             // major_brand 'isom'
    0x00, 0x00, 0x02, 0x00,             // minor_version 512
    0x69, 0x73, 0x6f, 0x32,             // compatible 'iso2'
    0x6d, 0x70, 0x34, 0x31              // compatible 'mp41'
  ]));
}

function isFragmented(parsed) {
  return Boolean(parsed.hasFragments);
}

/** 收集"载荷 box"（mdat 等），用于计算新偏移 */
function payloadBoxes(parsed) {
  return parsed.boxes.filter((box) => box.type !== 'ftyp' && box.type !== 'moov');
}

function totalSize(boxes) {
  let total = 0;
  for (const box of boxes) total += box.size;
  return total;
}

/**
 * @param {Uint8Array} videoBytes 单轨（视频）MP4
 * @param {Uint8Array} audioBytes 单轨（音频）MP4
 * @returns {{data: Uint8Array, stats: Object}}
 */
export function remuxProgressive(videoBytes, audioBytes) {
  if (!videoBytes || !audioBytes || videoBytes.length === 0 || audioBytes.length === 0) {
    throw new RemuxError(REMUX_ERRORS.EMPTY, '输入为空');
  }

  const video = parseTopLevel(videoBytes);
  const audio = parseTopLevel(audioBytes);
  if (!video.moov || !audio.moov) throw new RemuxError(REMUX_ERRORS.NO_MOOV, '缺少 moov');
  if (isFragmented(video) || isFragmented(audio)) {
    throw new RemuxError(REMUX_ERRORS.FRAGMENTED, '分片 MP4 请走 remuxFragmented');
  }

  const videoTrak = children(videoBytes, video.moov, 'trak')[0];
  const audioTrak = children(audioBytes, audio.moov, 'trak')[0];
  if (!videoTrak || !audioTrak) throw new RemuxError(REMUX_ERRORS.NO_TRAK, '缺少 trak');

  // ---- 1. 复制并修正音频 trak 的 chunk 偏移 -----------------------------
  const audioTrakBytes = slice(audioBytes, audioTrak.start, audioTrak.end);
  const audioPayload = payloadBoxes(audio);
  if (audioPayload.length === 0) throw new RemuxError(REMUX_ERRORS.NO_MOOV, '音频没有 mdat');

  const ftyp = video.ftyp ? slice(videoBytes, video.ftyp.start, video.ftyp.end) : defaultFtyp();
  const videoPayload = payloadBoxes(video);
  if (videoPayload.length === 0) throw new RemuxError(REMUX_ERRORS.NO_MOOV, '视频没有 mdat');

  const newMoovSize = video.moov.size + audioTrakBytes.length;
  const videoPayloadStart = ftyp.length + newMoovSize;
  const audioPayloadStart = videoPayloadStart + totalSize(videoPayload);

  // 音频 chunk 偏移原本相对"音频文件开头"，现在整体搬到 audioPayloadStart
  const audioDelta = audioPayloadStart - audioPayload[0].start;
  const audioTrakBox = asBox(audioTrakBytes, 'trak');
  const audioTable = shiftChunkOffsets(audioTrakBytes, audioTrakBox, audioDelta);

  // ---- 2. 复制并修正视频 moov 里 trak 的 chunk 偏移 ---------------------
  const videoMoovBytes = slice(videoBytes, video.moov.start, video.moov.end);
  const videoMoovBox = asBox(videoMoovBytes, 'moov');
  const videoTrakInCopy = children(videoMoovBytes, videoMoovBox, 'trak')[0];
  // 视频 moov 之后多出 audioTrak，视频 mdat 整体后移 audioTrakBytes.length
  shiftChunkOffsets(videoMoovBytes, videoTrakInCopy, audioTrakBytes.length);

  // ---- 3. 组装新 moov：video moov（改大小）+ audio trak ----------------
  const newMoov = new Uint8Array(newMoovSize);
  newMoov.set(videoMoovBytes, 0);
  newMoov.set(audioTrakBytes, videoMoovBytes.length);
  // moov 的 size 字段（前 4 字节）
  const view = new DataView(newMoov.buffer);
  view.setUint32(0, newMoovSize);

  // track_id 去冲突
  const videoTrackId = readTrackIdSafe(videoMoovBytes, videoTrakInCopy);
  const audioTrakInNew = { type: 'trak', start: videoMoovBytes.length, end: newMoovSize, headerSize: 8, size: audioTrakBytes.length };
  let audioTrackId = readTrackIdSafe(newMoov, audioTrakInNew);
  if (videoTrackId != null && audioTrackId != null && audioTrackId === videoTrackId) {
    audioTrackId = videoTrackId + 1;
    setTrackId(newMoov, audioTrakInNew, audioTrackId);
  }

  // moov 时长取两者较长者（统一用视频 mvhd 的 timescale）
  const videoHeader = readMovieHeader(videoMoovBytes, videoMoovBox);
  const audioHeader = readMovieHeader(audioBytes, audio.moov);
  if (videoHeader && audioHeader) {
    const audioDurationInVideoScale = audioHeader.timescale
      ? Math.round(audioHeader.duration * (videoHeader.timescale / audioHeader.timescale))
      : 0;
    const merged = Math.max(videoHeader.duration, audioDurationInVideoScale);
    if (merged > videoHeader.duration) writeMovieDuration(newMoov, videoHeader, merged);
  }

  // ---- 4. 输出：ftyp + newMoov + video 载荷 + audio 载荷 ---------------
  const parts = [ftyp, newMoov];
  for (const box of videoPayload) parts.push(slice(videoBytes, box.start, box.end));
  for (const box of audioPayload) parts.push(slice(audioBytes, box.start, box.end));

  const data = concatBytes(parts);
  return {
    data: data,
    stats: {
      videoTrackId: videoTrackId,
      audioTrackId: audioTrackId,
      videoChunks: readChunkOffsets(videoMoovBytes, videoTrakInCopy)?.count ?? 0,
      audioChunks: audioTable ? audioTable.count : 0,
      audioDelta: audioDelta,
      videoDelta: audioTrakBytes.length,
      bytes: data.length
    }
  };
}

function readTrackIdSafe(bytes, trakBox) {
  try {
    const tkhd = findChild(bytes, trakBox, 'tkhd');
    if (!tkhd) return null;
    const version = bytes[tkhd.start + 8];
    const offset = tkhd.start + (version === 1 ? 28 : 20);
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  } catch (e) {
    return null;
  }
}

/** 供上层判断：这对输入适不适合走本函数 */
export function canRemuxProgressive(videoBytes, audioBytes) {
  try {
    const video = parseTopLevel(videoBytes);
    const audio = parseTopLevel(audioBytes);
    return Boolean(video.moov && audio.moov && !video.hasFragments && !audio.hasFragments);
  } catch (e) {
    return false;
  }
}

export { listBoxes, payloadRange };

/* ------------------------------------------------------------------ *
 * 分片 MP4（fMP4）合流
 *
 * 场景：B 站 / YouTube 的 DASH 轨是 ftyp + moov(mvex) + [moof + mdat]*。
 * 不能像整文件那样"拼 moov 再拼 mdat"，必须：
 *   · 合成一个含两条 trak 与两条 trex 的 moov
 *   · 把两边的片段按序交错，并重编 mfhd 序列号
 *   · track_id 冲突时重编音频侧（trak / trex / tfhd 三处）
 *   · trun 的 data_offset 是相对 moof 起点的，保持"moof+mdat 连续且顺序不变"即仍有效
 * ------------------------------------------------------------------ */

function copyRange(bytes, from, to) {
  return bytes.slice(from, to);
}

/** 把一个片段组（moof + 其后的 mdat）复制出来并改写序号/轨道号 */
function cloneFragmentGroup(sourceBytes, group, options) {
  const moofBytes = copyRange(sourceBytes, group.moof.start, group.moof.end);
  const moofBox = { type: 'moof', start: 0, end: moofBytes.length, headerSize: 8, size: moofBytes.length };
  const inner = children(moofBytes, moofBox);

  const mfhd = inner.find((box) => box.type === 'mfhd');
  if (mfhd) writeMfhdSequence(moofBytes, mfhd, options.sequence);

  for (const traf of inner.filter((box) => box.type === 'traf')) {
    const tfhd = findChild(moofBytes, traf, 'tfhd');
    if (tfhd && options.renumberTrackId != null) setTfhdTrackId(moofBytes, tfhd, options.renumberTrackId);
    if (tfhd && options.baseDataOffsetDelta) {
      const flags = readFullBoxHeader(moofBytes, tfhd).flags;
      if ((flags & 0x000001) !== 0) {
        // base-data-offset 是绝对文件偏移：片段搬家后必须平移
        const at = tfhd.start + 16;
        const value = readUint64(moofBytes, at) + options.baseDataOffsetDelta;
        writeUint32(moofBytes, at, Math.floor(value / 4294967296));
        writeUint32(moofBytes, at + 4, value % 4294967296);
      }
    }
  }

  const mdatBytes = group.mdat.map((box) => copyRange(sourceBytes, box.start, box.end));
  return concatBytes([moofBytes].concat(mdatBytes));
}

/**
 * @param {Uint8Array} videoBytes
 * @param {Uint8Array} audioBytes
 * @returns {{data: Uint8Array, stats: Object}}
 */
export function remuxFragmented(videoBytes, audioBytes) {
  if (!videoBytes || !audioBytes || videoBytes.length === 0 || audioBytes.length === 0) {
    throw new RemuxError(REMUX_ERRORS.EMPTY, '输入为空');
  }
  const video = parseTopLevel(videoBytes);
  const audio = parseTopLevel(audioBytes);
  if (!video.moov || !audio.moov) throw new RemuxError(REMUX_ERRORS.NO_MOOV, '缺少 moov');

  const videoGroups = groupFragments(videoBytes).fragments;
  const audioGroups = groupFragments(audioBytes).fragments;
  if (videoGroups.length === 0 && audioGroups.length === 0) {
    throw new RemuxError(REMUX_ERRORS.NO_FRAGMENTS, '没有分片，应该走整文件合流');
  }

  const videoTrak = children(videoBytes, video.moov, 'trak')[0];
  const audioTrak = children(audioBytes, audio.moov, 'trak')[0];
  if (!videoTrak || !audioTrak) throw new RemuxError(REMUX_ERRORS.NO_TRAK, '缺少 trak');

  const videoTrackId = getTrackId(videoBytes, videoTrak);
  const audioTrackId = getTrackId(audioBytes, audioTrak);
  const renumber = videoTrackId != null && audioTrackId != null && videoTrackId === audioTrackId;
  const newAudioTrackId = renumber ? videoTrackId + 1 : audioTrackId;

  // ---- 音频 trak 复制（必要时改 track_id）----
  const audioTrakBytes = copyRange(audioBytes, audioTrak.start, audioTrak.end);
  if (renumber) setTrackId(audioTrakBytes, asBox(audioTrakBytes, 'trak'), newAudioTrackId);

  // ---- 合成 moov ----
  const moovParts = [];
  for (const child of children(videoBytes, video.moov)) {
    if (child.type === 'mvex') continue;
    moovParts.push(copyRange(videoBytes, child.start, child.end));
  }
  moovParts.push(audioTrakBytes);

  const mvexParts = [];
  const videoMvex = findMvex(videoBytes, video.moov);
  if (videoMvex) {
    for (const child of children(videoBytes, videoMvex)) {
      if (child.type === 'trex' || child.type === 'mehd') {
        mvexParts.push(copyRange(videoBytes, child.start, child.end));
      }
    }
  }
  const audioMvex = findMvex(audioBytes, audio.moov);
  if (audioMvex) {
    for (const trex of listTrex(audioBytes, audioMvex)) {
      const trexBytes = copyRange(audioBytes, trex.start, trex.end);
      if (renumber) setTrexTrackId(trexBytes, asBox(trexBytes, 'trex'), newAudioTrackId);
      mvexParts.push(trexBytes);
    }
  }
  if (mvexParts.length > 0) moovParts.push(buildBox('mvex', concatBytes(mvexParts)));

  const ftyp = video.ftyp ? copyRange(videoBytes, video.ftyp.start, video.ftyp.end) : defaultFtyp();
  const newMoov = buildBox('moov', concatBytes(moovParts));

  // ---- 交错片段 ----
  const parts = [ftyp, newMoov];
  let outputLength = ftyp.length + newMoov.length;
  let sequence = 1;
  const total = Math.max(videoGroups.length, audioGroups.length);

  for (let index = 0; index < total; index += 1) {
    const videoGroup = videoGroups[index];
    if (videoGroup) {
      const bytes = cloneFragmentGroup(videoBytes, videoGroup, {
        sequence: sequence++,
        renumberTrackId: null,
        baseDataOffsetDelta: outputLength - videoGroup.moof.start
      });
      parts.push(bytes);
      outputLength += bytes.length;
    }
    const audioGroup = audioGroups[index];
    if (audioGroup) {
      const bytes = cloneFragmentGroup(audioBytes, audioGroup, {
        sequence: sequence++,
        renumberTrackId: renumber ? newAudioTrackId : null,
        baseDataOffsetDelta: outputLength - audioGroup.moof.start
      });
      parts.push(bytes);
      outputLength += bytes.length;
    }
  }

  const data = concatBytes(parts);
  return {
    data: data,
    stats: {
      videoTrackId: videoTrackId,
      audioTrackId: renumber ? newAudioTrackId : audioTrackId,
      videoFragments: videoGroups.length,
      audioFragments: audioGroups.length,
      sequences: sequence - 1,
      bytes: data.length
    }
  };
}

/**
 * 自动选路：只要任一输入带 moof 分片就走分片合流，否则走整文件合流。
 * 上层不用关心容器形态。
 */
export function remuxAuto(videoBytes, audioBytes) {
  const hasFragments = (bytes) => {
    try {
      return parseTopLevel(bytes).hasFragments;
    } catch (e) {
      return false;
    }
  };
  const fragmented = hasFragments(videoBytes) || hasFragments(audioBytes);
  return fragmented ? remuxFragmented(videoBytes, audioBytes) : remuxProgressive(videoBytes, audioBytes);
}

/** 供上层判断：这对输入是否是可直接交错的 fMP4 */
export function canRemuxFragmented(videoBytes, audioBytes) {
  try {
    const video = parseTopLevel(videoBytes);
    const audio = parseTopLevel(audioBytes);
    if (!video.moov || !audio.moov) return false;
    const vGroups = groupFragments(videoBytes).fragments.length;
    const aGroups = groupFragments(audioBytes).fragments.length;
    return vGroups + aGroups > 0;
  } catch (e) {
    return false;
  }
}