/**
 * 字体字形解析：sfnt / WOFF → CFF → Type2 charstring → 轮廓指纹
 *
 * 用途：还原"字体反爬"站点的正文。这类站点把常用字换成私用区码位
 * （U+E000–U+F8FF），再用一份自绘子集字体把私用区码位画成真字的字形：
 * 页面看着正常，复制/提取出来的却是私用区码位——普通字体里没有这些码位
 * 的字形，看起来就是"缺字"。
 *
 * 还原只有一条路：读出字形轮廓，认出它是哪个字。
 * 本模块负责前半段（解析 + 轮廓），core/font-deobfuscate.js 负责查表与替换。
 *
 * 纯计算模块：不碰 DOM、不发请求，Node 里也能跑（构建脚本用它生成指纹表）。
 */

class Reader {
  constructor(bytes, offset = 0) {
    const view = bytes instanceof DataView ? bytes : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.view = view;
    this.o = offset;
  }
  u8() { return this.view.getUint8(this.o++); }
  i16() { const v = this.view.getInt16(this.o); this.o += 2; return v; }
  u16() { const v = this.view.getUint16(this.o); this.o += 2; return v; }
  u32() { const v = this.view.getUint32(this.o); this.o += 4; return v; }
  i32() { const v = this.view.getInt32(this.o); this.o += 4; return v; }
  bytes(n) {
    const start = this.o;
    this.o += n;
    return new Uint8Array(this.view.buffer, this.view.byteOffset + start, n);
  }
  tag() {
    let s = '';
    for (let i = 0; i < 4; i++) s += String.fromCharCode(this.u8());
    return s;
  }
  offset(size) {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + this.u8();
    return v;
  }
}

/** 解析 sfnt（OTTO / true）表目录，返回 tag → Uint8Array */
export function readSfntTables(bytes) {
  const r = new Reader(bytes);
  const version = r.u32();
  const numTables = r.u16();
  r.u16(); r.u16(); r.u16();
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const tag = r.tag();
    r.u32();
    const offset = r.u32();
    const length = r.u32();
    tables.set(tag, new Uint8Array(bytes.buffer, bytes.byteOffset + offset, length));
  }
  return { version, tables };
}

/** 解析 WOFF1 表目录（表体是 zlib 压缩的，解压交给调用方） */
export function readWoffTables(bytes) {
  const r = new Reader(bytes);
  const signature = r.u32();
  if (signature !== 0x774F4646) throw new Error('not a woff file');
  r.u32();
  r.u32();
  const numTables = r.u16();
  r.u16(); r.u32();
  r.u16(); r.u16();
  r.u32(); r.u32(); r.u32(); r.u32(); r.u32();
  const entries = [];
  for (let i = 0; i < numTables; i++) {
    const tag = r.tag();
    const offset = r.u32();
    const compLength = r.u32();
    const origLength = r.u32();
    r.u32();
    entries.push({
      tag,
      compLength,
      origLength,
      data: new Uint8Array(bytes.buffer, bytes.byteOffset + offset, compLength)
    });
  }
  return entries;
}

function readCffIndex(reader) {
  const count = reader.u16();
  if (count === 0) return [];
  const offSize = reader.u8();
  const offsets = new Array(count + 1);
  for (let i = 0; i <= count; i++) offsets[i] = reader.offset(offSize);
  const base = reader.o - 1;
  const items = new Array(count);
  for (let i = 0; i < count; i++) {
    items[i] = new Uint8Array(reader.view.buffer, reader.view.byteOffset + base + offsets[i], offsets[i + 1] - offsets[i]);
  }
  reader.o = base + offsets[count];
  return items;
}

