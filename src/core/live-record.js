/**
 * 直播录制（P7）
 *
 * 直播是一份"滚动窗口"的播放列表：每次拉取都是同一批地址的新快照，
 * 我们必须只取"上次之后新增的分片"，并且扛得住这几种情况：
 *   · #EXT-X-MEDIA-SEQUENCE 回退（播放列表被重置 / 换了码率）
 *   · #EXT-X-DISCONTINUITY（广告插入、节目切换）
 *   · 中间漏掉若干片（网络抖动 / 标签页休眠）
 *
 * 这里只做"账本"：记录已经取过的序列号、算出下次需要哪些分片。
 * 真正的拉取与落盘由调用方（录制器/下载器）负责，所以纯逻辑、可单测。
 */

/**
 * @typedef {Object} LiveState
 * @property {number|null} lastSequence 已取到的最后一个 media sequence
 * @property {Set<string>} seen 已取过的分片地址（防止序列号复用导致重复）
 * @property {number} discontinuity 遇到的不连续次数
 */

export function createLiveState() {
  return { lastSequence: null, seen: new Set(), discontinuity: 0, totalSegments: 0 };
}

/**
 * 根据一份新的媒体播放列表，计算本次需要下载的分片。
 * @param {LiveState} state
 * @param {Object} media parseMediaPlaylist 的结果
 * @returns {{segments:Array, added:number, skipped:number, reset:boolean, gaps:number, discontinuity:boolean}}
 */
export function nextSegments(state, media) {
  const segments = (media && media.segments) || [];
  const result = { segments: [], added: 0, skipped: 0, reset: false, gaps: 0, discontinuity: false };
  if (segments.length === 0) return result;

  const firstSequence = Number.isFinite(segments[0].sequence) ? segments[0].sequence : 0;
  const lastInPlaylist = Number.isFinite(segments[segments.length - 1].sequence)
    ? segments[segments.length - 1].sequence
    : firstSequence + segments.length - 1;

  // 播放列表回退（换源 / 重开）：清空游标重新开始，标记 reset
  if (state.lastSequence != null && firstSequence < state.lastSequence - 1) {
    result.reset = true;
    state.lastSequence = null;
    state.seen = new Set();
  }

  let discontinuity = false;
  for (const segment of segments) {
    if (segment.discontinuity) discontinuity = true;
    const sequence = Number.isFinite(segment.sequence) ? segment.sequence : null;
    const key = segment.uri || '';

    const alreadySeen = key && state.seen.has(key);
    const tooOld = state.lastSequence != null && sequence != null && sequence <= state.lastSequence;

    if (alreadySeen || tooOld) {
      result.skipped += 1;
      continue;
    }

    // 序列号跳变说明中间丢了片子：不假装连贯，如实计数
    if (state.lastSequence != null && sequence != null && sequence > state.lastSequence + 1) {
      result.gaps += sequence - state.lastSequence - 1;
    }

    result.segments.push(segment);
    result.added += 1;
    if (key) state.seen.add(key);
    if (sequence != null) state.lastSequence = sequence;
  }

  if (result.added === 0) state.lastSequence = Math.max(state.lastSequence == null ? lastSequence : state.lastSequence, lastInPlaylist);
  if (discontinuity) {
    state.discontinuity += 1;
    result.discontinuity = true;
  }
  state.totalSegments += result.added;

  // seen 只需要覆盖当前窗口，避免长直播把内存吃满
  if (state.seen.size > 4 * Math.max(segments.length, 32)) {
    const keep = new Set(segments.map((segment) => segment.uri));
    state.seen = keep;
  }

  return result;
}

/**
 * 轮询间隔：取目标时长的一半，夹在 [1s, 10s]。
 * 太慢会漏片（播放列表窗口有限），太快会给 CDN 白送请求。
 */
export function recommendInterval(targetDuration, options) {
  const opts = options || {};
  const duration = Number(targetDuration);
  const base = Number.isFinite(duration) && duration > 0 ? duration / 2 : 4;
  const min = Number.isFinite(opts.min) ? opts.min : 1000;
  const max = Number.isFinite(opts.max) ? opts.max : 10000;
  return Math.min(max, Math.max(min, Math.round(base * 1000)));
}

/** 录制摘要：给 UI 的"已录 N 段 / M 秒"用 */
export function describeProgress(state, elapsedMs) {
  return {
    segments: state.totalSegments,
    discontinuity: state.discontinuity,
    seconds: Math.round((Number(elapsedMs) || 0) / 1000)
  };
}
