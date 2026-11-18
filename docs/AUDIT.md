# 历史审计 · 问题清单与证据（v1.0.0）

> **这是历史快照，不是现状。** 本文记录开源化初期（2026-11-17，v1.0.0）的 57 项问题与实测证据，
> 其中绝大多数已在 P0–P8 修复，保留作为可追溯的审计记录。
> 当前架构请看 [ARCHITECTURE.md](ARCHITECTURE.md)；路线与验收标准看 [ROADMAP.md](ROADMAP.md)。
> 文中提到的早期开发日志与第三方参考包**已不在仓库中**（不再是本项目的依赖或对照物）。

> 审计对象：`out/ResourceHelper/`（v1.0.0，MV3，13 个 JS 文件 / 约 3.9k 行）
> 注：P0.1 起源码目录为 `src/`，`out/ResourceHelper/` 改为 `npm run build` 的产物；下列行号对应首次审计时的文件内容，与 `src/` 逐字节一致。
> 行为基线：同类开源实现（cat-catch、yt-dlp）的黑盒行为对照（未复制任何代码）
> 审计方式：逐文件静态走查 + 2 个可复现探针（§6）+ API 清单核查
> 日期：2026-11-17

---

## 0. 结论摘要

当前实现是一个**能装能跑、但会在用户不知情时产出错误结果**的 MVP。三个最贵的问题都不是"缺功能"，而是"给错东西"：

1. **无声视频**：所有音画分离源（YouTube 1080P+、B 站全部分辨率）下载出来只有画面没有声音 —— 因为"视频轨"和"音频轨"被当成两个独立资源，而 `audioUrl` 是空串，配对逻辑永不触发。
2. **改名视频**：音频页的"提取 MP3"实际是把**视频轨的 URL 原样下载、然后改后缀为 .mp3**；全仓没有任何转码代码（WASM 在 Phase 3 已被物理删除，但 UI 和文档仍在宣传）。
3. **结构性损坏的 MP4**：`media_muxer.js` 的"合流"只是把 `ftyp + moov + mdat` 拼起来、再塞进另一条 `trak`，**没有重写 `stco` 采样偏移**。已实测：输出里视频轨偏移早 112 字节、音频轨早 1144 字节。

再加一个"慢性毒药"：**Service Worker 里只有内存 Map**（全仓 `chrome.storage` 命中 0 次），MV3 worker 空闲 30 秒即回收，资源清单**每次都会清零**。

### 关键数字

| 指标 | 现状 |
|---|---|
| 资源发现手段 | 2 种：`webRequest` 的 URL 后缀/18 个域名短语 + 5 个硬编码站点解析器 |
| 资源身份 | 32 位整数哈希（实测 9.1 万真实 URL 规模即碰撞，后到者覆盖先到者） |
| 状态持久化 | 0（storage / IndexedDB / offscreen / alarms / contextMenus 均未使用） |
| 转码/合流 | 0（无 wasm、无 worker；合流实现不正确） |
| 断点续传 | 无 |
| DASH（.mpd） | 只发现、不解析、不下载（下到的是一个 XML） |
| 测试覆盖 | 1 个文件，仅覆盖 `extractor.js` 的内联 JSON 解析 |
| i18n | `i18n.js` 模块存在但 0 处 import；UI 全硬编码中文 |
| HTML 注入面 | 26 处 `innerHTML` 拼接页面可控的 title/alt/src |

---

## 1. "资源一一对应"的五条不变量

后面每个问题都会标注它破坏了哪一条。这是路线图里所有改造的验收骨架。

| 编号 | 不变量 | 含义 | 现状反例 |
|---|---|---|---|
| **I1 身份唯一** | 每条资源有稳定、无碰撞的身份键 | 规范化 URL + 内容指纹 | 32 位哈希碰撞 → B 覆盖 A（B1） |
| **I2 逻辑唯一** | 一条视频 = 一张卡片，画质是子项 | 变体/镜像/分片挂在父节点下 | YouTube 6 个 itag = 6 张同名卡（B2） |
| **I3 依赖闭合** | 能播放才算资源；缺依赖就标"不完整" | 播放列表→分片、视频轨→音轨、init segment | 1080P 卡片可点、可下、无声（A3/D1） |
| **I4 归属确定** | 资源知道自己在哪个标签页/文档/框架/导航代次/播放器上 | tabId + documentId + frameId + generation | 找不到就"随便挑第一条"（B5） |
| **I5 保真** | 扩展名/大小/时长/DRM 来自观测（字节或响应头），不靠猜 | 魔数嗅探 + Content-Length/Disposition | 视频字节存成 .mp3（A5） |