function parseDict(bytes) {
  const out = new Map();
  const r = new Reader(bytes);
  const stack = [];
  while (r.o < bytes.length) {
    const b0 = r.u8();
    if (b0 <= 21) {
      let op = b0;
      if (b0 === 12) op = 1200 + r.u8();
      out.set(op, stack.splice(0, stack.length));
    } else if (b0 === 28) {
      stack.push(r.i16());
    } else if (b0 === 29) {
      stack.push(r.i32());
    } else if (b0 === 30) {
      let done = false;
      while (!done && r.o < bytes.length) {
        const v = r.u8();
        if ((v >> 4) === 0xF || (v & 0xF) === 0xF) done = true;
      }
      stack.push(0);
    } else if (b0 >= 32 && b0 <= 246) {
      stack.push(b0 - 139);
    } else if (b0 >= 247 && b0 <= 250) {
      stack.push((b0 - 247) * 256 + r.u8() + 108);
    } else if (b0 >= 251 && b0 <= 254) {
      stack.push(-(b0 - 251) * 256 - r.u8() - 108);
    } else {
      throw new Error('bad dict byte ' + b0);
    }
  }
  return out;
}

function subrBias(count) {
  if (count < 1240) return 107;
  if (count < 33900) return 1131;
  return 32768;
}

function fmt(v) {
  if (!Number.isFinite(v)) return '0';
  const n = Math.round(v * 100) / 100;
  return String(n);
}

/**
 * CFF 字体：按 GID 解释 Type2 charstring，产出绝对坐标的轮廓命令串。
 * 宽度与 hint 只做跳过处理——这里只关心字形长什么样。
 */
export class CffFont {
  constructor(cffBytes) {
    this.bytes = cffBytes;
    const r = new Reader(cffBytes);
    const major = r.u8();
    if (major !== 1) throw new Error('unsupported CFF version ' + major);
    r.u8(); r.u8(); r.u8();
    readCffIndex(r);
    const topDicts = readCffIndex(r);
    this.strings = readCffIndex(r);
    this.globalSubrs = readCffIndex(r);
    if (!topDicts.length) throw new Error('empty CFF');
    const top = parseDict(topDicts[0]);
    this.top = top;
    this.isCid = top.has(1230);
    const charStringsOffset = (top.get(17) || [0])[0];
    this.charStrings = readCffIndex(new Reader(cffBytes, charStringsOffset));
    const privateEntry = top.get(18);
    this.privateDict = privateEntry ? this.readPrivate(privateEntry[1], privateEntry[0]) : null;
    this.fdArray = null;
    this.fdSelect = null;
    if (this.isCid) {
      const fdArrayEntry = top.get(1236);
      const fdSelectEntry = top.get(1237);
      if (fdArrayEntry) this.fdArray = this.readFdArray(fdArrayEntry[0]);
      if (fdSelectEntry) this.fdSelect = this.readFdSelect(fdSelectEntry[0], this.charStrings.length);
    }
  }

  readPrivate(offset, size) {
    const bytes = new Uint8Array(this.bytes.buffer, this.bytes.byteOffset + offset, size);
    const dict = parseDict(bytes);
    const subrsEntry = dict.get(19);
    const subrs = subrsEntry ? readCffIndex(new Reader(this.bytes, offset + subrsEntry[0])) : [];
    return { dict, subrs };
  }

  readFdArray(offset) {
    const fds = readCffIndex(new Reader(this.bytes, offset));
    return fds.map((bytes) => {
      const dict = parseDict(bytes);
      const priv = dict.get(18);
      return priv ? this.readPrivate(priv[1], priv[0]) : { dict, subrs: [] };
    });
  }

  readFdSelect(offset, numGlyphs) {
    const r = new Reader(this.bytes, offset);
    const format = r.u8();
    const map = new Uint8Array(numGlyphs);
    if (format === 0) {
      for (let gid = 0; gid < numGlyphs; gid++) map[gid] = r.u8();
    } else if (format === 3) {
      const nRanges = r.u16();
      const first = new Uint16Array(nRanges);
      const fd = new Uint8Array(nRanges);
      for (let i = 0; i < nRanges; i++) { first[i] = r.u16(); fd[i] = r.u8(); }
      const sentinel = r.u16();
      for (let i = 0; i < nRanges; i++) {
        const end = i + 1 < nRanges ? first[i + 1] : sentinel;
        for (let gid = first[i]; gid < end && gid < numGlyphs; gid++) map[gid] = fd[i];
      }
    } else {
      throw new Error('unsupported FDSelect format ' + format);
    }
    return map;
  }

