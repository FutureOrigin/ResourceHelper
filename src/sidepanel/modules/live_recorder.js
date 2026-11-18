/**
 * 直播录制器（P7）
 *
 * 思路：直播的 m3u8 是一个滚动窗口。每隔一小段时间拉一次播放列表，
 * 用 core/live-record.js 的账本算出新增分片，下载后追加到滚动落盘缓冲里。
 *
 * 边界：
 *   · 只在播放列表没有 #EXT-X-ENDLIST 时才认作直播；
 *   · 停止时若一片都没录到，明确报错，不产出一个空文件；
 *   · 全程用 ChunkedBlobSink，内存不会随录制时长线性增长。
 */

import { parseMasterPlaylist, parseMediaPlaylist, pickBestVariant } from '../../core/hls.js';
import { ChunkedBlobSink } from '../../core/sink.js';
import { createLiveState, describeProgress, nextSegments, recommendInterval } from '../../core/live-record.js';
import { finalizeBlobDownload } from './download_finalize.js';

const FETCH_CONCURRENCY = 3;

async function fetchText(url) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error('获取播放列表失败 (HTTP ' + response.status + ')');
  return { text: await response.text(), url: response.url || url };
}

async function fetchBytes(url) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error('分片失败 HTTP ' + response.status);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchAll(urls, limit) {
  const results = new Array(urls.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= urls.length) return;
      try {
        results[index] = await fetchBytes(urls[index]);
      } catch (e) {
        results[index] = null;   // 单片失败不终止整场录制
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, urls.length) }, worker));
  return results;
}

export class LiveRecorder {
  constructor() {
    this.session = null;
  }

  get active() {
    return Boolean(this.session);
  }

  /**
   * @param {{url:string, title:string, onProgress?:(info:Object)=>void}} input
   */
  async start(input) {
    if (this.session) throw new Error('已有录制在进行中');

    const root = await fetchText(input.url);
    let mediaUrl = root.url;
    let mediaText = root.text;

    // master playlist：选最高档再录
    const master = parseMasterPlaylist(root.text, root.url);
    if (master.variants.length > 0) {
      const best = pickBestVariant(master.variants, {});
      if (!best) throw new Error('播放列表里没有可用清晰度');
      mediaUrl = best.uri;
      mediaText = (await fetchText(mediaUrl)).text;
    }

    const first = parseMediaPlaylist(mediaText, mediaUrl);
    if (first.segments.length === 0) throw new Error('播放列表里没有分片');

    const state = createLiveState();
    const sink = new ChunkedBlobSink({ mime: 'video/mp2t' });

    this.session = {
      url: mediaUrl,
      title: input.title || '直播录制',
      state: state,
      sink: sink,
      timer: null,
      startedAt: Date.now(),
      onProgress: typeof input.onProgress === 'function' ? input.onProgress : () => {},
      failedSegments: 0,
      gaps: 0,
      initAdded: false
    };

    await this.collect(mediaText, first);
    this.schedule();
    return { ok: true };
  }

  async collect(mediaText, media) {
    const session = this.session;
    if (!session) return;

    // 初始化段只加一次（fMP4 直播）
    if (!session.initAdded && media.initSegment && media.initSegment.uri) {
      try {
        session.sink.add(await fetchBytes(media.initSegment.uri));
        session.initAdded = true;
      } catch (e) {}
    }

    const next = nextSegments(session.state, media);
    session.gaps += next.gaps || 0;
    if (next.segments.length > 0) {
      const bytes = await fetchAll(next.segments.map((segment) => segment.uri), FETCH_CONCURRENCY);
      for (const chunk of bytes) {
        if (chunk) session.sink.add(chunk);
        else session.failedSegments += 1;
      }
    }

    session.onProgress(Object.assign(
      describeProgress(session.state, Date.now() - session.startedAt),
      {
        bytes: session.sink.totalBytes,
        gaps: session.gaps,
        live: true
      }
    ));
    return next;
  }

  schedule() {
    const session = this.session;
    if (!session) return;
    const interval = recommendInterval(4);
    session.timer = setTimeout(() => this.tick(), interval);
  }

  async tick() {
    const session = this.session;
    if (!session) return;
    try {
      const fresh = await fetchText(session.url);
      const media = parseMediaPlaylist(fresh.text, fresh.url);
      await this.collect(fresh.text, media);
      if (/^#EXT-X-ENDLIST/m.test(fresh.text)) {
        // 直播结束：自动收尾
        await this.stop();
        return;
      }
    } catch (e) {
      // 单次拉取失败不终止录制，下一轮继续
    }
    this.schedule();
  }

  async stop() {
    const session = this.session;
    if (!session) return null;
    this.session = null;
    if (session.timer) clearTimeout(session.timer);

    if (session.sink.totalBytes === 0) {
      throw new Error('没有录到任何分片');
    }

    const blob = session.sink.close();
    const downloadId = await finalizeBlobDownload({
      blob: blob,
      filename: filename,
      meta: {
        title: session.title,
        url: session.url,
        mode: 'stream',
        site: (() => { try { return new URL(session.url).hostname; } catch (e) { return ''; } })()
      }
    });
    return {
      downloadId: downloadId,
      bytes: blob.size,
      segments: session.state.totalSegments,
      failedSegments: session.failedSegments,
      discontinuity: session.state.discontinuity
    };
  }
}