---

## 2. 宣称 vs 实际（文档失真表）

早期开发日志（已移出仓库）与代码互相矛盾：Phase 3 把 Phase 1/2 的能力物理删除了，但日志仍在描述它们。**新贡献者按旧文档读代码必然迷路**。

| 文档宣称 | 当前代码实际 | 判定 |
|---|---|---|
| §12 直通内嵌 libav wasm 提音 / 无损转 MP3 | `download_worker/` 已删除；`audio_only` 只是换个 URL 和扩展名 | 不成立 |
| §12/§21 5 路并发 + 按序拼装 + 完整可播放 MP4 | 并发在；拼装在内存 Blob 里做，长视频必 OOM；无 headers/cookie，大量站点 403 | 半成立 |
| §13 彻底接管 Popup 与 Side Panel | `default_popup` 与 `side_panel` 同时声明，运行时又 `setPopup()` → 点图标永远弹 popup | 半成立 |
| §17 100% 原生 SW 替代 | 是原生的，但状态零持久化，MV3 冷启动即失忆 | 半成立 |
| §18 YouTube 分块穿透 + itag 特征库 | range 剥离与 itag 表在，但**视频轨不与音频轨配对**，1080P 必出无声文件 | 关键缺口 |
| §19 DRM 状态透明反馈 | 只在 v.qq.com 读 `video.mediaKeys`，其他站点靠猜 | 半成立 |
| §20 音乐平台全链路捕获 | 靠 `<audio>` + 8 秒轮询；MSE/WebAudio 播放器捕不到 | 半成立 |
| §16 彻底物理剥离专有代码 | 属实，`out/` 内已无 VDH 业务代码残留 | 成立 |

---

## 3. 问题清单

本清单共 **57 项**：数据正确性 8、识别与归属 9、状态生命周期 6、下载引擎 10、性能 9、安全合规 7、工程质量 8。其中 **P0（不修就会继续产错文件）10 项**：A5、B5、C3、C4、C5、F1、F7、G1、G2、G8。

### A. 数据正确性（会让用户拿到坏文件）

| ID | 问题 | 证据 | 影响 | 修复方向 | 阶段 |
|---|---|---|---|---|---|
| A1 | 合流 MP4 未重写 `stco/co64`，moov 变长后 mdat 位移，两条轨偏移全错 | `media_muxer.js:150-196`；探针实测 delta = +112 / +1144 字节 | 输出不可播放 | 换 mp4box.js 做 remux，或按新布局重算 chunk offset | P3 |
| A2 | 无 `moov` 时（fMP4 分片）直接 `new Blob([videoBuf, audioBuf])` 首尾拼接 | `media_muxer.js:103` | 两个 MP4 拼成一个非法文件 | fMP4 级 remux（保留 moof/tfdt，重排 mfhd） | P3 |
| A3 | itag 137/248 等"视频轨"被当成完整媒体，`qualities[0].audioUrl` 为空串 | `background.js:118-129` | 1080P/4K 下载 = 无声 MP4 | 配对引擎：视频轨必须绑定音轨，否则标 `incomplete` | P2/P3 |
| A4 | B 站每个分辨率单独成卡，音频轨又是另一张卡（`bili_audio_main`） | `extractor.js:446-470, 478-499` | 点"1080P"永远拿不到声音 | 按 `bvid` 聚合，`qualities[i].audioUrl` 指向最高音质轨 | P2 |
| A5 | `audio_only` 无音轨时回退到视频 URL，扩展名强制 `.mp3` | `background.js:594-603` | 视频字节存成 .mp3，播放器拒播 | 无音轨则拒绝并提示；要转码才允许叫 MP3 | P0 |
| A6 | 容器/编码与扩展名脱钩：`.m4s` 分片、HEVC、fMP4 一律标 `mp4` | `background.js:141-151` | 下完还要二次改名/转封装 | 魔数嗅探 + Content-Type 决定性判定（I5） | P2 |
| A7 | 文件名取自 `document.title`，同一视频不同清晰度得到完全相同的名字 | `background.js:598-603` | 下载目录一堆同名文件 | 命名模板 + 质量后缀 + `conflictAction: uniquify` | P6 |
| A8 | M3U8 只用 `BANDWIDTH` 挑最高档，忽略用户选择与 `RESOLUTION` | `stream_downloader.js:15-35` | 可能选到"高码率低分辨率" | 解析全部变体交给画质选择器 | P3 |