  get numGlyphs() {
    return this.charStrings.length;
  }

  glyphState(gid) {
    if (!this.isCid) {
      return { subrs: this.privateDict ? this.privateDict.subrs : [], gsubrs: this.globalSubrs };
    }
    const fdIndex = this.fdSelect ? this.fdSelect[gid] || 0 : 0;
    const fd = this.fdArray ? this.fdArray[fdIndex] : null;
    return { subrs: fd ? fd.subrs : [], gsubrs: this.globalSubrs };
  }

  /** GID → 轮廓命令串（确定性；同一字形永远得到同一串） */
  outline(gid) {
    const cs = this.charStrings[gid];
    if (!cs) return '';
    const { subrs, gsubrs } = this.glyphState(gid);
    const state = {
      out: [],
      x: 0,
      y: 0,
      stack: [],
      nStems: 0,
      widthDone: false,
      open: false,
      subrBias: subrBias(subrs.length),
      gsubrBias: subrBias(gsubrs.length),
      depth: 0
    };
    this.run(cs, state, subrs, gsubrs);
    if (state.open) state.out.push('Z');
    return state.out.join(' ');
  }

  run(code, state, subrs, gsubrs) {
    if (state.depth > 12) throw new Error('charstring recursion too deep');
    state.depth++;
    const r = new Reader(code);
    const st = state.stack;
    while (r.o < code.length) {
      const b0 = r.u8();
      if (b0 >= 32 || b0 === 28) {
        if (b0 === 28) st.push(r.i16());
        else if (b0 <= 246) st.push(b0 - 139);
        else if (b0 <= 250) st.push((b0 - 247) * 256 + r.u8() + 108);
        else if (b0 <= 254) st.push(-(b0 - 251) * 256 - r.u8() - 108);
        else st.push(r.i32() / 65536);
        continue;
      }
      switch (b0) {
        case 1: case 3: case 18: case 23: {
          if (st.length % 2 === 1 && !state.widthDone) { st.shift(); }
          state.widthDone = true;
          state.nStems += Math.floor(st.length / 2);
          st.length = 0;
          break;
        }
        case 19: case 20: {
          if (st.length) {
            if (st.length % 2 === 1 && !state.widthDone) st.shift();
            state.widthDone = true;
            state.nStems += Math.floor(st.length / 2);
            st.length = 0;
          }
          r.o += (state.nStems + 7) >> 3;
          break;
        }
        case 21: {
          if (st.length > 2 && !state.widthDone) st.shift();
          state.widthDone = true;
          const dy = st.pop() || 0;
          const dx = st.pop() || 0;
          state.x += dx;
          state.y += dy;
          this.moveTo(state, state.x, state.y);
          st.length = 0;
          break;
        }
        case 22: {
          if (st.length > 1 && !state.widthDone) st.shift();
          state.widthDone = true;
          state.x += st.pop() || 0;
          this.moveTo(state, state.x, state.y);
          st.length = 0;
          break;
        }
        case 4: {
          if (st.length > 1 && !state.widthDone) st.shift();
          state.widthDone = true;
          state.y += st.pop() || 0;
          this.moveTo(state, state.x, state.y);
          st.length = 0;
          break;
        }
        case 5: {
          for (let i = 0; i + 1 < st.length; i += 2) {
            state.x += st[i] || 0;
            state.y += st[i + 1] || 0;
            this.lineTo(state, state.x, state.y);
          }
          st.length = 0;
          break;
        }
        case 6: case 7: {
          let horizontal = b0 === 6;
          for (let i = 0; i < st.length; i++) {
            if (horizontal) state.x += st[i] || 0; else state.y += st[i] || 0;
            this.lineTo(state, state.x, state.y);
            horizontal = !horizontal;
          }
          st.length = 0;
          break;
        }
        case 8: {
          for (let i = 0; i + 5 < st.length; i += 6) this.curve6(state, st, i);
          st.length = 0;
          break;
        }
        case 24: {
          let i = 0;
          for (; i + 5 < st.length - 2; i += 6) this.curve6(state, st, i);
          state.x += st[i] || 0;
          state.y += st[i + 1] || 0;
          this.lineTo(state, state.x, state.y);
          st.length = 0;
          break;
        }
        case 25: {
          let i = 0;
          for (; i + 1 < st.length - 6; i += 2) {
            state.x += st[i] || 0;
            state.y += st[i + 1] || 0;
            this.lineTo(state, state.x, state.y);
          }
          this.curve6(state, st, i);
          st.length = 0;
          break;
        }
        case 26: {
          // vvcurveto：{dya dxb dyb dyc}+，首尾都是竖直方向，可选的 dx1 在最前面
          let i = 0;
          let dx1 = 0;
          if (st.length % 2 === 1) dx1 = st[i++] || 0;
          for (; i + 3 < st.length; i += 4) {
            const dya = st[i] || 0;
            const dxb = st[i + 1] || 0;
            const dyb = st[i + 2] || 0;
            const dyc = st[i + 3] || 0;
            this.curve(
              state,
              state.x + dx1, state.y + dya,
              state.x + dx1 + dxb, state.y + dya + dyb,
              state.x + dx1 + dxb, state.y + dya + dyb + dyc
            );
            dx1 = 0;
          }
          st.length = 0;
          break;
        }
        case 27: {
          // hhcurveto：{dxa dxb dyb dxc}+，首尾都是水平方向，可选的 dy1 在最前面
          let i = 0;
          let dy1 = 0;
          if (st.length % 2 === 1) dy1 = st[i++] || 0;
          for (; i + 3 < st.length; i += 4) {
            const dxa = st[i] || 0;
            const dxb = st[i + 1] || 0;
            const dyb = st[i + 2] || 0;
            const dxc = st[i + 3] || 0;
            this.curve(
              state,
              state.x + dxa, state.y + dy1,
              state.x + dxa + dxb, state.y + dy1 + dyb,
              state.x + dxa + dxb + dxc, state.y + dy1 + dyb
            );
            dy1 = 0;
          }
          st.length = 0;
          break;
        }
        case 30: case 31: {
          let horizontal = b0 === 31;
          let i = 0;
          while (i + 3 < st.length) {
            const last = st.length - i === 5;
            if (horizontal) {
              const x1 = st[i] || 0;
              const x2 = st[i + 1] || 0;
              const y2 = st[i + 2] || 0;
              const y3 = st[i + 3] || 0;
              const dx = last ? st[i + 4] || 0 : 0;
              this.curve(state, state.x + x1, state.y, state.x + x1 + x2, state.y + y2, state.x + x1 + x2 + dx, state.y + y2 + y3);
              i += last ? 5 : 4;
            } else {
              const y1 = st[i] || 0;
              const x2 = st[i + 1] || 0;
              const y2 = st[i + 2] || 0;
              const x3 = st[i + 3] || 0;
              const dy = last ? st[i + 4] || 0 : 0;
              this.curve(state, state.x, state.y + y1, state.x + x2, state.y + y1 + y2, state.x + x2 + x3, state.y + y1 + y2 + dy);
              i += last ? 5 : 4;
            }
            horizontal = !horizontal;
          }
          st.length = 0;
          break;
        }
        case 10: {
          const index = st.pop() || 0;
          const subr = subrs[index + state.subrBias];
          if (subr) this.run(subr, state, subrs, gsubrs);
          break;
        }
        case 29: {
          const index = st.pop() || 0;
          const subr = gsubrs[index + state.gsubrBias];
          if (subr) this.run(subr, state, subrs, gsubrs);
          break;
        }
        case 11: {
          state.depth--;
          return;
        }
        case 14: {
          if (state.open) { state.out.push('Z'); state.open = false; }
          st.length = 0;
          state.depth--;
          return;
        }
        case 12: {
          this.escape(r.u8(), state, st);
          break;
        }
        default:
          st.length = 0;
          break;
      }
    }
    state.depth--;
  }

