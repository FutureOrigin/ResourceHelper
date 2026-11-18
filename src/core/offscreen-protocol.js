/**
 * offscreen 构建任务的消息契约（P3c）
 *
 * 侧边栏 / 后台 / offscreen 三方通过 runtime 消息协作，
 * 消息形状写在这里，避免三处各写一遍字符串判断、慢慢走样。
 */

export const BUILD_KINDS = Object.freeze(['hls', 'dash', 'mux']);

export const MESSAGE = Object.freeze({
  BUILD: 'RH_OFFSCREEN_BUILD',        // 侧边栏 -> 后台：请帮我建这个任务
  JOB_START: 'RH_OFFSCREEN_JOB',      // 后台 -> offscreen：真正开始构建
  PROGRESS: 'RH_BUILD_PROGRESS',      // offscreen -> 所有人：进度
  READY: 'RH_OFFSCREEN_READY',        // offscreen -> 后台：做好了，这是 blob URL
  RELEASE: 'RH_OFFSCREEN_RELEASE',    // 后台 -> offscreen：可以释放 URL 了
  RESULT: 'RH_BUILD_RESULT',          // 后台 -> 侧边栏：任务结束（成功/失败）
  UNAVAILABLE: 'RH_OFFSCREEN_UNAVAILABLE'
});

const KINDS = new Set(BUILD_KINDS);

/** 校验并规整"开始构建"的请求；不合法返回 null（调用方回退到本地执行） */
export function normalizeBuildRequest(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = String(input.kind || '');
  if (!KINDS.has(kind)) return null;
  const payload = input.payload;
  if (!payload || typeof payload !== 'object') return null;
  if (!payload.url) return null;
  return {
    kind: kind,
    jobId: String(input.jobId || ''),
    tabId: Number.isFinite(input.tabId) ? input.tabId : null,
    payload: {
      url: String(payload.url),
      title: typeof payload.title === 'string' ? payload.title : '',
      audioUrl: typeof payload.audioUrl === 'string' ? payload.audioUrl : '',
      height: Number.isFinite(payload.height) ? payload.height : null
    }
  };
}

/** 校验 offscreen 回报的"做好了"；不合法返回 null */
export function normalizeReady(input) {
  if (!input || typeof input !== 'object') return null;
  const blobUrl = String(input.blobUrl || '');
  if (!blobUrl.startsWith('blob:')) return null;
  const filename = String(input.filename || '').trim();
  if (!filename) return null;
  return {
    jobId: String(input.jobId || ''),
    blobUrl: blobUrl,
    filename: filename,
    meta: input.meta && typeof input.meta === 'object' ? input.meta : {}
  };
}

/** 进度百分比夹紧到 0..100，文案截断，避免异常值把 UI 弄乱 */
export function normalizeProgress(input) {
  const opts = input || {};
  const raw = Number(opts.percent);
  const percent = Number.isFinite(raw) ? Math.min(100, Math.max(0, Math.round(raw))) : 0;
  return {
    jobId: String(opts.jobId || ''),
    percent: percent,
    text: typeof opts.text === 'string' ? opts.text.slice(0, 120) : ''
  };
}