### B. 资源识别与归属（重复、错配、丢失）

| ID | 问题 | 证据 | 影响 | 修复方向 | 阶段 |
|---|---|---|---|---|---|
| B1 | 身份键 = 32 位累加哈希，实测 9.1 万 URL 即碰撞；`Map.set` 静默覆盖 | `background.js:48-56, 220`；探针：`klt.mp4?token=338023` ≡ `1yis.mp4?token=107` | 资源凭空消失且用户不知 | 规范化 URL 做键 + SHA-256 内容指纹做二级去重 | P1 |
| B2 | 一条视频的每个 itag/清晰度都成了独立资源卡 | `extractor.js:324-352`、`background.js:106` | 列表 8 条同名视频，用户无法判断 | 图模型：MediaNode + variants[]（I2） | P1 |
| B3 | 同一轨被 `range` 分 40+ 次请求 → 40 个不同 URL | `parseYouTubePlayback` 每次新建 hash（靠 itag 侥幸去重），其他站点无此幸运 | 一般站点列表爆炸 | 内容指纹（clen+etag+首片哈希）折叠 range 变体 | P2 |
| B4 | 仅按 `tabId` 归属，无 `documentId/frameId/generation` | `background.js:407-420` | iframe 广告里的视频混进主页面列表；同页多播放器无法区分 | 采集 `details.documentId`（Chrome 106+）+ webNavigation 代次 | P1 |
| B5 | 找不到 hash/URL 时"取 Map 第一条"兜底 | `background.js:524-526` | **静默下载错误的视频** | 删兜底，返回明确错误让用户重选 | P0 |
| B6 | 悬浮胶囊视频↔资源匹配：先精确比 URL，失败就取"列表第一条视频" | `inpage_overlay.js:594-614` | 多视频页面永远下错 | blob → MSE → SourceBuffer → 分片归属链；不确定就显式提示 | P5 |
| B7 | SPA 路由切换不清理（`onBeforeNavigate` 不覆盖 pushState） | `background.js:475-483` | 看第 2 个视频时列表是第 1 个的流 | 监听 `onHistoryStateUpdated`，按代次分组而非删除 | P1 |
| B8 | `.ts` / `.m4s` 一律丢弃 → 只有 .ts 的站点（部分 HLS/直播）得到空列表 | `background.js:154` | 整站不可用 | 只丢"已归属到某播放列表的分片"，而非按后缀丢 | P2 |
| B9 | 图片扫描不区分内容图与 UI 图标/头像/表情 | `extractor.js:185-188`（只滤 1×1） | 一页 300 张图，信噪比极低 | 尺寸 + 面积占比 + 是否在视口 + srcset 权重 | P2 |

### C. 状态与生命周期

| ID | 问题 | 证据 | 影响 | 修复方向 | 阶段 |
|---|---|---|---|---|---|
| C1 | 资源清单只存于 SW 内存 Map，MV3 空闲 30s 回收即清零 | `background.js:7`；全仓 `chrome.storage` 命中 0 次 | 切个标签页回来就"没有资源" | `chrome.storage.session` 防抖快照（10MB，不落盘） | P1 |
| C2 | 下载引擎跑在**侧边栏文档**里；侧边栏一关任务静默死亡 | `video_tab.js:262-360`、`stream_downloader.js` | 长任务必中断，无错误提示 | 迁到 offscreen document（`reasons: ['BLOBS','WORKERS']`） | P3 |
| C3 | `chrome.sidePanel.open()` 在消息回调里调用（无用户手势） | `background.js:545, 570` | 必然 reject 且被 `.catch(() => {})` 吞掉 | 只在 UI 事件里调，或改 `openPanelOnActionClick` | P0 |
| C4 | `default_popup` 与 `side_panel` 并存 + 运行时 `setPopup()` | `manifest.json:12`、`background.js:677-679` | 点图标开的是 popup，侧边栏入口形同虚设 | 二选一：删 `default_popup` 走纯侧边栏（推荐） | P0 |
| C5 | `commands.default-action`（Alt+Down）无 `chrome.commands.onCommand` 监听 | `manifest.json:23-31` | 快捷键是死的 | 补监听或删声明 | P0 |
| C6 | 每个 `VideoOverlay` 实例各挂一个 `document.click` 与 `window.resize`，`destroy()` 不解绑 | `inpage_overlay.js:383-390, 541-548` | 无限滚动页面内存与 CPU 持续上涨 | 全局单例事件委托 + 显式解绑 | P1 |

