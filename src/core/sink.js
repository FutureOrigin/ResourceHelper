/**
 * 落盘缓冲（P3c 的第一步：把"整份驻留内存"换成"分段滚动")
 *
 * 现状问题（AUDIT D1）：HLS 下载把所有分片的 ArrayBuffer 攒在数组里，
 * 最后 new Blob(parts) 一次性组装。一部 500MB 的视频就是 500MB 常驻内存，
 * 2GB 直接崩标签页。
 *
 * 关键观察：Chromium 的 Blob 存储本身可以落盘，真正吃内存的是我们手里那些
 * ArrayBuffer。所以只要**每攒够一个块就转成 Blob 并释放原始缓冲**，
 * 峰值内存就能压到"一个块"的量级，而且完全不需要弹保存对话框、不改变现有 UX。
 *
 * 纯逻辑，不依赖 DOM；Node 18+ 自带 Blob，可直接单测。
 */

export const DEFAULT_CHUNK_BYTES = 64 * 1024 * 1024;

export class ChunkedBlobSink {
  constructor(options) {
    const opts = options || {};
    this.chunkBytes = Number.isFinite(opts.chunkBytes) && opts.chunkBytes > 0 ? opts.chunkBytes : DEFAULT_CHUNK_BYTES;
    this.mime = opts.mime || 'application/octet-stream';
    this.parts = [];          // 已冻结的 Blob 段
    this.pending = [];        // 还在内存里的 Uint8Array
    this.pendingBytes = 0;
    this.totalBytes = 0;
    this.flushes = 0;
    this.closed = false;
  }

  /** 追加一段数据；超过块阈值就固化并释放 */
  add(chunk) {
    if (!chunk || chunk.length === 0) return this;
    if (this.closed) throw new Error('sink 已关闭');
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    this.totalBytes += chunk.length;
    if (this.pendingBytes >= this.chunkBytes) this.flush();
    return this;
  }

  /** 把 pending 固化成 Blob（Chromium 可将其落到磁盘），并清空引用 */
  flush() {
    if (this.pending.length === 0) return;
    this.parts.push(new Blob(this.pending, { type: this.mime }));
    this.pending = [];
    this.pendingBytes = 0;
    this.flushes += 1;
  }

  /** 内存里还没固化的字节数（用来自证"不会无限增长"） */
  get bufferedBytes() {
    return this.pendingBytes;
  }

  get blobCount() {
    return this.parts.length;
  }

  toBlob() {
    if (this.parts.length === 0) return new Blob(this.pending, { type: this.mime });
    return new Blob(this.parts.concat(this.pending), { type: this.mime });
  }

  close() {
    this.flush();
    this.closed = true;
    return this.toBlob();
  }

  release() {
    this.parts = [];
    this.pending = [];
    this.pendingBytes = 0;
  }
}

/**
 * 乱序到达、按序落盘。
 *
 * 并发下载时分片完成顺序是乱的，但拼装必须严格按索引。
 * 这里只保留"还没轮到的"缓冲，轮到就立刻交给 sink 并释放。
 */
export class OrderedWriter {
  constructor(sink, options) {
    const opts = options || {};
    this.sink = sink;
    this.nextIndex = Number.isInteger(opts.startIndex) ? opts.startIndex : 0;
    this.waiting = new Map();
    this.written = 0;
  }

  /** 写入第 index 段（乱序安全） */
  push(index, data) {
    if (index === this.nextIndex) {
      this.write(data);
      this.nextIndex += 1;
      this.drain();
      return;
    }
    if (index > this.nextIndex) {
      this.waiting.set(index, data);
    }
    // index < nextIndex：重复到达，直接丢弃
  }

  drain() {
    for (;;) {
      const ready = this.waiting.get(this.nextIndex);
      if (ready === undefined) return;
      this.waiting.delete(this.nextIndex);
      this.write(ready);
      this.nextIndex += 1;
    }
  }

  write(data) {
    this.sink.add(data);
    this.written += 1;
  }

  /** 还卡在乱序缓冲里的段数 */
  get pendingCount() {
    return this.waiting.size;
  }

  finish() {
    return this.sink.close();
  }
}
