/**
 * 下载落地后回报给后台，记入下载历史（P6）
 *
 * 直接下载由后台自己记录；HLS / DASH / 合流这三条引擎路径的下载在侧边栏里发生，
 * 只有这里才知道浏览器下载 id，所以由调用方回报一次。
 */
export function reportDownloadStarted(entry) {
  if (!entry) return;
  try {
    const pending = chrome.runtime.sendMessage({
      type: 'RH_DOWNLOAD_STARTED',
      entry: Object.assign({ ts: Date.now() }, entry)
    });
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch (e) {}
}