### D. 下载引擎

| ID | 问题 | 证据 | 影响 | 修复方向 | 阶段 |
|---|---|---|---|---|---|
| D1 | 分片/整片全部累积在内存 `Blob` 再交给 `chrome.downloads` | `stream_downloader.js:94, 168`、`media_muxer.js:75-81` | 1 小时视频 ≈ 1–2GB 常驻内存 → 标签页崩溃 | 流式写盘（File System Access）+ 有界缓冲 | P3 |
| D2 | `fetch()` 未带 `credentials: 'include'`，也无 Referer/Origin/Cookie 注入 | `stream_downloader.js:8`；全仓 `credentials:` 命中 0 次 | 需要登录态的 CDN 一律 403 | 站点级头策略 + 复用从 webRequest 学到的真实头 | P3 |
| D3 | 采到的真实请求头存进 `media.headers`，**从未被使用** | `background.js:198` 采集；`529-628` 下载路径不读 | 白采，也解释了为何必须靠全局 DNR 兜底 | 下载时优先用该资源的原始头 | P3 |
| D4 | HLS 解析不完整：单 `#EXT-X-KEY`、忽略 `#EXT-X-BYTERANGE`、`#EXT-X-MEDIA` 音轨组、多段 `#EXT-X-MAP`、`DISCONTINUITY` | `stream_downloader.js:38-66` | 真实 HLS 源解析错位 → 花屏/音画不同步 | 用 hls.js 的 playlist-loader（Apache-2.0） | P3 |
| D5 | DASH（`.mpd`）零解析 | `background.js:156` 仅识别为 `mpd_stream` | 国际站点主流协议不可用 | mpd-parser / 自研 SegmentTemplate + Timeline | P3 |
| D6 | 无断点续传，重试固定 2 次，无并发自适应 | `stream_downloader.js:108-136` | 弱网中断 = 全部重来 | 分片位图 + IndexedDB + AIMD 并发 | P4 |
| D7 | 无大小/码率/ETA 预估 | 全仓无 HEAD / Content-Range 探测 | 用户不知道要下多大、等多久 | Range 探测 + 实测速率 | P2 |
| D8 | 进度语义分裂：m3u8/mux 路径发的 `dlId` 与 `downloads.onChanged` 的真实 id 不同命名空间 | `video_tab.js:282-299`、`background.js:615-617` | 悬浮胶囊进度条经常不动 | 统一 TaskId 贯穿 UI/引擎/SW | P3 |
| D9 | 直播（滚动 m3u8）无录制能力，最多存下 6KB 索引 | 无 playlist 轮询逻辑 | 直播场景完全不可用 | `chrome.alarms` 轮询 + 序列号去重 + 时长上限 | P7 |
| D10 | DRM 判定分散且不完整 | `extractor.js:527`、`stream_downloader.js:73-75` | 用户点下去才失败，文案像 bug 不像限制 | EME 钩子 + MPD `ContentProtection` + HLS KEY 三路合判 | P5 |

### E. 性能

