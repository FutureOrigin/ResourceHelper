# 架构（v1.1.0 现状）

> 本文描述**现在**的代码。目标架构见 [ROADMAP.md](ROADMAP.md) §1；
> 已知缺陷与证据见 [AUDIT.md](AUDIT.md)。两者不一致的地方，一律以代码为准。

---

## 1. 运行时组成

~~~
┌──────────────────────────────────────────────────────────────────────┐
│ Side Panel  src/sidepanel/**                                         │
│   index.html · main.js（路由/标签切换）· style.css                    │
│   modules/bus.js          消息总线、格式化、toast                      │
│   modules/video_tab.js    视频列表/下载/进度（含 m3u8、mux 入口）       │
│   modules/audio_tab.js    音频列表/试听/音轨提取                       │
│   modules/image_tab.js    图片网格/多选/批量下载                       │
│   modules/text_tab.js     解禁/正文提取/导出 Markdown                  │
│   modules/font_text_decode.js  字体反爬还原（查内置字形指纹表）         │
│   modules/stream_downloader.js  M3U8 分片并发下载与拼装               │
│   modules/media_muxer.js       音画双轨拉取与 MP4 盒拼接（有缺陷）      │
│   modules/page_tab.js          整页快照 UI（选项 / 进度 / 结果卡）      │
│   modules/page_archive.js      整页快照流水线（注入 I/O，可单测）       │
├──────────────────────────────────────────────────────────────────────┤
│ Service Worker  src/service/background.js（type: module）             │
│   webRequest 监听 → parseMediaUrl/parseYouTubePlayback → 内存 Map     │
│   RH_GET_MEDIA / RH_DOWNLOAD / 进度广播 / DNR 规则 / 入口与命令         │
│   RH_ARCHIVE_FETCH / RH_ARCHIVE_FRAMES（整页快照的抓取与 frame 枚举）   │
│   ↑ 引入 src/core/decision.js（纯决策，可单测）                        │
├──────────────────────────────────────────────────────────────────────┤
│ Content Scripts（all_frames, document_idle）                          │
│   content/extractor.js      图片深挖 + 页面数据采集（内联 JSON / DOM 媒体） │
│   content/inpage_overlay.js <video> 上的悬浮下载胶囊（Shadow DOM）      │
│   content/text_unlocker.js  解禁 + 语义正文提取 + 私用区码位映射        │
│   content/page_archiver.js  整页快照：克隆 DOM、登记资源、iframe 打标   │
└──────────────────────────────────────────────────────────────────────┘
~~~

## 1.1 正文去字体加密（字体反爬）

部分站点不禁用复制，而是把常用字换成私用区码位（U+E000–U+F8FF），再用一份
随机命名的子集字体把码位画成真字。页面上完全正常，复制/提取出来却是「看不见的字」——
**这种情况解禁 CSS 与事件没有任何用**，只能换字。

~~~
content/text_unlocker.js
  私用区码位统计 → 定位含码位的文本节点 → 读 computed font-family
  → 回到 @font-face 取 .otf/.woff 地址，随提取结果一起交给侧边栏
        │
        ▼
sidepanel/modules/font_text_decode.js
  取内置指纹表 data/glyph-table.bin（约 170 KiB，按需加载）
  → 下载页面自己声明的那份字体（一次请求，不带凭据）
  → core/font-deobfuscate.js：cmap 拿 码位→GID → core/font-glyph.js 解释 Type2
    charstring 得轮廓 → 64 位 FNV-1a 指纹 → 查表得真字
        │
        ├─▶ 正文里的码位被替换成真字
        └─▶ 映射回推给页面，Ctrl+C 也直接得到正常文字
~~~

指纹表由 `tools/build-glyph-table.mjs` 从思源黑体（SourceHanSansSC-Normal 2.002）
生成，覆盖可打印 ASCII + GBK 全部字符；建表与查表复用同一份轮廓解析代码，
所以只要站点用的还是这一族参考字体，还原就是**逐字精确**的（对不上就报错，不猜）。

**没有** offscreen document、没有持久化、没有构建期打包（源码即产物，经 `tools/build.mjs` 复制）。

## 1.2 整页快照（单文件 HTML）

"媒体下载"之外的第二条产品线：把一个网页连图片带样式存成**一个** `.html`。
它不参与资源图，也不写 `storage.session` —— 一次性的、用户显式触发的动作。

~~~
content/page_archiver.js（每个 frame 各一份）
  documentElement.cloneNode(true) → 活树/克隆树同步遍历：结构指纹 + 选择器词表 +
  图片 currentSrc；顺手摘掉悬浮层与 display:none 的元素（分片让出主线程）
  要内联的地址 → rhres://<token>/<n>；iframe → rhframe://<token>/<n>
        │ { html, resources[], frames[], stats }
        ▼
sidepanel/modules/page_archive.js（编排，I/O 全部注入 → 可单测）
  ① 逐 frame 采集（先注入再重试）    ② 帧树配对（src ↔ frame.url，配不上就还原）
  ③ CSS 闭包：先按本帧词表删掉匹配不到的规则、再删没人用的字体（整族 / `unicode-range` 子集）
     → url() 内联；@import 递归展开，失败保底绝对地址
  ④ 二进制批量抓取（去重、预算）     ⑤ 从深到浅装配 srcdoc → 替换占位符
     → 补 `<meta charset="utf-8">`（原页面可能只靠 HTTP 头声明编码，落地成文件后必须自带）
        │
        ├─▶ core/page-archive.js   占位符/URL/CSS/转义/装配/文件名（纯函数）
        ├─▶ core/page-frames.js    帧树、配对、srcdoc 转义（纯函数）
        └─▶ bg/archive-fetch.js    带凭证抓取、边读边计数、403 时临时补 Referer 重试
                    │
                    ▼
        download_finalize.js（与三条引擎下载共用落盘与历史）
~~~

设计取舍、协议、预算与已知限制见 [ARCHIVE.md](ARCHIVE.md)。
一句话概括它为什么长这样：**能测的部分（文本怎么改）全在 core，不能测的部分（DOM 怎么走）尽量薄。**

## 2. 数据流

~~~
网页请求 ──webRequest──▶ background.js
                          │ 1. isYouTubeUrl / STREAM_EXTS / STREAM_KEYWORDS 判定
                          │ 2. parseMediaUrl(url, mime, headers, tabId) → media 对象
                          ▼
                   discoveredMedia: Map<tabId, Map<hash, media>>   （仅内存）
                          │
      ┌───────────────────┼────────────────────┐
      │ 广播 RH_MEDIA_DETECTED（每条一次）        │ RH_GET_MEDIA（全量拉取）
      ▼                                          ▼
 content 悬浮层（刷新 pageMediaList）      Side Panel（video/audio 两个 Tab 重渲染）
      │                                          │
      └──────────── RH_DOWNLOAD ────────────────▶│
                                                 ▼
                                    pickTargetMedia → buildDownloadPlan
                                                 │
                        ┌────────────────────────┼───────────────────────┐
                        ▼                        ▼                       ▼
                    direct                    mux                   stream
             chrome.downloads         sidepanel 拉双轨合流      sidepanel HLS 拼装
~~~

### media 对象（当前事实上的契约）

~~~js
{
  hash: 'res_x1y2z',        // 32 位字符串哈希（碰撞风险见 AUDIT B1）
  url, title, type, extension, is_audio, has_drm,
  duration, size, headers,  // headers 采集了但下载路径未使用（AUDIT D3）
  qualities: [{ index, label, width, height, bitrate, demuxer, videoUrl, audioUrl }]
}
~~~

## 3. 模块职责与边界

| 模块 | 职责 | 不该做的事 |
|---|---|---|
| `bg/capture`（现为 background.js 内） | 只产出"观测" | 不做命名、不做配对、不做决策 |
| `core/decision.js` | 资源选择、下载计划、文件名 | 不碰 chrome API、不发消息、不读 DOM |
| `core/identity.js` | 身份键、短 ID、内容指纹 | 不做网络与存储 |
| `core/classify.js` | 请求分类（后缀 / MIME / CDN host） | 不发请求 |
| `core/sniff.js` | 魔数 → 容器类型 | 不读网络 |
| `core/probe.js` | 一次 Range 探测换六个字段 | 不写存储、不做决策 |
| `core/pair.js` | 视频轨 ↔ 音轨配对、可合流判定 | 不做下载 |
| `core/mp4.js` | ISO BMFF 读写原语 | 不含业务判断 |
| `core/remux.js` | 采样级合流（整文件重写 stco/co64；fMP4 交错片段） | 不碰网络 |
| `core/hls.js` | HLS 播放列表解析（变体/音轨组/密钥/BYTERANGE） | 不发请求 |
| `core/dash.js` | MPD 解析（自带 XML 扫描器、SegmentTemplate/Timeline） | 不发请求 |
| `core/sink.js` | 分块滚动落盘、乱序按序写入 | 不碰 chrome API |
| `core/site-engine.js` | 声明式适配器解释器（JSONPath 子集） | 不发请求 |
| `core/page-observation.js` | 适配器变体 -> 图观测 | 不碰 chrome API |
| `core/observation.js` | media -> 图观测（抓包与适配器共用） | 不碰 chrome API |
| `core/page-archive.js` | 占位符协议、URL 规整、CSS 扫描/重写、转义、文档装配、文件名 | 不碰 DOM/网络 |
| `core/base64.js` | 大数组转 base64、Content-Type 清洗、MIME 猜测 | 不碰 chrome API |
| `core/page-frames.js` | 帧树、父子配对、`srcdoc` 转义与还原 | 不碰 chrome API |
| `bg/archive-fetch.js` | 带凭证批量抓取、流式限长、Referer 重试、frame 枚举 | 不做业务判断 |
| `bg/adapters.js` | 运行时加载 sites/*.json | 只读文件 |
| `offscreen/offscreen.js` | 后台构建（拉流/拼装/合流） | 只有 runtime，无下载 API |
| `bg/offscreen.js` | offscreen 文档生命周期 | 只创建/关闭 |
| `core/offscreen-protocol.js` | 三方消息契约与校验 | 不碰 chrome API |
| `content/page_hooks.js` | 主世界钩子：从 performance 资源条目读媒体地址、MSE/blob 观测；文本解锁时清页面复制处理器 | 不替换 fetch/XHR、不改请求、不读播放数据 |
| `content/hook_bridge.js` | 主世界 -> 隔离世界转发 | 只转发 |
| `core/settings.js` | 设置形状、校验、模板渲染 | 不碰 chrome API |
| `core/mse-record.js` | MSE 录制：按轨累积、合流、缺初始化段告警 | 不碰 chrome API |
| `core/history.js` | 下载历史的形状、裁剪、统计 | 不碰 chrome API |
| `core/live-record.js` | 直播账本：序列号增量、丢片计数、回退重置 | 不碰 chrome API |
| `sidepanel/modules/live_recorder.js` | 直播录制编排（轮询/拉片/滚动落盘） | 只在侧边栏运行 |
| `sidepanel/modules/page_archive.js` | 整页快照编排（采集/样式闭包/装配/落盘），I/O 全注入 | 不直接读 DOM |
| `content/page_archiver.js` | 整页快照的 DOM 序列化与资源登记 | 不解析 CSS、不抓网络 |
| `bg/history.js` | 历史持久化（storage.local，写去抖） | 只读写历史 |
| `bg/settings.js` | storage.sync 读写与订阅 | 只读写设置 |
| `core/graph.js` | 资源图（node + variants） | 不碰 chrome API |
| `bg/persist.js` | storage.session 快照与恢复 | 不含业务判断 |
| `bg/attribution.js` | documentId / frameId / 导航代次 | 不含业务判断 |
| `bg/enricher.js` | 探测队列（限并发、去重） | 只调度，不改数据 |
| `core/*`（规划中） | 身份 / 图 / 分类 / 配对 / 探测 | 不依赖 UI |
| `sidepanel/*` | 渲染与用户意图 | 不解析网络、不做业务判断 |
| `content/*` | 页面观测与交互 | 不持久化、不跨标签页通信 |

**当前已达标**：`core/decision.js` 是纯函数（零 chrome 依赖，35 个单测中的 22 个覆盖它）。

## 4. 五条不变量与现状

| 不变量 | 现状 | 缺口 |
|---|---|---|
| I1 身份唯一 | ✅ 规范化 URL + 短 ID | 内容指纹待接（P2 镜像去重） |
| I2 逻辑唯一 | ✅ 资源图（node + variants） | 站点适配器接入 groupKey（P4） |
| I3 依赖闭合 | ✅ 配对 + 整文件/fMP4 合流 + DASH 双轨 | HLS 独立音轨组待补 |
| I4 归属确定 | ✅ documentId / frameId / 导航代次 | — |
| I5 保真 | ✅ 魔数嗅探 + Range 探测回填 | 播放列表内省（P4） |

## 5. 决策层为什么存在

`src/core/decision.js` 把两个曾经"静默产错"的判断收敛成纯函数：

1. `pickTargetMedia(list, {mediaHash, url})` —— 只接受精确命中，
   没有"取第一条"的兜底（AUDIT B5）。
2. `buildDownloadPlan(media, {playlistIndex, audioOnly})` —— 返回
   `direct` / `mux` / `stream` 三种模式或明确的错误码
   （`AUDIO_TRACK_UNAVAILABLE`、`STREAM_FORMAT_UNSUPPORTED`、`DRM_PROTECTED`、`RESOURCE_NOT_FOUND`）。

它不是"过度抽象"：这两个判断是用户拿到坏文件的唯一入口，必须可单测、可回归。

## 6. 已登记的架构债

| 债务 | 影响 | 计划 |
|---|---|---|
| ~~资源状态只在 SW 内存 Map~~ | ~~SW 回收即失忆~~ | ✅ P1 `storage.session` |
| ~~下载引擎活在侧边栏文档~~ | ~~关面板 = 任务死亡~~ | ✅ 构建迁到 offscreen（不支持时自动回退侧边栏），见 [OFFSCREEN.md](OFFSCREEN.md) |
| ~~MSE 播放器只能解释不能下载~~ | ~~blob 站点下不了~~ | ✅ 边播边录（P5）；直播录制待做 |
| ~~分片全量驻留内存~~ | ~~大文件 OOM~~ | ✅ HLS 走 ChunkedBlobSink；合流路径仍需要完整缓冲 |
| ~~MP4 合流不重写 stco~~ | ~~输出不可播放~~ | ✅ P3 采样级 remux |
| ~~fMP4 分片合流缺失~~ | ~~分片流只能下视频轨~~ | ✅ P3 fMP4 交错合流 + 探针覆盖 |
| ~~站点逻辑硬编码~~ | ~~加站点要改核心代码~~ | ✅ 已迁到 sites/*.json，extractor 只采集 |
| ~~webRequest 不限 types + 18 条关键词~~ | ~~每请求无谓开销~~ | ✅ P1 收窄 |
| ~~全量列表重取~~ | ~~O(N²) 渲染~~ | ✅ P1 增量 delta |

## 7. 如何扩展

### 加一个下载策略
1. 在 `decision.js` 的 `buildDownloadPlan` 里新增 `mode`；
2. 在 `background.js` 的 `RH_DOWNLOAD` 分支里处理该 mode；
3. 在 `test/unit/decision.test.mjs` 加用例。

### 加一个站点
1. 在 `src/sites/` 下新增一个 JSON（照抄 `bilibili.json`），给 `id`、`priority`、`match`；
2. 用 JSONPath 子集把页面数据映射成变体：`$.a.b[*]`、`||` 兜底、`==` / `contains` 过滤；
3. 在 `src/bg/adapters.js` 的 `ADAPTER_FILES` 里注册（有守卫测试会提醒）；
4. 在 `test/corpus/` 加一份 fixture + 一个 case，跑 `npm run corpus` 看黄金比对。

如果站点只是把流放进 `<video>`/`<audio>`，**不用写任何代码**：`sites/generic-dom.json` 已经兜住。
内容脚本只负责采集，不要往 `extractor.js` 里加站点逻辑。

### 加一类资源（如图片之外的文档）
1. `media.kind` 扩展字段 → 影响 UI 分组；
2. 决策层新增对应的 `buildDownloadPlan` 分支；
3. UI 新增一个 Tab（复用 `ui/dom.js`）。

## 8. 测试与门禁

| 门禁 | 位置 | 覆盖 |
|---|---|---|
| 单测 | `test/unit/*.test.mjs` | 决策层 22 例、清单守卫 8 例、注入守卫 4 例、解析器 7 组 |
| 缺陷探针 | `test/probes/*.probe.cjs` | MP4 合流偏移、32 位哈希碰撞（修复后应转绿） |
| 构建门禁 | `tools/build.mjs` | 每个 JS 过 `node --check`、manifest 引用文件必须存在 |
| 注入守卫 | `test/unit/no-html-injection.test.mjs` | innerHTML 不得插值（含变异测试验证） |