  escape(op, state, st) {
    const num = (i) => st[i] || 0;
    switch (op) {
      case 34: {
        this.curve(state, state.x + num(0), state.y, state.x + num(0) + num(1), state.y + num(2), state.x + num(0) + num(1) + num(3), state.y + num(2));
        this.curve(state, state.x + num(4), state.y + num(2), state.x + num(4) + num(5), state.y + num(2), state.x + num(4) + num(5) + num(6), state.y);
        break;
      }
      case 35: {
        this.curve(state, state.x + num(0), state.y + num(1), state.x + num(0) + num(2), state.y + num(1) + num(3), state.x + num(0) + num(2) + num(4), state.y + num(1) + num(3) + num(5));
        this.curve(state, state.x + num(6), state.y + num(7), state.x + num(6) + num(8), state.y + num(7) + num(9), state.x + num(6) + num(8) + num(10), state.y + num(7) + num(9) + num(11));
        break;
      }
      case 36: {
        this.curve(state, state.x + num(0), state.y + num(1), state.x + num(0) + num(2), state.y + num(1) + num(3), state.x + num(0) + num(2) + num(4), state.y + num(1) + num(3));
        this.curve(state, state.x + num(5), state.y + num(1) + num(3), state.x + num(5) + num(6), state.y + num(1) + num(3) + num(7), state.x + num(5) + num(6) + num(8), state.y + num(1) + num(3) + num(7));
        break;
      }
      case 37: {
        const startX = state.x;
        const startY = state.y;
        const sumX = num(0) + num(2) + num(4) + num(6) + num(8);
        const sumY = num(1) + num(3) + num(5) + num(7) + num(9);
        let dx6 = 0;
        let dy6 = 0;
        if (Math.abs(sumX) > Math.abs(sumY)) { dx6 = num(10); dy6 = -sumY; } else { dy6 = num(10); dx6 = -sumX; }
        this.curve(state, startX + num(0), startY + num(1), startX + num(0) + num(2), startY + num(1) + num(3), startX + num(0) + num(2) + num(4), startY + num(1) + num(3) + num(5));
        this.curve(state, startX + num(0) + num(2) + num(4) + num(6), startY + num(1) + num(3) + num(5) + num(7), startX + num(0) + num(2) + num(4) + num(6) + num(8), startY + num(1) + num(3) + num(5) + num(7) + num(9), startX + num(0) + num(2) + num(4) + num(6) + num(8) + dx6, startY + num(1) + num(3) + num(5) + num(7) + num(9) + dy6);
        break;
      }
      case 3: { const b = st.pop(); const a = st.pop(); st.push(a && b ? 1 : 0); break; }
      case 4: { const b = st.pop(); const a = st.pop(); st.push(a || b ? 1 : 0); break; }
      case 5: { const a = st.pop(); st.push(a ? 0 : 1); break; }
      case 9: { st.push(Math.abs(st.pop() || 0)); break; }
      case 10: { const b = st.pop() || 0; const a = st.pop() || 0; st.push(a + b); break; }
      case 11: { const b = st.pop() || 0; const a = st.pop() || 0; st.push(a - b); break; }
      case 12: { const b = st.pop() || 0; const a = st.pop() || 0; st.push(b ? a / b : 0); break; }
      case 14: { st.push(-(st.pop() || 0)); break; }
      case 15: { const b = st.pop(); const a = st.pop(); st.push(a === b ? 1 : 0); break; }
      case 18: { st.pop(); break; }
      case 24: { const b = st.pop() || 0; const a = st.pop() || 0; st.push(a * b); break; }
      case 26: { st.push(Math.sqrt(Math.abs(st.pop() || 0))); break; }
      case 27: { st.push(st[st.length - 1] || 0); break; }
      case 28: { const b = st.pop(); const a = st.pop(); st.push(b, a); break; }
      case 29: { const i = st.pop() || 0; st.push(st[st.length - 1 - i] || 0); break; }
      default:
        break;
    }
    if (op >= 34 && op <= 37) st.length = 0;
  }