| ID | 问题 | 证据 | 影响 | 修复方向 | 阶段 |
|---|---|---|---|---|---|
| E1 | `webRequest` 监听器不限 `types`，且同时挂 `onSendHeaders` 与 `onHeadersReceived` | `background.js:395-460` | 每个 js/css/字体/图片请求都进 JS 回调 | `types: ['media','xmlhttprequest','object','other']` + 单次 `onBeforeRequest` | P1 |
| E2 | 每个请求跑 1 个正则 + 18 次 `String.includes` | `background.js:12-31, 407` | 单请求约 0.8µs（实测），量大即无谓开销 | host 白名单 Set + 单条预编译正则（O(1) 查表） | P1 |
| E3 | 每条新媒体都 `await chrome.tabs.get()`，且每次触发全量列表重取 | `background.js:99, 166`；`main.js:124-127` → `fetchMediaFromService` | N 条发现 = N 次 IPC + N 次 O(N) 重渲染 → O(N²) | 标题缓存（tabs.onUpdated 维护）+ 150ms 合并的增量 delta | P1 |
| E4 | 图片扫描对 `div/section/article/header/a/figure` 逐个 `getComputedStyle`，并对整棵 DOM 做 `querySelectorAll('*')` 找 ShadowRoot | `extractor.js:142-162` | 大页面单次扫描数百毫秒，强制样式+布局重算 | 解析 `document.styleSheets` 的 `cssRules` 取 url()（零布局）；仅对视口内元素回退 computed style | P2 |
| E5 | `dynamicNetworkImages` 是无界 Set，永不清理 | `extractor.js:10` | 长会话内存单调增长 | 上限 + LRU（保留最近 2000 条） | P2 |
| E6 | 每帧每页跑 `setInterval`：8s 音频扫描（全站）、3s/6s URL 检查（B 站/腾讯） | `extractor.js:515, 558, 647` | 电池与 CPU 隐形成本，`all_frames: true` 放大 N 倍 | 事件驱动（play/loadedmetadata/history），删轮询 | P2 |
| E7 | 悬浮层把 `position:relative` 写进宿主页面，每次定位都 `getBoundingClientRect` | `inpage_overlay.js:325, 335-347` | 触发宿主布局抖动 | IntersectionObserver + transform 定位，不改宿主样式 | P2 |
| E8 | 图片网格为每张图渲染 `<img src>`，等于把整页图片再拉一遍 | `image_tab.js:314-337` | 首屏卡顿、流量翻倍 | 虚拟列表 + lazy + 缩略图缓存 | P2 |
| E9 | 在 `webRequest` 回调里 `await`（`chrome.tabs.get`） | `background.js:398-420` | 回调结束后 worker 可能被判空闲而终止，尾部逻辑丢失 | 回调内只做同步入队，异步 flush | P1 |

### F. 安全与合规

| ID | 问题 | 证据 | 影响 | 修复方向 | 阶段 |
|---|---|---|---|---|---|
| F1 | 26 处 `innerHTML` 拼接页面可控字段 | `video_tab.js:146-179`、`image_tab.js:314-337`、`audio_tab.js:140-180` | HTML 注入破坏 UI（CSP 挡住了脚本执行） | 统一 `textContent` / `el()` 构造器 | P0 |
| F2 | 8 条 DNR 规则全局生效、`urlFilter` 只按域名片段匹配、每次启动删光全部动态规则后重加 | `background.js:258-390` | 篡改所有站点的 Referer/Origin；与其他动态规则冲突 | 加 `initiatorDomains` 作用域 + 只增删自己的 id 段 + 用户可关 | P3 |
| F3 | `<all_urls>` 静态注入 + `all_frames` + 3 个脚本 + `document_idle` | `manifest.json:41-52` | 商店审核风险（单一用途），每个 iframe 都跑一遍 | 拆最小注入集 + 按需 `executeScript` + `optional_host_permissions` | P7 |
| F4 | 声明 `unlimitedStorage`/`tabs` 却无对应实现 | `manifest.json:62-73` | 过度授权无收益 | 随能力补齐或删除 | P7 |
| F5 | 内联 `<script>` 做"主世界解锁"，被严格 CSP 站点静默拦截 | `text_unlocker.js:96-114` | 在 GitHub/微信等站点无声失效 | `executeScript({world:'MAIN'})` | P6 |
| F6 | 解锁器在捕获阶段拦 `keydown` 的 Ctrl+C/A/X/U/S，且不区分输入框 | `text_unlocker.js:62-68` | 页面内输入框的全选/复制被破坏 | 仅在非 input/textarea 时拦截 | P6 |
| F7 | 文档仍在宣传已删除的能力（见 §2） | 早期开发日志 | 误导贡献者与用户 | 移出仓库 + 新增 `ARCHITECTURE.md` | P0 |

