/**
 * 合成 MP4 / fMP4 的最小构件（测试专用）
 *
 * 这些构件造出来的文件在结构上自洽：能被 src/core/mp4.js 完整遍历、
 * 能被 remux 正确改写。它们的字节内容没有语义（mdat 就是填充值），
 * 所以只适合验证"结构改写是否正确"，不能验证"解码是否可用"。
 */
import { buildBox } from '../../src/core/mp4.js';

export function findTrun(bytes, moofBox) {
  const full = { type: 'moof', start: moofBox.start, end: moofBox.end, headerSize: 8, size: moofBox.size };
  const traf = childrenOf(bytes, full).find((b) => b.type === 'traf');
  return full && traf ? childOf(bytes, traf, 'trun') : null;
}

// 延迟导入，避免循环（mp4.js 不会反向依赖这里）
import { children as childrenOf, findChild as childOf } from '../../src/core/mp4.js';

export function u32(n) {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

export function box(type, parts) {
  const body = (parts || []).reduce((acc, part) => {
    const bytes = part instanceof Uint8Array ? part : new Uint8Array(0);
    const out = new Uint8Array(acc.length + bytes.length);
    out.set(acc, 0);
    out.set(bytes, acc.length);
    return out;
  }, new Uint8Array(0));
  return buildBox(type, body);
}

export function mvhd(timescale, duration) {
  const payload = new Uint8Array(96);
  payload[0] = 0;
  payload[12] = (timescale >>> 24) & 0xff;
  payload[13] = (timescale >>> 16) & 0xff;
  payload[14] = (timescale >>> 8) & 0xff;
  payload[15] = timescale & 0xff;
  payload.set(u32(duration), 16);
  return buildBox('mvhd', payload);
}

export function tkhd(trackId) {
  const payload = new Uint8Array(76);
  payload[0] = 0;
  payload.set(u32(trackId), 12);
  return buildBox('tkhd', payload);
}

export function stco(offsets) {
  const payload = new Uint8Array(8 + offsets.length * 4);
  payload.set(u32(offsets.length), 4);
  offsets.forEach((value, index) => payload.set(u32(value), 8 + index * 4));
  return buildBox('stco', payload);
}

export function trak(trackId, chunkOffsets) {
  return box('trak', [
    tkhd(trackId),
    box('mdia', [box('minf', [box('stbl', [stco(chunkOffsets)])])])
  ]);
}

export const FTYP = box('ftyp', [new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0])]);
const FTYP_FRAG = box('ftyp', [new Uint8Array([0x69, 0x73, 0x6f, 0x35, 0, 0, 2, 0])]);

/** 造一个"单轨 + 单个 mdat"的 MP4，mdat 数据用 fill 填充 */
export function makeSingleTrackFile(trackId, dataLength, fill, timescale) {
  const mdatData = new Uint8Array(dataLength).fill(fill);
  const mdatBox = buildBox('mdat', mdatData);
  const probeMoov = box('moov', [mvhd(timescale || 1000, 5000), trak(trackId, [0])]);
  const dataOffset = FTYP.length + probeMoov.length + 8;
  const moov = box('moov', [mvhd(timescale || 1000, 4000), trak(trackId, [dataOffset])]);
  const file = new Uint8Array(FTYP.length + moov.length + mdatBox.length);
  file.set(FTYP, 0);
  file.set(moov, FTYP.length);
  file.set(mdatBox, FTYP.length + moov.length);
  return { file, dataOffset, mdatData };
}

export function mfhd(sequence) {
  const payload = new Uint8Array(8);
  payload.set(u32(sequence), 4);
  return buildBox('mfhd', payload);
}

export function tfhd(trackId, flags) {
  const payload = new Uint8Array(8);
  payload.set(u32(trackId), 4);
  const boxed = buildBox('tfhd', payload);
  boxed[9] = (flags >>> 16) & 0xff;
  boxed[10] = (flags >>> 8) & 0xff;
  boxed[11] = flags & 0xff;
  return boxed;
}

export function tfdt(time) {
  const payload = new Uint8Array(8);
  payload.set(u32(time), 4);
  return buildBox('tfdt', payload);
}

export function trun(dataOffset) {
  const payload = new Uint8Array(12);
  payload[3] = 0x01;
  payload.set(u32(1), 4);
  payload.set(u32(dataOffset), 8);
  return buildBox('trun', payload);
}

export function trex(trackId) {
  const payload = new Uint8Array(24);
  payload.set(u32(trackId), 4);
  return buildBox('trex', payload);
}

/** 造一个分片 MP4：ftyp + moov(mvex) + N×(moof + mdat) */
export function makeFragmented(trackId, fragmentCount, fill) {
  const moov = box('moov', [
    mvhd(1000, 0),
    box('trak', [tkhd(trackId), box('mdia', [])]),
    box('mvex', [trex(trackId)])
  ]);

  const fragments = [];
  for (let i = 0; i < fragmentCount; i += 1) {
    const mdat = buildBox('mdat', new Uint8Array(32).fill(fill));
    const probe = box('moof', [mfhd(i + 1), box('traf', [tfhd(trackId, 0x020000), tfdt(1024 * i), trun(0)])]);
    const dataOffset = probe.length + 8;
    const moof = box('moof', [mfhd(i + 1), box('traf', [tfhd(trackId, 0x020000), tfdt(1024 * i), trun(dataOffset)])]);
    fragments.push(moof, mdat);
  }

  const parts = [FTYP_FRAG, moov].concat(fragments);
  const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    file.set(part, offset);
    offset += part.length;
  }
  return file;
}

/** 把 fMP4 拆成"初始化段 + 若干分片"，模拟 MSE 的 appendBuffer 序列 */
export function splitIntoMseChunks(file) {
  const { parseTopLevel, children } = { parseTopLevel: null, children: null };
  const chunks = [];
  let cursor = 0;
  let initEnd = 0;

  // 简单遍历顶层 box：ftyp + moov 属于初始化段，其余每对 (moof, mdat) 是一片
  while (cursor + 8 <= file.length) {
    const size = (file[cursor] << 24 | file[cursor + 1] << 16 | file[cursor + 2] << 8 | file[cursor + 3]) >>> 0;
    if (size < 8 || cursor + size > file.length) break;
    const type = String.fromCharCode(file[cursor + 4], file[cursor + 5], file[cursor + 6], file[cursor + 7]);
    if (type === 'ftyp' || type === 'moov') {
      initEnd = cursor + size;
      cursor += size;
      continue;
    }
    if (initEnd > 0 && chunks.length === 0) chunks.push(file.slice(0, initEnd));
    chunks.push(file.slice(cursor, cursor + size));
    cursor += size;
  }

  if (chunks.length === 0 && initEnd > 0) chunks.push(file.slice(0, initEnd));
  return chunks;
}