  moveTo(state, x, y) {
    if (state.open) { state.out.push('Z'); state.open = false; }
    state.out.push('M' + fmt(x) + ',' + fmt(y));
    state.open = true;
  }

  lineTo(state, x, y) {
    if (!state.open) {
      state.out.push('M' + fmt(x) + ',' + fmt(y));
      state.open = true;
      return;
    }
    state.out.push('L' + fmt(x) + ',' + fmt(y));
  }

  /** 三次贝塞尔，参数是绝对坐标；结束时把当前点移到终点 */
  curve(state, x1, y1, x2, y2, x3, y3) {
    state.out.push('C' + [x1, y1, x2, y2, x3, y3].map(fmt).join(','));
    state.open = true;
    state.x = x3;
    state.y = y3;
  }

  curve6(state, st, i) {
    const x1 = state.x + (st[i] || 0);
    const y1 = state.y + (st[i + 1] || 0);
    const x2 = x1 + (st[i + 2] || 0);
    const y2 = y1 + (st[i + 3] || 0);
    const x3 = x2 + (st[i + 4] || 0);
    const y3 = y2 + (st[i + 5] || 0);
    this.curve(state, x1, y1, x2, y2, x3, y3);
  }
}

/** 64 位 FNV-1a：轮廓命令串 → 指纹 */
export function signature64(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xFFFFFFFFFFFFFFFFn;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash;
}

