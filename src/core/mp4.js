/**
 * ISO BMFF（MP4）底层读写（P3 地基）
 *
 * 为什么自己写：现有「合流」直接把两个文件的 moov 拼起来、塞进另一条 trak，
 * 却没有重写 stco/co64 采样偏移（AUDIT A1，探针实测偏移差 112/1144 字节）。
 * 修复它必须能真正读写 box 树，而不是"把字节拼在一起"。
 *
 * 这里只做最基础的、可被单测覆盖的操作：遍历、查找、读写 stco/co64、tkhd、mvhd。
 */

const ascii = (bytes, start, end) => {
  let out = '';
  for (let i = start; i < end && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
};

export function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

export function writeUint32(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

export function readUint64(bytes, offset) {
  return readUint32(bytes, offset) * 4294967296 + readUint32(bytes, offset + 4);
}

/** 读一个 box 头；返回 { type, size, headerSize, start, end } 或 null */
export function readBoxHeader(bytes, offset, limit) {
  const max = limit == null ? bytes.length : limit;
  if (offset + 8 > max) return null;
  let size = readUint32(bytes, offset);
  const type = ascii(bytes, offset + 4, offset + 8);
  let headerSize = 8;

  if (size === 1) {
    if (offset + 16 > max) return null;
    size = readUint64(bytes, offset + 8);
    headerSize = 16;
  } else if (size === 0) {
    size = max - offset;
  }

  if (size < headerSize || offset + size > max) return null;
  return { type: type, size: size, headerSize: headerSize, start: offset, end: offset + size };
}

/** 遍历 [start, end) 内的同级 box（不递归） */
export function listBoxes(bytes, start, end) {
  const out = [];
  let offset = start == null ? 0 : start;
  const limit = end == null ? bytes.length : end;
  while (offset + 8 <= limit) {
    const box = readBoxHeader(bytes, offset, limit);
    if (!box) break;
    out.push(box);
    if (box.size <= 0) break;
    offset = box.end;
  }
  return out;
}

/** 取 box 的负载区间（跳过 header） */
export function payloadRange(box) {
  return [box.start + box.headerSize, box.end];
}

/** 按类型找第一个子 box */
export function findChild(bytes, box, type) {
  const [from, to] = payloadRange(box);
  return listBoxes(bytes, from, to).find((child) => child.type === type) || null;
}

/** 按路径查找，例如 ['moov','trak','mdia','minf','stbl','stco'] */
export function findPath(bytes, path, rootStart, rootEnd) {
  let boxes = listBoxes(bytes, rootStart, rootEnd);
  let current = null;
  for (const type of path) {
    current = boxes.find((box) => box.type === type) || null;
    if (!current) return null;
    const [from, to] = payloadRange(current);
    boxes = listBoxes(bytes, from, to);
  }
  return current;
}

/** 找出容器 box 下所有直接子 box（按类型过滤） */
export function children(bytes, box, type) {
  const [from, to] = payloadRange(box);
  return listBoxes(bytes, from, to).filter((child) => !type || child.type === type);
}

/** tkhd 里的 track_ID（v0 在 +20，v1 在 +28，相对 box 起点） */
export function getTrackId(bytes, trakBox) {
  const tkhd = findChild(bytes, trakBox, 'tkhd');
  if (!tkhd) return null;
  const version = bytes[tkhd.start + 8];
  const offset = tkhd.start + (version === 1 ? 28 : 20);
  return readUint32(bytes, offset);
}

export function setTrackId(bytes, trakBox, id) {
  const tkhd = findChild(bytes, trakBox, 'tkhd');
  if (!tkhd) return false;
  const version = bytes[tkhd.start + 8];
  const offset = tkhd.start + (version === 1 ? 28 : 20);
  writeUint32(bytes, offset, id);
  return true;
}

/** 读 stco/co64 的 chunk 偏移表（返回的是相对整个文件的绝对偏移） */
export function readChunkOffsets(bytes, trakBox) {
  const stbl = findChild(bytes, trakBox, 'mdia');
  if (!stbl) return null;
  const stco = findPath(bytes, ['mdia', 'minf', 'stbl', 'stco'], trakBox.start + trakBox.headerSize, trakBox.end)
    || findPath(bytes, ['mdia', 'minf', 'stbl', 'co64'], trakBox.start + trakBox.headerSize, trakBox.end);
  if (!stco) return null;

  const is64 = stco.type === 'co64';
  const count = readUint32(bytes, stco.start + 12);
  const base = stco.start + 16;
  const values = [];
  for (let i = 0; i < count; i += 1) {
    values.push(is64 ? readUint64(bytes, base + i * 8) : readUint32(bytes, base + i * 4));
  }
  return { type: stco.type, boxStart: stco.start, count: count, values: values };
}

/** 就地改写 chunk 偏移表（values 长度必须与 count 一致） */
export function writeChunkOffsets(bytes, boxStart, type, values) {
  const base = boxStart + 16;
  const is64 = type === 'co64';
  for (let i = 0; i < values.length; i += 1) {
    if (is64) {
      const value = values[i];
      writeUint32(bytes, base + i * 8, Math.floor(value / 4294967296));
      writeUint32(bytes, base + i * 8 + 4, value % 4294967296);
    } else {
      writeUint32(bytes, base + i * 4, values[i]);
    }
  }
}

/** 平移整条轨道的 chunk 偏移 */
export function shiftChunkOffsets(bytes, trakBox, delta) {
  const table = readChunkOffsets(bytes, trakBox);
  if (!table || delta === 0) return table;
  writeChunkOffsets(bytes, table.boxStart, table.type, table.values.map((value) => value + delta));
  return table;
}

/** mvhd 的 timescale 与 duration（v0/v1 布局不同） */
export function readMovieHeader(bytes, moovBox) {
  const mvhd = findChild(bytes, moovBox, 'mvhd');
  if (!mvhd) return null;
  const version = bytes[mvhd.start + 8];
  const timescale = readUint32(bytes, mvhd.start + (version === 1 ? 28 : 20));
  const duration = version === 1
    ? readUint64(bytes, mvhd.start + 32)
    : readUint32(bytes, mvhd.start + 24);
  return { boxStart: mvhd.start, version: version, timescale: timescale, duration: duration };
}

export function writeMovieDuration(bytes, header, duration) {
  if (!header) return;
  if (header.version === 1) {
    writeUint32(bytes, header.boxStart + 32, Math.floor(duration / 4294967296));
    writeUint32(bytes, header.boxStart + 36, duration % 4294967296);
  } else {
    writeUint32(bytes, header.boxStart + 24, Math.min(duration, 0xffffffff));
  }
}

/** 组装一个 box（payload 为 Uint8Array） */
export function buildBox(type, payload) {
  const body = payload || new Uint8Array(0);
  const out = new Uint8Array(8 + body.length);
  writeUint32(out, 0, out.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

export function concatBytes(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** 顶层 box 列表（顺带给出 ftyp/moov/mdat 的位置） */
export function parseTopLevel(bytes) {
  const boxes = listBoxes(bytes, 0, bytes.length);
  const pick = (type) => boxes.find((box) => box.type === type) || null;
  return {
    boxes: boxes,
    ftyp: pick('ftyp'),
    moov: pick('moov'),
    mdat: boxes.filter((box) => box.type === 'mdat'),
    hasFragments: boxes.some((box) => box.type === 'moof')
  };
}

/* ------------------------------------------------------------------ *
 * 分片 MP4（fMP4）相关的 FullBox 读写
 *
 * fMP4 的合流需要动的是：moov 里的 mvex/trex、每个 moof 里的 mfhd 序号、
 * traf 里 tfhd 的 track_ID 与 trun 的 data_offset。
 * ------------------------------------------------------------------ */

/** FullBox 头：version(1) + flags(3) */
export function readFullBoxHeader(bytes, box) {
  const at = box.start + 8;
  return {
    version: bytes[at],
    flags: (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]
  };
}

/** tfhd：track_ID 与常用 flags（default-base-is-moof 等） */
export function readTfhd(bytes, box) {
  const header = readFullBoxHeader(bytes, box);
  const trackId = readUint32(bytes, box.start + 12);
  return { version: header.version, flags: header.flags, trackId: trackId };
}

export function setTfhdTrackId(bytes, box, trackId) {
  writeUint32(bytes, box.start + 12, trackId);
}

/** mfhd：序列号 */
export function readMfhdSequence(bytes, box) {
  return readUint32(bytes, box.start + 12);
}

export function writeMfhdSequence(bytes, box, sequence) {
  writeUint32(bytes, box.start + 12, sequence);
}

/** trun 的 data_offset（有则返回，没有返回 null） */
export function readTrunDataOffset(bytes, box) {
  const header = readFullBoxHeader(bytes, box);
  if ((header.flags & 0x000001) === 0) return null;
  const raw = readUint32(bytes, box.start + 16);
  return raw > 0x7fffffff ? raw - 4294967296 : raw;
}

export function writeTrunDataOffset(bytes, box, value) {
  writeUint32(bytes, box.start + 16, value < 0 ? value + 4294967296 : value);
}

/** 把 moov 里的 mvex 取出来（没有则 null） */
export function findMvex(bytes, moovBox) {
  return findChild(bytes, moovBox, 'mvex');
}

/** mvex 下的 trex 列表 */
export function listTrex(bytes, mvexBox) {
  const [from, to] = payloadRange(mvexBox);
  return listBoxes(bytes, from, to).filter((box) => box.type === 'trex');
}

/** trex 里记录的是 track_ID（box 偏移 12） */
export function setTrexTrackId(bytes, trexBox, trackId) {
  writeUint32(bytes, trexBox.start + 12, trackId);
}

export function readTrexTrackId(bytes, trexBox) {
  return readUint32(bytes, trexBox.start + 12);
}

/**
 * 把顶层 box 切成"片段组"：每个 moof 连同它后续的 mdat 算一组。
 * 片段组之外的 box（ftyp/moov/其它）单独返回。
 */
export function groupFragments(bytes) {
  const boxes = listBoxes(bytes, 0, bytes.length);
  const fragments = [];
  const others = [];
  let current = null;

  for (const box of boxes) {
    if (box.type === 'moof') {
      current = { moof: box, mdat: [], boxes: [box] };
      fragments.push(current);
      continue;
    }
    if (current && box.type === 'mdat') {
      current.mdat.push(box);
      current.boxes.push(box);
      continue;
    }
    current = null;
    others.push(box);
  }
  return { fragments: fragments, others: others };
}
