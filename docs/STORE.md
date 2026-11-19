# 上架材料与权限说明

## 权限表（逐条对应功能，没有"预留"权限）

| 权限 | 为什么需要 | 对应的代码位置 |
| --- | --- | --- |
| `storage` | 保存标签页资源图（session）、下载历史（local）、设置（sync） | `bg/persist.js`、`bg/history.js`、`bg/settings.js` |
| `downloads` | 把识别到的资源保存到本地、跟踪下载进度与结果 | `service/background.js`、各下载器 |
| `webRequest` | 旁路观察媒体请求（只读，不修改请求） | `service/background.js` 的 `onBeforeRequest` |
| `webNavigation` | 区分"换页"与"同页新资源"，避免旧资源的卡片残留 | `bg/attribution.js` |
| `tabs` | 把资源与标签页对应起来、读取标题与图标 | `service/background.js` |
| `sidePanel` | 主界面就是侧边栏 | `sidepanel/` |
| `scripting` | 在用户点击时补扫图片/文本（页面加载后才注入） | `sidepanel/modules/image_tab.js`、`text_tab.js` |
| `declarativeNetRequest` | 为部分 CDN 补 Referer/Origin，否则下载被 403（规则只作用于媒体域名）；整页快照抓取被 403 拒绝时，临时给扩展自己发出的请求补页面 Referer 再试一次（用完即删） | `service/background.js` 的 `initRefererRules`、`bg/archive-fetch.js` |
| `offscreen` | 把耗时的拉流与拼装搬到后台文档里执行，关闭侧边栏不再中断下载 | `bg/offscreen.js`、`offscreen/` |
| `host_permissions: <all_urls>` | 站点适配器与资源嗅探需要读取任意站点；无法预先枚举 | 全站 |

已移除：`unlimitedStorage`（本扩展不写大体积本地数据，属于无必要权限）。

## 数据流（给审核看的版本）

1. `webRequest` 只**读**请求元信息（URL、类型、状态码、Content-Length），不读请求体。
2. 内容脚本采集页面里的**公开数据**（内联播放器 JSON、DOM 里媒体元素的地址）。
3. 一切解析在本地完成；**没有任何出网请求指向本扩展自己的服务器**（不存在这样的服务器）。
4. 下载由 `chrome.downloads` 发起，与用户手动"另存为"等价。

## 内容脚本注入说明

- 隔离世界：`content/inpage_overlay.js`、`extractor.js`、`text_unlocker.js`、
  `page_archiver.js`、`hook_bridge.js`（`document_start`）。
  其中 `page_archiver.js` 只在用户点「保存为单文件 HTML」时被调用（一次 `tabs.sendMessage`），
  它自身不监听页面事件、不发网络请求。
- 主世界（`world: MAIN`）：`content/page_hooks.js`，做三类旁路记录：
  `performance` 资源条目里的媒体地址、`MediaSource` 的 mimeType、`appendBuffer` 的前 16 字节。
  **不替换 `fetch` / `XMLHttpRequest`**（只读 `PerformanceObserver`），不修改任何请求与数据；
  录制必须由用户在侧边栏显式点击才开始。
  另有一项用户显式触发的动作：点"解除网页限制"时，它按内容脚本的指令把页面自己挂在
  `window`/`document` 上的复制拦截处理器清空——不注入任何 `<script>`（严格 CSP 的站点会拦掉）。

## 已知限制（如实披露）

1. 引擎下载（HLS / DASH / 合流）优先交给后台 offscreen 文档构建，关闭侧边栏不会中断；
   若当前环境不支持 offscreen，会自动回退到侧边栏执行（此时关闭侧边栏会中断）。
   直播录制仍在侧边栏内，需要保持面板打开。
2. MSE 录制是"边播边录"：没有播放过的片段录不到；缺少初始化段时会明确提示可能无法播放。
3. 直播录制只支持 HLS（m3u8），且从点击时刻开始。
4. 不处理 DRM（Widevine / PlayReady / FairPlay / SAMPLE-AES），检测到即报错。
5. 整页快照：Shadow DOM、`<template>` 内容、画布、音视频流不内联（音视频保留在线地址）；
   跨域 iframe 依赖子框架内容脚本，拿不到时保留原地址。默认会移除隐藏元素（`display:none`）
   与未使用的样式/字体以减小体积，可在快照面板逐项关掉。超预算时只降级为"保留在线地址"，
   不会生成打不开的文件。详见 [ARCHIVE.md](ARCHIVE.md) §8。

## 上架前检查清单

- [x] 每个权限都有对应功能（见上表），无预留权限
- [x] 隐私说明 [PRIVACY.md](PRIVACY.md)
- [x] 无远程代码执行、无 `eval`、无外部脚本（`script-src 'self'`）
- [x] 图标齐全（16/32/48/128）
- [x] 单一用途说明：识别并下载网页里的资源（媒体文件，以及"整页存为单文件 HTML"这一种存档形态）
- [ ] 商店截图与演示视频（需要人工录制）
- [ ] 开发者账号与打包（`npm run build` 产出 `out/ResourceHelper`）
