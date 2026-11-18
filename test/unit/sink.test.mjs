import test from 'node:test';
import assert from 'node:assert/strict';

import { ChunkedBlobSink, OrderedWriter, DEFAULT_CHUNK_BYTES } from '../../src/core/sink.js';

const bytes = (fill, length) => new Uint8Array(length).fill(fill);

test('小块累积到阈值才固化，内存占用有上界', () => {
  const sink = new ChunkedBlobSink({ chunkBytes: 100 });
  for (let i = 0; i < 9; i += 1) sink.add(bytes(i, 30));   // 270 字节
  assert.equal(sink.totalBytes, 270);
  assert.ok(sink.flushes >= 2, '超过阈值必须固化过');
  assert.ok(sink.bufferedBytes < 100, '未固化的部分永远小于一个块');
  assert.equal(sink.blobCount, sink.flushes);
});

test('toBlob 的内容与顺序不变', async () => {
  const sink = new ChunkedBlobSink({ chunkBytes: 10, mime: 'video/mp4' });
  sink.add(bytes(1, 4)).add(bytes(2, 4)).add(bytes(3, 4));
  const blob = sink.toBlob();
  assert.equal(blob.size, 12);
  const buffer = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual(Array.from(buffer.slice(0, 4)), [1, 1, 1, 1]);
  assert.deepEqual(Array.from(buffer.slice(8, 12)), [3, 3, 3, 3]);
});

test('close 之后继续写会报错', () => {
  const sink = new ChunkedBlobSink({ chunkBytes: 10 });
  sink.add(bytes(1, 4));
  const blob = sink.close();
  assert.equal(blob.size, 4);
  assert.throws(() => sink.add(bytes(2, 4)));
});

test('release 清空引用，避免把 Blob 一直挂住', () => {
  const sink = new ChunkedBlobSink({ chunkBytes: 4 });
  sink.add(bytes(1, 8));
  sink.release();
  assert.equal(sink.parts.length, 0);
  assert.equal(sink.pendingBytes, 0);
});

test('默认块大小是 64MB', () => {
  assert.equal(new ChunkedBlobSink().chunkBytes, DEFAULT_CHUNK_BYTES);
  assert.equal(DEFAULT_CHUNK_BYTES, 64 * 1024 * 1024);
});

test('OrderedWriter 按索引顺序落盘，乱序到达不串位', async () => {
  const sink = new ChunkedBlobSink({ chunkBytes: 1024 });
  const writer = new OrderedWriter(sink);
  writer.push(2, bytes(3, 2));
  writer.push(0, bytes(1, 2));
  assert.equal(writer.pendingCount, 1, '第 2 段应等待第 1 段');
  assert.equal(sink.totalBytes, 2, '还没轮到的不应写入');

  writer.push(1, bytes(2, 2));
  assert.equal(writer.nextIndex, 3, '连续到达后应一次性排空');
  assert.equal(writer.pendingCount, 0);
  assert.equal(sink.totalBytes, 6);

  const buffer = new Uint8Array(await writer.finish().arrayBuffer());
  assert.deepEqual(Array.from(buffer), [1, 1, 2, 2, 3, 3]);
});

test('OrderedWriter 丢弃重复到达的分片', async () => {
  const sink = new ChunkedBlobSink({ chunkBytes: 1024 });
  const writer = new OrderedWriter(sink);
  writer.push(0, bytes(1, 2));
  writer.push(0, bytes(9, 2)); // 重复
  writer.push(1, bytes(2, 2));
  const buffer = new Uint8Array(await writer.finish().arrayBuffer());
  assert.deepEqual(Array.from(buffer), [1, 1, 2, 2]);
});

test('OrderedWriter 支持非零起始索引（断点续传预留）', async () => {
  const sink = new ChunkedBlobSink({ chunkBytes: 1024 });
  const writer = new OrderedWriter(sink, { startIndex: 2 });
  writer.push(3, bytes(4, 1));
  writer.push(2, bytes(3, 1));
  const buffer = new Uint8Array(await writer.finish().arrayBuffer());
  assert.deepEqual(Array.from(buffer), [3, 4]);
});
