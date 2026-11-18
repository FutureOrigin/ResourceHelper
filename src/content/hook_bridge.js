/**
 * 主世界钩子 <-> 扩展的桥（P5）
 *
 * 页面主世界（page_hooks.js）只能通过 window.postMessage 对外说话；
 * 内容脚本在隔离世界，收消息后转给后台。这里只做转发与过滤。
 */
(function initHookBridge() {
  const MARK = '__resourceHelperHooks';
  if (window.__rhBridgeInstalled) return;
  window.__rhBridgeInstalled = true;

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[MARK] !== true || !data.kind) return;

    try {
      // 录制分片直接广播给侧边栏（它才是装配方），不进后台，避免多一次大对象拷贝
      if (data.kind === 'mse-chunk') {
        const result = chrome.runtime.sendMessage({
          type: 'RH_RECORD_CHUNK',
          mimeType: data.mimeType,
          seq: data.seq,
          b64: data.b64
        });
        if (result && typeof result.catch === 'function') result.catch(function () {});
        return;
      }

      if (data.kind === 'record-started' || data.kind === 'record-stopped') {
        const state = data.kind === 'record-started' ? 'started' : 'stopped';
        const result = chrome.runtime.sendMessage({ type: 'RH_RECORD_STATE', state: state, bytes: data.bytes });
        if (result && typeof result.catch === 'function') result.catch(function () {});
        return;
      }

      const sent = chrome.runtime.sendMessage({ type: 'ON_HOOK_EVENT', event: data });
      if (sent && typeof sent.catch === 'function') sent.catch(function () {});
    } catch (e) {}
  });

  // 侧边栏的录制指令 -> 页面主世界
  try {
    chrome.runtime.onMessage.addListener(function (message) {
      if (!message || message.type !== 'RH_RECORD_COMMAND') return;
      const action = message.action === 'stop' ? 'stop-record' : 'start-record';
      try {
        window.postMessage({ [MARK]: 'cmd', action: action }, '*');
      } catch (e) {}
    });
  } catch (e) {}

  // 握手：告诉主世界"桥已就位"，让它把之前记下的事件补发过来
  try {
    window.postMessage({ [MARK]: 'ready' }, '*');
  } catch (e) {}
})();
