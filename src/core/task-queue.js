/**
 * 任务队列（P6）
 *
 * 为什么要它：引擎路径（HLS / DASH / 合流）各自开 3-5 路并发拉片，
 * 用户连点三张卡就是十几路并发，慢网络的观感是"每个都在爬"。
 * 队列把下载串起来，一次只跑一个，其余显示"排队中"。
 *
 * 纯逻辑：不碰 chrome API，任务就是普通 async 函数，可单测。
 */

export const TASK_STATES = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

let sequence = 0;

export class TaskQueue {
  /**
   * @param {{concurrency?:number}} options
   */
  constructor(options) {
    const opts = options || {};
    this.concurrency = Number.isFinite(opts.concurrency) && opts.concurrency > 0 ? opts.concurrency : 1;
    this.pending = [];
    this.running = 0;
    this.history = [];
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
  }

  get size() {
    return this.pending.length;
  }

  get busy() {
    return this.running > 0;
  }

  /**
   * 入队。返回的 Promise 在任务真正执行完后才 settle。
   * @param {{id?:string, label?:string, run:Function}} task
   */
  add(task) {
    if (!task || typeof task.run !== 'function') return Promise.reject(new Error('任务缺少 run 函数'));
    sequence += 1;
    const entry = {
      id: task.id || 'task_' + sequence,
      label: task.label || '',
      run: task.run,
      meta: task.meta || null,
      state: TASK_STATES.PENDING,
      createdAt: Date.now()
    };

    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });

    this.pending.push(entry);
    this.emit();
    this.pump();
    return promise;
  }

  emit() {
    if (!this.onChange) return;
    try {
      this.onChange(this.snapshot());
    } catch (e) {}
  }

  /** 队列快照：给 UI 显示"排队中 N 个" */
  snapshot() {
    return {
      running: this.running,
      pending: this.pending.map((entry) => ({ id: entry.id, label: entry.label, state: entry.state })),
      recent: this.history.slice(-5)
    };
  }

  pump() {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift();
      this.running += 1;
      entry.state = TASK_STATES.RUNNING;
      this.emit();

      // 先更新队列状态再 settle 任务 Promise：
      // 否则 await 队列之后读到的 busy/size 还是旧值（调用方会看到"跑完了但仍显示忙碌"）
      const finish = (state, settle, payload) => {
        entry.state = state;
        this.history.push({ id: entry.id, label: entry.label, state: state });
        this.running -= 1;
        this.emit();
        this.pump();
        settle(payload);
      };

      Promise.resolve()
        .then(() => entry.run())
        .then(
          (result) => finish(TASK_STATES.DONE, entry.resolve, result),
          (error) => finish(TASK_STATES.FAILED, entry.reject, error)
        );
    }
  }

  /** 取消还没开始的任务；正在跑的不动（中断下载需要引擎配合） */
  cancelPending() {
    const cancelled = this.pending.splice(0, this.pending.length);
    for (const entry of cancelled) {
      entry.state = TASK_STATES.CANCELLED;
      const error = new Error('任务已取消');
      error.code = 'TASK_CANCELLED';
      entry.reject(error);
    }
    if (cancelled.length > 0) this.emit();
    return cancelled.length;
  }
}
