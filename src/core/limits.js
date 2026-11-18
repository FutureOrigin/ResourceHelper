/**
 * 资源预算（P3 收尾）
 *
 * 合流（remux）必须把视频与音频完整读进内存：这是一个无法回避的结构性限制，
 * 因为 ISO BMFF 的偏移改写需要全文件视图。
 *
 * 与其让标签页在 1.5GB 的视频上被系统杀掉，不如**提前判断**并降级为
 * "只保存视频轨"（用户至少拿到能播的文件），同时把原因说清楚。
 */

/** 合流的保守预算：超过就降级（侧边栏进程还要留余量给解析与 UI） */
export const MUX_SOFT_LIMIT_BYTES = Math.round(1.2 * 1024 * 1024 * 1024);

/**
 * @param {{videoBytes?:number|null, audioBytes?:number|null, limitBytes?:number}} input
 * @returns {{ok:boolean, totalBytes:number|null, limitBytes:number, reason:string}}
 */
export function checkMuxBudget(input) {
  const opts = input || {};
  const limitBytes = Number.isFinite(opts.limitBytes) && opts.limitBytes > 0 ? opts.limitBytes : MUX_SOFT_LIMIT_BYTES;
  const video = Number.isFinite(opts.videoBytes) && opts.videoBytes > 0 ? opts.videoBytes : null;
  const audio = Number.isFinite(opts.audioBytes) && opts.audioBytes > 0 ? opts.audioBytes : null;

  // 体积未知时不做判断（宁可尝试，也不要因为探测失败就拒绝合流）
  if (video == null) {
    return { ok: true, totalBytes: null, limitBytes: limitBytes, reason: 'UNKNOWN_SIZE' };
  }

  const totalBytes = video + (audio == null ? 0 : audio);
  if (totalBytes > limitBytes) {
    return { ok: false, totalBytes: totalBytes, limitBytes: limitBytes, reason: 'OVER_BUDGET' };
  }
  return { ok: true, totalBytes: totalBytes, limitBytes: limitBytes, reason: 'WITHIN_BUDGET' };
}

/** 给用户看的一句话说明 */
export function describeBudgetFailure(budget) {
  const total = budget && Number.isFinite(budget.totalBytes) ? budget.totalBytes : 0;
  const limit = budget && Number.isFinite(budget.limitBytes) ? budget.limitBytes : MUX_SOFT_LIMIT_BYTES;
  const gb = (value) => (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  return '视频约 ' + gb(total) + '，超过合流预算 ' + gb(limit)
    + '（合流需要把两条轨都放进内存）。已改为只保存视频轨。';
}