> **已修复（P6 · F5）**：解锁不再往页面里插内联 `<script>`。
> 主世界那一半搬进了本就声明为 `world: "MAIN"` 的 `content/page_hooks.js`，
> 由内容脚本 `postMessage` 一条 `unlock-text` 指令触发（注入时零副作用）；
> 侧边栏兜底的 `executeScript` 也补上了 `world: "MAIN"`。
> 守卫：`test/unit/text-unlocker.test.mjs`，其中一条是"全仓不得 `createElement('script')`"。
> F6（输入框豁免）仍未处理。

### G. 工程质量

| ID | 问题 | 证据 | 影响 | 修复方向 | 阶段 |
|---|---|---|---|---|---|
| G1 | 无 `package.json`/构建/打包；`out/` 既是产物又是源码 | 仓库根只有 2 个 md + out/ | 依赖（mp4box/hls.js/mux.js）根本引不进来 | `src/` + esbuild + `dist/` + `tools/build.mjs` | P0 |
| G2 | 测试只覆盖 `extractor.js` 的内联 JSON 解析 | `test/bilibili-extract.test.mjs` | 合流/HLS/配对/归属零覆盖 → 上一轮的 mux bug 从未被发现 | node:test 单测 + Playwright 加载扩展的 e2e + 站点语料基线 | P0 |
| G3 | `i18n.js` 存在但 0 处引用；`_locales/zh_CN` 只有 13 个键 | `sidepanel/modules/i18n.js` | 无法国际化，文案散落 | 统一 `t()` + 抽全量 key | P6 |
| G4 | 重复逻辑：图片扫描在 `extractor.js` 与 `image_tab.js` 各写一遍；解锁在 `text_unlocker.js` 与 `text_tab.js` 各写一遍且参数不一致 | `image_tab.js:153-216`、`text_tab.js:145-196` | 任何修复都要改两处，必然分叉 | 单一实现 + 薄 fallback | P2 |
| G5 | 站点逻辑硬编码在 `extractor.js`（YouTube/B 站/腾讯/网易/QQ 五套 if 分支） | `extractor.js:294-650` | 加一个站点 = 改核心文件 + 发版 | 声明式站点适配器（`sites/*.json`） | P4 |
| G6 | `background.js` 682 行混合抓包/分类/命名/DNR/消息/下载 6 种职责 | `service/background.js` | 任一职责都无法单测 | 拆模块（capture/classify/pair/engine/persist） | P1 |
| G7 | 几乎全部 `catch (e) {}` 静默吞异常 | 例：`background.js:103, 229, 238, 487` | 线上问题不可诊断 | 分级 `log()` + 环形缓冲 + 设置页可导出 | P1 |
| G8 | 缺 README / ARCHITECTURE / CHANGELOG，只有两份开发日志 | 仓库根 | 新用户无法上手，新贡献者无法定位 | 补齐三件套 | P0 |

---

## 4. 问题 → 阶段映射（用于排期）

| 阶段 | 承载问题 | 目标 |
|---|---|---|
| P0 | A5, B5, C3, C4, C5, F1, F7, G1, G2, G8 | 止血：不再产错文件，工程能承载后续改造 |
| P1 | B1, B2, B4, B7, C1, C6, E1, E2, E3, E9, G6, G7 | 身份与状态：一一对应的地基 |
| P2 | A3, A4, A6, B3, B8, B9, D7, E4, E5, E6, E7, E8, G4 | 准确性与性能 |
| P3 | A1, A2, A7, A8, C2, D1, D2, D3, D4, D5, D8, F2 | 下载引擎重写 |
| P4 | D6, G5 | 泛用性与断点续传 |
| P5 | B6, D10 | 深度抓取与归属 |
| P6 | F5, F6, G3 | 产品化 |
| P7 | D9, F3, F4 | 规模化与合规 |

---

## 5. 值得保留的资产（重构时不要推倒重来）