export function signatureHex(text) {
  return signature64(text).toString(16).padStart(16, '0');
}

/** 解析 cmap，返回 codepoint → GID */
export function readCmap(tables) {
  const cmap = tables.get('cmap');
  const map = new Map();
  if (!cmap) return map;
  const head = new Reader(cmap);
  head.u16();
  const count = head.u16();
  const subtables = [];
  for (let i = 0; i < count; i++) {
    const platform = head.u16();
    const encoding = head.u16();
    const offset = head.u32();
    subtables.push({ platform, encoding, offset, format: new Reader(cmap, offset).u16() });
  }
  const twelve = subtables.find((s) => s.format === 12);
  if (twelve) {
    const sr = new Reader(cmap, twelve.offset);
    sr.u16(); sr.u16(); sr.u32(); sr.u32();
    const groups = sr.u32();
    for (let i = 0; i < groups; i++) {
      const start = sr.u32();
      const end = sr.u32();
      const startGid = sr.u32();
      for (let cp = start; cp <= end; cp++) map.set(cp, startGid + (cp - start));
    }
  }
  const four = subtables.find((s) => s.format === 4);
  if (four) {
    const sr = new Reader(cmap, four.offset);
    sr.u16(); sr.u16(); sr.u16();
    const segX2 = sr.u16();
    const seg = segX2 / 2;
    sr.u16(); sr.u16(); sr.u16();
    const endCodes = new Array(seg);
    const startCodes = new Array(seg);
    const deltas = new Array(seg);
    const rangeOffsets = new Array(seg);
    for (let i = 0; i < seg; i++) endCodes[i] = sr.u16();
    sr.u16();
    for (let i = 0; i < seg; i++) startCodes[i] = sr.u16();
    for (let i = 0; i < seg; i++) deltas[i] = sr.i16();
    const rangeStart = sr.o;
    for (let i = 0; i < seg; i++) rangeOffsets[i] = sr.u16();
    for (let i = 0; i < seg; i++) {
      for (let cp = startCodes[i]; cp <= endCodes[i] && cp !== 0xFFFF; cp++) {
        if (map.has(cp)) continue;
        let gid;
        if (rangeOffsets[i] === 0) {
          gid = (cp + deltas[i]) & 0xFFFF;
        } else {
          const index = rangeStart + i * 2 + rangeOffsets[i] + (cp - startCodes[i]) * 2;
          if (index + 1 >= cmap.length) continue;
          gid = (cmap[index] << 8) | cmap[index + 1];
          if (gid !== 0) gid = (gid + deltas[i]) & 0xFFFF;
        }
        if (gid) map.set(cp, gid);
      }
    }
  }
  return map;
}

/** 取 CFF 表；没有就返回 null（TrueType 轮廓暂不支持） */
export function getCffTable(tables) {
  return tables.get('CFF ') || null;
}
