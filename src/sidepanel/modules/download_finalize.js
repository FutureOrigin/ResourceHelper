/**
 * 下载末端（P3 收尾）
 *
 * 把"拿到 blob 之后怎么落地"从各个下载器里抽出来。两个好处：
 *   1. 三个下载器不再各写一遍 createObjectURL / downloads.download / revoke / 记历史；
 *   2. 这一小段现在可以单测（注入假的 downloads API），
 *      也为将来把"构建"搬到 offscreen 做了准备（落盘留在有扩展 API 的地方）。
 */

import { reportDownloadStarted } from './download_report.js';

export const DEFAULT_REVOKE_DELAY = 60000;

/**
 * @param {Object} input
 * @param {Blob} input.blob 已经组装好的文件
 * @param {string} input.filename 期望的文件名
 * @param {Object} [input.meta] 写入下载历史用的字段（title/url/audioUrl/mode/site）
 * @param {Object} [input.downloads] chrome.downloads 的替身（测试注入）
 * @param {Function} [input.createObjectUrl]
 * @param {Function} [input.revokeObjectUrl]
 * @param {Function} [input.scheduleRevoke]
 * @returns {Promise<number>} 浏览器下载 id
 */
export async function finalizeBlobDownload(input) {
  const opts = input || {};
  const blob = opts.blob;
  if (!blob) throw new Error('没有可保存的数据');
  if (!opts.filename) throw new Error('缺少文件名');

  const downloads = opts.downloads || (typeof chrome !== 'undefined' ? chrome.downloads : null);
  if (!downloads || typeof downloads.download !== 'function') {
    throw new Error('下载接口不可用');
  }

  const createUrl = opts.createObjectUrl || ((value) => URL.createObjectURL(value));
  const revokeUrl = opts.revokeObjectUrl || ((value) => URL.revokeObjectURL(value));
  const scheduleRevoke = opts.scheduleRevoke || ((fn) => setTimeout(fn, DEFAULT_REVOKE_DELAY));

  const objectUrl = createUrl(blob);
  let downloadId;
  try {
    downloadId = await downloads.download({ url: objectUrl, filename: opts.filename, saveAs: false });
  } catch (error) {
    // 下载没起来就没有必要留着这个 URL
    try { revokeUrl(objectUrl); } catch (e) {}
    throw error;
  }

  // 下载由浏览器接管后再释放；立刻 revoke 会让浏览器拿不到数据
  scheduleRevoke(() => {
    try { revokeUrl(objectUrl); } catch (e) {}
  });

  if (Number.isFinite(downloadId)) {
    reportDownloadStarted(Object.assign({}, opts.meta || {}, {
      id: 'b' + downloadId,
      browserDownloadId: downloadId,
      filename: opts.filename
    }));
  }

  return downloadId;
}
