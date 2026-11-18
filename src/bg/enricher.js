/**
 * 资源补全队列（AUDIT E3 / I5）
 *
 * 探测是有网络成本的：必须限并发、去重、失败不重试、并且只在"未知"资源上做。
 * 这里把它做成一个可单测的小队列：注入 probe 函数，注入 onResult 回调。
 */

export class ProbeQueue {
  constructor(options) {
    const opts = options || {};
    if (typeof opts.probe !== 'function') throw new Error('ProbeQueue 需要 probe 函数');
    this.probe = opts.probe;
    this.onResult = typeof opts.onResult === 'function' ? opts.onResult : () => {};
    this.concurrency = Number.isInteger(opts.concurrency) && opts.concurrency > 0 ? opts.concurrency : 3;
    this.maxEntries = Number.isInteger(opts.maxEntries) && opts.maxEntries > 0 ? opts.maxEntries : 500;
    this.seen = new Map();   // url -> meta
    this.queue = [];
    this.active = 0;
    this.inflight = new Set();
    this.done = 0;
    this.failed = 0;
  }

  /** 入队；同一 URL 只探一次。返回是否真的入队 */
  request(url, meta) {
    if (!url || typeof url !== 'string') return false;
    if (/^(blob|data|chrome-extension|about):/i.test(url)) return false;
    if (this.seen.has(url)) return false;
    if (this.seen.size >= this.maxEntries) return false;
    this.seen.set(url, meta || {});
    this.queue.push({ url: url, meta: meta || {} });
    this.pump();
    return true;
  }

  has(url) {
    return this.seen.has(url);
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this.active += 1;

      const task = Promise.resolve()
        .then(() => this.probe(job.url))
        .then((result) => {
          if (result && result.ok) this.done += 1;
          else this.failed += 1;
          this.onResult(job.meta, result, job.url);
        })
        .catch(() => {
          this.failed += 1;
        })
        .then(() => {
          this.active -= 1;
          this.inflight.delete(task);
          this.pump();
        });

      this.inflight.add(task);
    }
  }

  /** 测试用：等队列彻底清空 */
  async drain() {
    while (this.inflight.size > 0) {
      await Promise.all(Array.from(this.inflight));
    }
    if (this.queue.length > 0) await this.drain();
  }
}