1. **`sliceBalancedJson` 括号配对扫描器**（`extractor.js:221-283`）+ 那个 389 行的回归测试 —— 全仓唯一"踩过坑并留下证据"的地方，是后续"页面状态探针引擎"的基石。
2. **Shadow DOM 递归遍历**的思路（`extractor.js:158-162`），只需从"每次全量"改成"按需 + 视口"。
3. **悬浮胶囊的 Shadow DOM 隔离 + 防误触透明层**（`inpage_overlay.js:15-258`）—— 设计是对的，缺的是归属与生命周期。
4. **正文提取的评分函数**（长度 + 段落数×80 − 链接数×40，`text_unlocker.js:169`）—— 简单有效，参数化后可进规则表。
5. **侧边栏模块化拆分**（bus / tab / downloader / muxer）—— 边界基本正确，只需把引擎搬出 UI 上下文。
6. **DNR 注入 Referer 的思路** —— 方向正确，需加作用域与可配置。

---

## 6. 已验证证据（可复现）

两个探针脚本放在 `test/probes/`，无需浏览器，`node` 直接跑。

### 6.1 MP4 合流器偏移错误

> **已修复（P3）**：合流改为采样级重排，两条轨的 stco/co64 都按新布局重写，
> 有字节级单测与探针双重覆盖。探针换代成为 `test/probes/remux-offsets.probe.mjs`：
> 验证 stco 指向的字节确实属于对应轨道（视频 0xAA / 音频 0xBB）。
> 下列数据保留为缺陷的历史证据。

`node test/probes/mp4-muxer-offset.probe.cjs`（已移除，逻辑被新探针覆盖）

构造两个结构合法的最小 MP4（`ftyp + moov(trak:tkhd+stco) + mdat`），喂给 `mediaMuxer.muxMp4Containers`，再用它自己的 `parseBoxes` 读回：

~~~
video stco[0] = 256   audio stco[0] = 256        (输入文件里的真实 mdat 数据偏移)
output: ftyp@0+20, moov@20+340, mdat@360+1032, mdat@1392+520
actual video mdat data offset = 368   -> delta +112   (偏移指向 moov 尾部)
actual audio mdat data offset = 1400  -> delta +1144  (偏移指向视频数据中间)
~~~

结论：**两条轨的每一个采样点都指向了错误位置**。原因是 `newMoov = vMoov + audioTrak` 让 moov 变长、mdat 整体后移，而 `stco` 未重写；音频轨的 `stco` 还保留着"相对音频原始文件"的偏移。

### 6.2 32 位哈希碰撞

> **已修复（P1.1）**：身份改为"规范化 URL 即键"，短 ID 仅用于显示。
> 探针换代成为 `test/probes/identity-collision.probe.mjs`，验证 40 万 URL 零碰撞、
> 同轨不同 range 正确折叠；下列数据保留为缺陷的历史证据。

`node test/probes/hash-collision.probe.cjs`（已移除，逻辑被 §6.2 新探针覆盖）

~~~
91,396 个不同 URL → 找到碰撞（耗时 63ms）
res_d13ach == https://cdn0.example.com/media/klt.mp4?token=338023
           == https://cdn4.example.com/media/1yis.mp4?token=107
~~~

`addDiscoveredMedia` 用 `Map.set(hash, media)` 存，后到的**静默覆盖**先到的：用户少看到一条资源，且那条资源再也无法被下载。

### 6.3 API 使用清单核查

| 能力 | 需要的 API | 现状 |
|---|---|---|
| 状态持久化 | `chrome.storage.session` / IndexedDB | 未使用 |
| 长任务托管 | `chrome.offscreen` | 未使用 |
| 直播轮询 | `chrome.alarms` | 未使用 |
| 右键菜单 | `chrome.contextMenus` | 未使用 |
| 快捷键 | `chrome.commands.onCommand` | 声明了但无监听 |
| 流式写盘 | `showSaveFilePicker` / OPFS | 未使用 |
| 认证请求 | `fetch(url, {credentials:'include'})` | 未使用 |
| 主世界注入 | `executeScript({world:'MAIN'})` | `content/page_hooks.js` 声明式注入 + 侧边栏兜底 `executeScript({world:'MAIN'})` |
| 请求归属 | `details.documentId` / `frameId` / `initiator` | 仅用 `tabId` |

---

## 7. 一句话总结

它的问题不是"功能不全"，而是**没有"资源"这个概念**：只有一串 URL 字符串和一堆 if 分支。改造的核心不是加功能，而是先立起"I1–I5 五条不变量 + 资源图"这个骨架，其余功能才有地方长。