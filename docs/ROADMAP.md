# ResourceHelper 路线图 v2 · 泛用性 / 准确性 / 效率 / 能力扩张

> 前置阅读：[AUDIT.md](AUDIT.md)（57 项问题与实测证据）
> 目标版本：v2.0（从"能跑"到"敢信"）
> 相关文档：[ARCHITECTURE.md](ARCHITECTURE.md) / [SITE-ADAPTERS.md](SITE-ADAPTERS.md) / [CONTRIBUTING.md](CONTRIBUTING.md)

---

## 0. 目标与非目标

### 0.1 三个 KPI（可量化，进 CI）

| KPI | 定义 | 现状（估计） | v2 目标 |
|---|---|---|---|
| **泛用性** P | 语料站中"至少发现 1 条可播放资源"的比例 | 覆盖 5 个硬编码站点，其余靠后缀碰运气，≈ 40% | ≥ 90%（含 MSE 播放器） |
| **准确性** A | "卡片数 = 逻辑媒体数"且"点下载拿到的就是这张卡"的比例 | 大量重复卡 + 无声/错配，≈ 35% | ≥ 95% |
| **效率** E | 单页 1000 次请求下 SW 分类耗时 / 图片扫描耗时 / 下载峰值内存 | 未测；扫描数百 ms、下载 O(文件大小) 内存 | ≤ 20ms / ≤ 80ms / ≤ 250MB |

三个 KPI 必须同时成立。"发现得更多但更乱"是负收益，"更准但只支持 2 个站"也不是泛用。

### 0.2 非目标（明确不做的）

1. **不绕过 DRM**：EME/Widevine/FairPlay/`SAMPLE-AES` 一律识别并如实告知，不尝试破解。
2. **不复用任何第三方专有代码**：不复制第三方商业扩展的实现、站点脚本或逆向产物；行为参考只作为黑盒测试用例。
   仓库内不保留任何第三方专有代码副本（`.gitignore` 已忽略本地 `work/` 目录）。
3. **不做云端解析**：所有解析在本机完成，零遥测（这是与商业产品的差异化而非劣势）。
4. **不把下载引擎放在 UI 上下文**（侧边栏/popup 随时会被关闭）。
5. **不用 32 位哈希做身份**，不用"取第一条"做兜底。
6. **不为了覆盖更多站而牺牲"用户能理解为什么失败"**：失败必须有明确归因（缺音轨/缺 init/DRM/需要登录/触发防盗链）。

---

## 1. 目标架构

### 1.1 分层（数据自下而上，控制自上而下）

~~~
┌─────────────────────────────────────────────────────────────────────┐
│ L5 UI        sidepanel(panel/*) · settings · overlay · contextMenus │  只读图，只发命令
├─────────────────────────────────────────────────────────────────────┤
│ L4 Command   engine/router · engine/queue · engine/sink             │  任务状态机
├─────────────────────────────────────────────────────────────────────┤
│ L3 Graph     core/graph · core/pair · core/probe · core/classify    │  唯一事实来源
├─────────────────────────────────────────────────────────────────────┤
│ L2 Capture   bg/capture.webrequest · bg/capture.messages            │  只产"候选观测"
│              page/hooks.main(MAIN world) · page/dom-scan             │  不判断、不命名
├─────────────────────────────────────────────────────────────────────┤
│ L1 Transport platform: webRequest / fetch / FileSystem / Offscreen  │
└─────────────────────────────────────────────────────────────────────┘

不变式：只有 L3 能产生 Resource 节点；L2 只能 append Observation；
        L4 只能消费 Resource；L5 只能读图 + 发命令。任何跨层捷径都视为架构违规。
~~~

**关键约束**：L2 的观测是**未经解释的原始事实**（`{url, headers, byteSize?, mime?, from: 'webRequest', requestId, documentId, frameId}`）。命名、猜测、配对全部在 L3 做。这样"识别不准"永远只需改一个地方，且可单测。

### 1.2 目录（src 与 dist 分离，为引入依赖让路）

~~~
ResourceHelper/
├── package.json            # type: module, scripts: build/dev/test/e2e/lint
├── tools/
│   ├── build.mjs           # esbuild 打包 + 静态资源 copy -> dist/
│   └── pack.mjs            # 生成 crx/zip、版本号自增
├── src/
│   ├── manifest.json       # 由 build 注入版本号/权限（单源）
│   ├── core/
│   │   ├── model.js        # 数据结构 + 五条不变量校验
│   │   ├── identity.js     # resourceKey / contentPrint / 去重
│   │   ├── graph.js        # 图操作：upsert / merge / expire / snapshot
│   │   ├── classify.js     # 后缀 + MIME + 魔数 + 播放列表判定
│   │   ├── pair.js         # 视频轨↔音轨配对、画质梯度装配
│   │   ├── probe.js        # HEAD / Range 探测（大小、类型、文件名）
│   │   └── site-engine.js  # 声明式适配器解释器（JSONPath 子集）
│   ├── bg/
│   │   ├── sw.js           # 生命周期、消息路由、delta 广播
│   │   ├── capture.webrequest.js
│   │   ├── capture.messages.js
│   │   ├── persist.js      # storage.session 快照（防抖）
│   │   └── headers.js      # DNR 规则（按站点作用域）
│   ├── page/               # content scripts（ISOLATED world）
│   │   ├── dom-scan.js     # 可见性驱动扫描
│   │   ├── overlay.js
│   │   ├── text.js
│   │   └── bridge.js       # ISOLATED ↔ MAIN 的 postMessage 桥
│   ├── page-hooks/         # 注入 MAIN world（executeScript world:'MAIN'）
│   │   ├── hooks.js        # fetch/XHR/MSE/EME/createObjectURL
│   ├── engine/
│   │   ├── router.js       # direct|hls|dash|mse|remux|record
│   │   ├── hls.js          # 播放列表/分片/密钥（薄封装 hls.js 解析器）
│   │   ├── dash.js         # mpd-parser 薄封装
│   │   ├── mse.js          # 录制模式
│   │   ├── remux.js        # mp4box.js 封装
│   │   ├── sink.js         # Blob / FileSystem / OPFS 三种落盘
│   │   └── queue.js        # 并发、重试、断点、限速
│   ├── ui/                 # sidepanel + settings（纯视图）
│   └── sites/              # 声明式站点适配器（JSON，可热更新）
│       ├── youtube.json
│       ├── bilibili.json
│       ├── tencent.json
│       └── ... （新增站点 = 新增一个 JSON）
├── test/
│   ├── unit/               # node:test：identity/classify/pair/hls/mp4
│   ├── probes/             # 现有 2 个探针（作为回归门禁）
│   ├── corpus/             # 站点语料 + golden 快照
│   └── e2e/                # Playwright + --load-extension
└── dist/                   # 产物（不进版本库）
~~~

迁移策略：**先加 `package.json` + 构建 + `dist/`，再逐模块搬**。P0 只需一条 `node tools/build.mjs && copy` 让 `dist/` 与今日 `out/` 等价，后续每次提交搬一个模块。

---

## 2. 资源图：把"一一对应"变成代码

### 2.1 数据模型

~~~js
// core/model.js
{
  id: 'bili:BV1RqWe6EE6Q',            // 逻辑媒体身份（站内 ID 优先，其次规范化 URL）
  kind: 'media',                       // media | image | document | other | text
  title: '某视频',                      // 来自适配器 > 清洗后 title > Content-Disposition
  site: 'bilibili.com',
  scope: {                             // ← I4 归属
    tabId: 41, frameId: 0, documentId: 'A1B2…', generation: 7,
    framePath: ['主文档'], origin: 'https://www.bilibili.com'
  },
  provenance: ['page-json', 'webRequest'],   // 谁先发现的（用于 UI 徽标 + 排障）
  completeness: 'complete',            // complete | video-only | missing-init | drm | partial
  variants: [{                         // ← I2：清晰度是子项，不是兄弟
    id: 'q80', label: '1080P 高清',
    width: 1920, height: 1080, fps: 30, bitrate: 2_400_000,
    sizeBytes: 183_451_904,            // ← I5：来自 Content-Length / Range 探测
    container: 'mp4', videoCodec: 'avc1.640032', audioCodec: 'mp4a.40.2',
    protocol: 'dash',                  // progressive | hls | dash | mse-record
    video: { url, headers, init: {range:'0-995'}, segments: null },
    audio: { url, headers, lang: 'zh', role: 'main' } | null,
    drm: null,
    playable: true
  }],
  warnings: [{ code: 'AUDIO_PAIRED_FROM_QUALITY_LADDER', detail: '…' }],
  firstSeenAt, lastSeenAt, expiresAt
}
~~~

### 2.2 身份（I1）

~~~js
// core/identity.js
const VOLATILE = new Set([
  'range', 'rn', 'rbuf',                 // YouTube / googlevideo 分块与回滚计数
  'clen', 'dur', 'expire', 'expires',    // 由探测重算的元信息
  'token', 'sign', 'sig', 'ts', '_t',    // 通用签名/时间戳
  'x-bogus', 'mime'
]);

export function resourceKey(u) {              // 一级身份：逻辑同一性
  const x = new URL(u);
  const q = [...x.searchParams]
    .filter(([k]) => !VOLATILE.has(k.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));  // 参数顺序无关
  return x.host.toLowerCase() + x.pathname + (q.length ? '?' + q.map(([k, v]) => k + '=' + v).join('&') : '');
}

export function contentPrint(o) {             // 二级身份：内容同一性（折叠镜像/分块）
  return [o.mime || '?', o.totalBytes ?? '?', o.etag || '', o.firstChunkHash || ''].join('|');
}
~~~

- 一级键失配才建新节点；一级键相同而 `contentPrint` 不同 → 同一资源的**镜像变体**（挂到 `mirrors[]`）。
- 已知 `itag`/站内 ID 的站点，适配器直接给 `id`，跳过推断。

### 2.3 归属（I4）

三维作用域 + 一个代次：

| 维度 | 来源 | 用途 |
|---|---|---|
| `tabId` | `details.tabId` | 面板切换的粗粒度隔离 |
| `documentId` | `details.documentId`（Chrome 106+） | iframe / 广告框架精确隔离（**当前完全缺失**） |
| `framePath` | `webNavigation.getFrame` 缓存 | UI 上显示"来自：内嵌框架 #2（ads.xxx）" |
| `generation` | `onCommitted` / `onHistoryStateUpdated` 递增 | SPA 换视频后旧资源不污染新列表（但展示在"上一页"折叠区，不删除） |

配套规则：
- **跨代次隔离**：面板默认只显示 `generation === current` 的节点；旧代次折进"上一页 (12)"。
- **框架默认折叠**：`frameId !== 0` 的节点默认隐藏，带"显示内嵌框架资源"开关（解决 iframe 广告污染）。
- **归属可展示**：每张卡片右上角显示 provenance 徽标（网络 / 页面数据 / 深度钩子）+ 定位按钮（滚动并高亮对应 `<video>`）。用户用手指就能验收"一一对应"。

### 2.4 配对（I3，解决无声视频）

配对不是一个 if，而是一张规则表，按协议分派：

| 场景 | 配对依据 | 兜底 |
|---|---|---|
| YouTube `adaptiveFormats` | 容器兼容：mp4 视频轨(itag 13x) ↔ `audio/mp4`(140/139)；webm(24x) ↔ `audio/webm`(251/250) | 任选最高码率兼容音轨；无则标 `video-only` |
| B 站 `dash` | 音频 ID 阶梯 30280(192K) > 30232(132K) > 30216(64K)，每档音轨配给全部视频档 | 缺失则从 `__playinfo__` 的 `dash.audio` 取首个 |
| DASH `AdaptationSet` | `contentType` + `@lang` + `Role@value`（main/dub/alternate） | 同 lang 下最高 bandwidth |
| HLS | `#EXT-X-STREAM-INF:AUDIO="group"` → `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID` | 无音频组则视为 muxed |
| 通用（仅网络层发现） | 同 `documentId` + 时长差 ≤ 0.5s + 码率相当 + 一个 pure-video 一个 pure-audio | 标 `completeness:'video-only'` 并在 UI 明示"需在页面播放以捕获音轨" |

核心代码形态（伪代码，规则表驱动）：

~~~js
// core/pair.js
export function pairVariants(obs, site) {
  const vids = obs.filter(o => o.stream === 'video' && !o.muxed);
  const auds = obs.filter(o => o.stream === 'audio');
  return vids.map(v => {
    const a = site?.pairVideoAudio?.(v, auds)      // 站点适配器可覆盖
           ?? byCodecCompat(v, auds)
           ?? byDurationProximity(v, auds, 0.5);
    return { ...v, audio: a ?? null, playable: Boolean(a) || v.muxed };
  });
}
~~~

**验收**：B 站/Tencent/YouTube 三类站点，任选一个 1080P 条目下载后 `ffprobe` 必须显示 1 条视频流 + 1 条音频流；否则该变体在 UI 上不可点，并给出人话原因。

---

## 3. 泛用性：三条腿走路

> 现状：识别 = "URL 后缀命中正则" 或 "命中 5 个硬编码站点之一"。这两条腿都撑不住。

### 3.1 腿一：协议层分类器（对全网生效，不需要站点知识）

判定顺序（先便宜后昂贵，命中即停）：

| 层 | 判据 | 成本 | 覆盖 |
|---|---|---|---|
| L1 文件名后缀 | `.m3u8/.mpd/.mp4/.webm/.m4a/.mp3/…` | O(1) 正则 | 老站点、直链 |
| L2 响应头 | `Content-Type`（`video/mp4`、`application/vnd.apple.mpegurl`、`application/dash+xml`、`audio/mpeg`…）+ `Content-Disposition` | 读已到达的头，零请求 | CDN 无后缀、签名 URL |
| L3 魔数嗅探 | 对"未知类型但体积可疑"的响应发 `Range: bytes=0-1023`，比对 `ftyp/moof/styp`(ISO-BMFF)、`0x47` 同步字节(TS)、`#EXTM3U`、`<MPD`、`OggS`、`fLaC`、`ID3`、`RIFF…WEBP`、JPEG `FF D8 FF`、PNG `89 50 4E 47`、`%PDF`、`PK 03 04`(ZIP) | 1 次 1KB 请求，带 5 分钟缓存 | 无后缀签名 URL（现代站点主流） |
| L4 播放列表内省 | 若 URL 疑似 m3u8/mpd，**直接抓取并解析**（1–20KB），得到 `#EXT-X-STREAM-INF` / `Representation` → 一条 master 兑换 N 个真实变体 | 1 次小请求 | HLS/DASH |
| L5 站点适配器 | 见 3.2 | JSON 解释 | 有页面内数据的高价值站 |
| L6 运行时钩子 | 见 3.3 | MAIN world 注入 | MSE/blob 播放器 |

**关键收益**：L2 + L3 + L4 全部与站点无关。这三层做到位，泛用性从"5 个站"直接变成"所有用标准协议/标准容器的站"，站点适配器只做"锦上添花 + 标题/画质语义"。

### 3.2 腿二：声明式站点适配器（加站点 = 加 JSON）

用已经踩过坑并测过的 `sliceBalancedJson` 做底座，把"页面内嵌 JSON → 资源"变成数据映射。

~~~json
{
  "id": "bilibili-video",
  "version": 3,
  "match": ["https://www.bilibili.com/video/*", "https://www.bilibili.com/list/*"],
  "probes": [
    { "kind": "inline-assign", "assign": "window.__playinfo__=", "maxBytes": 2097152 },
    { "kind": "global", "path": "window.__playinfo__" },
    { "kind": "inline-assign", "assign": "window.__INITIAL_STATE__=" }
  ],
  "title": ["$.data.videoData.title", "$state.videoData.title", "$doc.title"],
  "media": {
    "id": "$.data.bvid || $state.bvid",
    "drm": "$.data.is_drm == 1",
    "video": {
      "each": "$.data.dash.video[*]",
      "url": "$.baseUrl || $.backupUrl[0]",
      "quality": "$.id",
      "codec": "$.codecs",
      "init": "$.SegmentBase.Initialization",
      "index": "$.SegmentBase.indexRange",
      "extraHeaders": { "Referer": "https://www.bilibili.com/", "Origin": "https://www.bilibili.com" }
    },
    "audio": {
      "each": "$.data.dash.audio[*]",
      "url": "$.baseUrl || $.backupUrl[0]",
      "quality": "$.id",
      "lang": "$.lang || 'zh'"
    }
  },
  "qualityLabels": { "127": "8K", "120": "4K", "116": "1080P60", "80": "1080P", "64": "720P", "32": "480P", "16": "360P" },
  "audioLadder": [30280, 30232, 30216],
  "headers": { "Referer": "https://www.bilibili.com/" }
}
~~~

解释器只需实现一个 **JSONPath 子集**：`$.a.b`、`$.a[0]`、`$.a[*]`、`||` 兜底、字符串字面量。约 150–200 行，纯函数，可单测；站点作者不需要懂扩展 API。

| 维度 | 现在（硬编码 if 分支） | 适配器 |
|---|---|---|
| 加站点 | 改 `extractor.js` + 发版 | 加一个 JSON（设置页可导入导出） |
| 站点改版 | 改代码 | 改 JSON |
| 可测试 | 只能在真站跑 | 喂 fixture JSON 断言输出 |
| 社区贡献 | 几乎不可能 | PR 一个 JSON |

### 3.3 腿三：运行时钩子（MSE / blob / 一次性 URL）

对 `<video src="blob:…">` 的站点（YouTube、大量 SPA、国产站），DOM 层**永远看不到真实 URL**。必须在 MAIN world 挂钩：

| 钩子 | 抓到的信息 | 解决的痛点 |
|---|---|---|
| `window.fetch` / `XMLHttpRequest` | 请求 URL、headers、**文本响应体**（m3u8/mpd ≤ 256KB 留档） | 一次性链接、需签名的播放列表、页面里隐藏的 m3u8 |
| `MediaSource.prototype.addSourceBuffer` | `mimeType`（容器 + 编码） | 识别 MSE 流与真实编码 |
| `SourceBuffer.prototype.appendBuffer` | 首个 init segment 字节（保留 ftyp + moov） | 无 moov 场景的救星（也是 A2 崩溃的解法） |
| `URL.createObjectURL` | blobUrl → MediaSource 映射 | 把 `<video>.src` 反查到分片集合（解决 B6 归属） |
| `navigator.requestMediaKeySystemAccess` | DRM 系统名 | 准确标注"受保护"而不是"下载失败" |
| `HTMLMediaElement.prototype.src` setter | 赋值链 | SPA 换集的瞬间识别 |

工程要求：

1. **注入方式**：`chrome.scripting.executeScript({ world: 'MAIN' })` + `registerContentScripts`，**不要**内联 `<script>`（严格 CSP 站点会静默拦截，见 AUDIT F5）。
2. **主世界脚本零副作用**：只监听、只 `postMessage` 给 ISOLATED world 的 `bridge.js`；绝不改页面行为、不阻塞请求。响应体复制用 `response.clone()` 异步读。
3. **可开关**："深度抓取"默认关闭（cat-catch 的"深度搜索"同样默认关闭并警告"非常占用资源"——业界共识）。
4. **成本上限**：单文档最多留档 32 个播放列表，每个 ≤ 256KB，超出 LRU 淘汰。

> **实现修订（v1.1，已按此落地）**：表格第一行的 `window.fetch` / `XMLHttpRequest` **没有**按"包装原生方法"实现，
> 响应体留档也一并放弃。原因是一次真实的踩坑：包装就等于站到页面的请求路径上，页面自己
> `fetch('data:,')` 被它的 `connect-src` 拦下时，控制台堆栈落在我们的文件里，看着像扩展在发请求；
> Cloudflare 这类防护还会核对原生函数是否被改写，被包过的 `fetch` 本身就是可疑信号。
> 现在改为只读 `PerformanceObserver` 的 `resource` 条目（同样有完整 URL 与 `initiatorType`），
> 需要播放列表文本时由后台带页面凭证重新抓一次——比在页面里劫持响应更便宜，也不会改变页面行为。

### 3.4 三者如何协作（一次发现的完整生命周期）

~~~
播放器 fetch("https://cdn/x/master.m3u8?sign=…")        ← fetch 钩子留档文本
   │
   ├── L2/L4 再抓一次（令牌已失效也能用钩子留档）        ← core/classify.js + core/hls.js
   ↓
解析出 3 个变体(1080/720/480) + 1 个音频组
   ↓
graph.upsert({ id, variants[] })                        ← core/graph.js 合并，同一 master 再来不新增节点
   ↓
pairVariants() → 每个变体绑定音频组                      ← core/pair.js
   ↓
UI：一张卡 + 画质下拉 1080/720/480 + "约 183MB · 12:24"
~~~

---

## 4. 准确性：让"卡片 = 事实"

### 4.1 观测优先于推断（I5）

| 字段 | 现在 | 目标 |
|---|---|---|
| 扩展名 | URL 后缀猜 | 魔数 > Content-Type > 后缀 |
| 大小 | 不显示 | `Content-Length` 或 `Content-Range` 的 total |
| 时长 | 只有站点 JSON 里有 | 站点 JSON > `<video>.duration` > 解析 `mvhd/mdhd timescale` |
| 编码 | 无 | `codecs` 参数 / SourceBuffer mimeType / init segment |
| 文件名 | `document.title` | `Content-Disposition` > 适配器 title > 清洗后的 `<title>` > OG 元数据 |

`core/probe.js` 用一条 `Range: bytes=0-1023` 同时拿到：状态码、`Content-Type`、`Content-Range`（总长）、`Content-Disposition`、首 1KB 魔数、`ETag`。**一次请求换 6 个字段**，比"先 HEAD 再 GET"省一半。并发上限 4，结果缓存 5 分钟，失败只降级不阻塞。

### 4.2 去重：三种重复，三种解法

| 重复形态 | 例子 | 解法 |
|---|---|---|
| 分块重复 | YouTube 同一轨 `range=0-1048575` / `1048576-2097151` … 40 次 | `resourceKey` 剔除 `range` + `contentPrint` 折叠 |
| 镜像重复 | B 站 `baseUrl` 与 3 个 `backupUrl` | 同一段只留 1 主用 + N 备份（失败自动切换，这才是 backup 的正确用法） |
| 协议重复 | 同一视频既有 `master.m3u8` 又有 `720p/index.m3u8` | 父 master 存在时，子 variant 不再单独成节点 |

### 4.3 播放列表"押金"策略（应对一次性链接）

签名 URL 通常 5–30 分钟过期，而用户常常"先看到卡片、10 分钟后才点下载"。策略：

1. 首次识别到播放列表就**立刻抓文本留档**（≤ 256KB）；
2. 记住 `Referer/Origin` 的真实取值（来自同一次 `webRequest`，见 AUDIT D3：现在采了却没用）；
3. 下载时用留档文本 + 相对路径重建分片 URL；**分片 URL 也要在抓取时一并留档**（分片各自带签名）；
4. 留档超过 10 分钟，卡片显示"链接可能已过期 · 点击刷新"，并优先走"从页面重新触发"（钩子仍在时可直接重抓）。

### 4.4 DRM 三路合判（不再"点了才知道"）

| 信号 | 来源 |
|---|---|
| EME | `requestMediaKeySystemAccess` 钩子（记 keySystem） |
| HLS | `#EXT-X-KEY:METHOD=SAMPLE-AES/WIDEVINE/FAIRPLAY`、`#EXT-X-SESSION-KEY` |
| DASH | `<ContentProtection schemeIdUri="urn:uuid:edef8ba9-…">` |
| 页面 | `video.mediaKeys`、`video.webkitKeys` |

判定为 DRM 时：卡片显示"受版权保护（Widevine）· 无法下载" + "为什么"说明页，**不进入下载流程**。这比现在"点下去抛一个'音频轨拉取失败'"专业得多。

### 4.5 图片：从"全量列表"到"可用图库"

现在不是抓不到，而是**抓太多没用的**（一页 300 张：埋点、图标、头像、表情、广告位）。目标规则：

- 硬过滤：1×1、data URI、`<100×100` 且不是 srcset 最大项、`alt=""` 且 class 含 `icon/logo/emoji/avatar`；
- 加权排序：面积占比（元素尺寸 / 视口面积）、是否首屏、srcset 最大描述符、`loading="eager"`、OG/`twitter:image`、`background-image` 且元素 > 200px；
- 分组：同一 `<figure>/<picture>/srcset` 只保留最高分辨率 1 条；
- 增量：`IntersectionObserver` + `MutationObserver`，**不再全量扫描**。

---

## 5. 效率：把成本写进预算表

### 5.1 预算（进 CI 的性能门禁）

| 指标 | 预算 | 测量方式 |
|---|---|---|
| SW 分类耗时 | ≤ 0.5µs/请求；1000 请求 ≤ 20ms | `performance.mark` 累计 + 自测页 |
| SW 内存 | ≤ 40MB（10 标签页 × 200 资源） | 快照序列化大小 |
| content script 扫描 | ≤ 80ms @ 5000 节点 | `performance.now` 埋点 + 语料页 |
| content script 空闲 CPU | ≤ 0.3% | DevTools Performance 10s 录制 |
| 下载峰值内存 | ≤ 250MB（与文件大小无关） | `performance.memory` / 任务日志 |
| 面板首屏 | ≤ 100ms；列表更新 ≤ 4Hz 合并 | `performance.now` |

### 5.2 十个具体手段（按性价比排序）

1. **`webRequest` 限类型**：`types: ['media','xmlhttprequest','object','other']`。图片/js/css/字体全部不进回调，一次砍掉约 80% 事件量（E1）。
2. **单次 `onBeforeRequest` 判定**：去掉 `onHeadersReceived` 的第二遍（E1）。需要响应头时只对"已判定为媒体"的候选发一次 Range 探测（§4.1）。
3. **host 白名单 `Set`**：18 条短语换成 `Set` 精确 host 匹配 + 1 条预编译正则，未命中直接返回（E2）。
4. **回调内不做异步**：`onBeforeRequest` 里只 `queue.push`，`requestIdleCallback` 批量 flush（E9，同时规避 MV3 生命周期陷阱）。
5. **标题缓存**：`tabs.onUpdated` 维护 `tabMeta`，删除每条媒体的 `chrome.tabs.get`（E3）。
6. **增量广播**：`RH_MEDIA_DELTA`（`{added, updated, removed}`，150ms 合并），删除"每次发现都全量重取"（E3，消灭 O(N²)）。
7. **样式表解析代替 computed style**：`document.styleSheets → cssRules → url()` 一次拿全站背景图（零布局），只对视口内元素回退 `getComputedStyle`（E4，通常 10–100× 提速）。
8. **视口驱动**：悬浮胶囊只对 `IntersectionObserver` 命中的 `<video>` 挂载；定位用 `transform` + 单例 `rAF` 节流，不改宿主 `position`（E7）。
9. **事件替代轮询**：删掉 3 个 `setInterval`，改用 `play/loadedmetadata/emptied` + `webNavigation`（E6）。
10. **有界集合**：所有 `Set/Map` 加容量上限 + LRU（`dynamicNetworkImages`、`discoveredMedia`、钩子留档）（E5）。

### 5.3 状态持久化（C1 的解法）

~~~js
// bg/persist.js
const KEY = 'graph.v1';
let timer = null;

export function scheduleFlush() {
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    const snap = graph.snapshot();                        // 紧凑数组，不存 DOM/函数
    await chrome.storage.session.set({ [KEY]: snap });    // 10MB，不落盘，SW 重启可读
  }, 150);
}

export async function restore() {
  const got = await chrome.storage.session.get(KEY);
  if (got[KEY]) graph.load(got[KEY]);
}
~~~

SW 顶层 `await restore()`，每次图变更 `scheduleFlush()`。这样"切标签页回来列表还在"，且不写磁盘、不留隐私痕迹；跨会话历史另存 IndexedDB，并提供"退出即清空"开关。

---

## 6. 下载引擎：从"能下"到"下得对、下得稳"

### 6.1 策略路由

| 资源形态 | 策略 | 实现 | 内存 |
|---|---|---|---|
| 单文件 `mp4/webm/mp3/…` | `direct` | `chrome.downloads.download({url, headers})`（走 DNR 注入头），浏览器自己负责进度/断点/续传 | O(1) |
| HLS（m3u8） | `hls` | 解析 master → 变体；分片 → `mux.js` 转封装为 fMP4；AES-128 用 WebCrypto | 分段有界 |
| DASH（mpd） | `dash` | `mpd-parser` 解析 SegmentTemplate/Timeline → 分片 → 同 HLS 管道 | 分段有界 |
| 音画分离且各自是整文件 | `remux` | 两条流分别落盘 → `mp4box.js` 拼接为单文件（保留原编码，不重编码） | O(1) 流式 |
| MSE 播放器（blob） | `mse-record` | 钩子拿到的 init + 分片按序重放下载，或直接录制 appendBuffer 序列 | 分段有界 |
| 直播（滚动 m3u8） | `record` | `chrome.alarms` 轮询 playlist → 按 `EXT-X-MEDIA-SEQUENCE` 去重 → 追加 | 追加写盘 |
| 需要重编码（HEVC→H.264、任意→MP3） | `transcode` | **可选**：单线程 ffmpeg.wasm，仅在用户显式选择时加载（约 30MB，需要下载） | 慢但可选 |

**原则**：默认全部走"无重编码"路径（快、无损、无专利风险）；转码是显式选项，且在 UI 上标明"将重新编码，耗时较长"。

### 6.2 落盘抽象（解决 D1 + C2）

~~~js
// engine/sink.js
export class BlobSink {                     // 小文件（< 64MB）
  constructor(mime) { this.parts = []; this.mime = mime; }
  async write(u8) { this.parts.push(u8); }
  async close(filename) {
    const url = URL.createObjectURL(new Blob(this.parts, { type: this.mime }));
    await chrome.downloads.download({ url, filename, saveAs: false });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

export class FileSink {                     // 大文件：真流式，内存恒定
  // 由侧边栏在用户手势内 showSaveFilePicker() 取得 handle，
  // 通过 BroadcastChannel（结构化克隆支持 FileSystemFileHandle）交给 offscreen 执行写入
  constructor(fileHandle) { this.handle = fileHandle; }
  async open() { this.w = await this.handle.createWritable({ keepExistingData: true }); }
  async write(u8) { await this.w.write(u8); }
  async seek(pos) { await this.w.seek(pos); }
  async close() { await this.w.close(); }
}
~~~

三条硬约束：

1. **引擎必须活在 offscreen document**（`reasons: ['BLOBS', 'WORKERS']`），侧边栏只做 UI 与"选文件"；
2. **内存里最多保留 N 个分片**（N = 并发数 × 2），其余立即写入；
3. **每个任务有持久化状态**（IndexedDB：`{taskId, url, plan, writtenSegments:Uint8Array, etag, updatedAt}`），浏览器崩溃后可续。

### 6.3 无重编码合流（解决 A1/A2）

用 `mp4box.js`（BSD-3-Clause，纯 JS，无 wasm）按**采样级**合并，而不是拼盒子：

~~~js
// engine/remux.js —— 思路示意
import MP4Box from 'mp4box';

async function remux(videoSource, audioSource, sink) {
  const out = MP4Box.createFile();
  // 1. 读入两条流的 moov/moof，得到 track 描述与 sample 表
  // 2. out.addTrack(desc) 各建一条轨（track_id 由库分配，不再手改 tkhd）
  // 3. 逐 sample addSample(track, data, {dts, cts, duration, is_sync})
  //    —— 库负责重排 chunk、重写 stco/co64/stsz/stsc/ctts，并生成正确 moof/tfdt（fMP4）
  // 4. 边生成边写 sink，避免整体驻留内存
}
~~~

这条路同时解决三件事：A1（偏移）、A2（fMP4 无 moov）、以及"多音轨选择"（后续加轨即可）。

### 6.4 队列与健壮性

| 机制 | 设计 |
|---|---|
| 并发 | 初始 4，AIMD：连续成功 +1（上限 8），失败/429 −1（下限 2） |
| 重试 | 指数退避 + 抖动（0.5s→1→2→4，最多 5 次）；4xx 不重试，403 触发"刷新令牌"钩子重抓 |
| 断点 | 分片位图 + `ETag/If-Range`；续传前校验服务端 `ETag` 未变 |
| 取消 | `AbortController` 贯穿 fetch，取消即释放分片缓冲 |
| 限速 | 令牌桶（用户可设 MB/s），避免把用户的网打死 |
| 进度 | **字节数**驱动（`written / totalBytes`），分片计数只作副标题；ETA = 滑动平均速率 |
| 唯一任务 ID | `task:<uuid>` 从 UI → SW → offscreen → `downloads` 全程同一个 ID（解决 D8） |

### 6.5 命名与目录

~~~
模板：{site}/{uploader|未知作者}/{date}-{title} [{quality}].{ext}
示例：bilibili.com/影视飓风/2026-11-17-相机测评 [1080P].mp4
~~~

- 清洗：去掉 `/ \ : * ? " < > |`、控制字符、首尾空格与点、Windows 保留名（`CON/PRN/AUX`…）；
- 截断：按**字节**而非字符截断（UTF-8 安全），默认 120 字节；
- 冲突：`conflictAction: 'uniquify'`；可选"同名则跳过 + 记入历史"；
- 元信息：可选写 `.nfo`（标题/来源/时间/清晰度）或 MV3 里的 `chrome.downloads` item 备注。

---

## 7. 能力扩展矩阵（实话版：能做到 / 需权衡）

### 7.1 媒体

| 能力 | 现在 | v2 | 手段 | 代价 |
|---|---|---|---|---|
| HLS 完整下载 | 部分 | ✅ | hls.js 解析器 + mux.js | — |
| DASH 完整下载 | ❌ | ✅ | mpd-parser | — |
| 音画合流 | ❌（坏了） | ✅ | mp4box.js 采样级 remux | — |
| 多音轨/配音选择 | ❌ | ✅ | `#EXT-X-MEDIA` / AdaptationSet Role | — |
| 字幕下载 | ❌ | ✅ | 抓 `.vtt/.srt/.ass`；YouTube caption 轨；B 站 subtitle JSON | — |
| 直播录制 | ❌ | ✅ | alarms 轮询 + 序列号去重 | 只能从点击时刻开始录 |
| MSE 流捕获 | ❌ | ✅ | appendBuffer 钩子 + 分片重放 | 深度模式，成本高 |
| 帧截图 | ❌ | ✅ | `<video>` + canvas（CORS 允许时）或 `captureVisibleTab` | 跨域画面会被污染 |
| 整段无人值守录制（tabCapture） | ❌ | ⚠️ 可选 | `chrome.tabCapture` + MediaRecorder | 实时、重编码、画质损失、必须保持标签页可见；仅作为"实在没法解析"的最后手段 |
| DRM 内容 | 拒（文案差） | ✅ 明确拒 + 解释 | 三路合判 | 不做绕过 |

### 7.2 非媒体资源（新增一个"其它"分类，收益/成本比最高）

| 能力 | 说明 | 难度 |
|---|---|---|
| 文档捕获 | PDF / DOC / XLS / PPT / ZIP / APK / EPUB（按 Content-Type + 魔数） | 低 |
| 字体与 SVG | `.woff2/.ttf/.otf/.svg`，做"站点字体包"导出 | 低 |
| JSON/接口响应 | 记录 XHR/fetch 的 JSON 响应（只存结构 + 大小，可选全文），供调试/取数 | 中（隐私要显式开关） |
| 源码与 sourcemap | `.js` + `.map` 成对导出 | 低 |
| 全部链接导出 | 页面所有 `<a>` 去重导出为 CSV/Markdown/JSON | 低 |
| 页面转 Markdown/PDF | 复用正文提取 + `chrome.debugger` 的 `Page.printToPDF` | 中（debugger 需用户确认） |
| 整页存档（单文件 HTML） | DOM 序列化 + 图片/样式/字体内联 + iframe `srcdoc`，断网可读 | 中（已落地，见 [ARCHIVE.md](ARCHIVE.md)） |

### 7.3 图片与文本

| 能力 | 现在 | v2 | 说明 |
|---|---|---|---|
| 图库批量下载 | ✅ 基础 | ✅ 增强 | 分组去重 + 打包 ZIP（`fflate`，MIT）+ 命名序号 + 失败重试 |
| 原图推断 | ❌ | ✅ | 从缩略图 URL 反推原图（`_thumb/-300x300/w_200` 等常见规则）+ `srcset` 最大项 |
| 图片格式转换 | ❌ | ⚠️ 可选 | canvas/WebCodecs 转 webp/avif，体积收益大但有损 |
| 文本解锁 | ✅ 粗糙 | ✅ 精细 | 站点例外表、输入框豁免、只解 `user-select` 不动事件（可切换三档力度） |
| 正文提取 | ✅ 可用 | ✅ 增强 | Readability 算法（MIT）+ 规则表 + 保留图片/表格 |
| 划词翻译/OCR | ❌ | ❌ | 明确不做（另一个产品） |

### 7.4 工作流与系统集成

| 能力 | 手段 | 价值 |
|---|---|---|
| 右键菜单 | `contextMenus`：下载此视频/图片/链接、复制直链、批量下载本页图片 | 高 |
| 快捷键 | `commands.onCommand`：开关面板、对当前播放器直接下载 | 高 |
| 下载队列页 | 任务列表 + 暂停/续传/取消/重试 + 历史 | 高 |
| 站点规则编辑器 | 设置页里编辑/导入 `sites/*.json`，带"在页面上试跑"预览 | 高 |
| 设置项 | 画质偏好、命名模板、目录、并发、请求头表、白名单模式、隐私模式 | 高 |
| 拖拽到桌面 | `chrome.downloads.drag()` | 中 |
| 多语言 | `chrome.i18n` + 现有 `_locales`（已有 `i18n.js` 骨架） | 中 |
| 主题/字号 | CSS 变量 + `prefers-color-scheme` | 低 |
| Firefox/Edge 移植 | `webextension-polyfill`（MV3 差异主要在 `browser.*` 与 sidePanel） | 中 |

---

## 8. 同类插件参考（参考什么、规避什么）

| 产品 | 做对的地方（值得抄思路） | 做错/不适用（需要规避） |
|---|---|---|
| **商业同类产品**（闭源，仅作能力对照） | ① 用"远程规则"把站点知识从代码里剥出来；② 完整产品面覆盖画质偏好、音轨选择、字幕、历史、命名、队列、主题、语言；③ 自带转码器兜底；④ 页面内探测器补网络层盲区 | 闭源 + 付费墙 + 混淆不可维护；远程规则由厂商单方面维护，站点改版只能等它发版；**不复制其任何代码、常量表或站点脚本** |
| **cat-catch**（GPL-3.0，100 万+ 用户） | ① **深度搜索**：拦截关键函数找隐藏的 m3u8/mpd；② **m3u8 内容缓存**（解决"地址只能打开一次"）；③ 收集疑似密钥 `#maybekey`；④ 用 hls.js / mux.js / mpd-parser / StreamSaver.js 而不是自己造；⑤ 队列 + 断点续传 + 直播录制；⑥ 正则黑白名单、白名单模式、隐私模式 | GPL-3.0：**不能抄代码**，只能抄"产品设计"；重度依赖 jQuery，架构偏老；把它当"功能基准线"，不当"代码来源" |
| **yt-dlp** | ① 每个站点一个 extractor，声明式描述"如何从页面拿 URL"；② 有 `--list-formats` 这种"把内部状态摊给用户看"的能力；③ 失败信息极具诊断价值 | 需要 Python + 签名求解器；不可直接移植。可借鉴的是"extractor 契约"和"输出格式全暴露"；必要时可作为**外部命令**由用户自行使用（扩展只负责复制命令） |
| **Chrome DevTools Network** | 事实上的准确性标杆：请求 → 响应头 → 响应体 → 发起者链 全可见 | 不落地保存、不能批量。我们的目标是"给用户 DevTools 级别的归因 + 一键下载" |
| **IDM / 迅雷类** | 多线程分段下载 + 断点续传 + 浏览器接管 | 需要本地服务/原生程序，扩展无法合规做到；用 Range + 并发 + FileSink 逼近同等体验 |

**结论**：功能广度对标商业同类产品，产品取舍对标 cat-catch（默认克制、深度可选），站点知识组织方式对标 yt-dlp 的 extractor 契约，准确性叙事对标 DevTools。代码只用 Apache-2.0 / MIT / BSD 依赖。

---

## 9. 阶段计划

工期按"1 人全职、含自测"估算，可并行处已标注。

### P0 · 止血（3 天｜不修就是在持续产错）

| # | 任务 | 验收 |
|---|---|---|
| 1 | 加 `package.json` + `tools/build.mjs`（esbuild）+ `dist/`，输出与今日 `out/` 等价 | `npm run build` 后加载 `dist/` 功能不回归 |
| 2 | 删"取第一条"兜底（B5），改为明确错误 | 无效 hash 时不产生任何下载 |
| 3 | `audio_only` 无音轨时拒绝（A5） | 对 B 站 1080P 点"提取 MP3"，得到人话提示而非坏文件 |
| 4 | 删 `default_popup`（C4）、补 `commands.onCommand`（C5）、移除无手势的 `sidePanel.open`（C3） | 点图标进侧边栏；Alt+Down 有反应 |
| 5 | 26 处 `innerHTML` 换 `textContent`/`el()`（F1） | 页面标题含 `<img onerror>` 时 UI 不破 |
| 6 | 两个探针进 `npm test`（G2），并把历史开发日志标为"历史"（F7） | `npm test` 红/绿明确 |
| 7 | 写 `ARCHITECTURE.md` + `README.md`（G8） | 新人 10 分钟能跑起来 |

### P1 · 身份与状态（5 天｜一一对应的地基）

| # | 任务 | 验收 |
|---|---|---|
| 1 | `core/identity.js`：`resourceKey` + `contentPrint` 替换 32 位哈希 | 探针里 9.1 万 URL 零覆盖 |
| 2 | `core/model.js` + `core/graph.js`：Node/Variant 模型 + upsert/merge/expire | 单测：同 URL 两次 upsert 只产生 1 节点 |
| 3 | `bg/persist.js`：`storage.session` 防抖快照 + SW 顶层 restore | 手动终止 SW（`chrome://serviceworker-internals`）后列表仍在 |
| 4 | 归属：采 `documentId/frameId` + `generation` + 框架路径 | iframe 广告资源默认不进主列表；SPA 换集后旧资源进"上一页" |
| 5 | 广播改增量 `RH_MEDIA_DELTA` + 150ms 合并 | 200 条资源页面里 UI 更新 ≤ 4Hz |
| 6 | `webRequest` 限 `types` + host Set + 回调内不同步 await | 自测页 1000 请求分类 ≤ 20ms |
| 7 | 拆 `background.js` 为 `capture/classify/persist/sw` 四模块 | `classify` 单测覆盖率 > 80% |

### P2 · 准确性与性能（6 天）

| # | 任务 | 验收 |
|---|---|---|
| 1 | `core/classify.js`：后缀 → MIME → 魔数三级判定 | 10 个"无后缀签名 URL"全部正确识别为视频/播放列表 |
| 2 | `core/probe.js`：Range 探测拿 6 字段（大小/类型/文件名/etag/魔数/时长） | 卡片显示真实大小与扩展名 |
| 3 | `core/pair.js` + B 站/YouTube 适配器改用配对 | 两类站点 1080P 下载后 `ffprobe` 显示 2 条流 |
| 4 | 去重三态（分块/镜像/协议） | YouTube 单视频 = 1 卡 + N 变体 |
| 5 | 图片扫描改样式表解析 + 视口驱动 + 评分排序 | 5000 节点页面扫描 ≤ 80ms；图库前 20 条均为内容图 |
| 6 | 删 3 个 `setInterval`，改事件驱动；悬浮层改 IntersectionObserver | 空闲 CPU ≤ 0.3% |

### P3 · 下载引擎（8 天，可与 P2 并行后半段）

| # | 任务 | 验收 |
|---|---|---|
| 1 | offscreen document + `engine/queue.js` 任务状态机 | 关闭侧边栏后任务继续；重开面板进度正确 |
| 2 | `engine/sink.js` 三实现 + FileSink 走 BroadcastChannel 传 handle | 2GB HLS 下载峰值内存 ≤ 250MB |
| 3 | `engine/remux.js`（mp4box.js） | 探针 `delta == 0`；B 站/YouTube 合流产物 `ffprobe` 通过 |
| 4 | `engine/hls.js`（hls.js 解析器）+ `engine/dash.js`（mpd-parser） | 2 个真实 HLS + 2 个真实 DASH 站点下载成功 |
| 5 | 请求头策略：复用 `webRequest` 采到的真实头 + 站点表 + DNR `initiatorDomains` 收敛 | 之前 403 的 3 个站点变 200 |
| 6 | 统一 TaskId + 字节级进度 + 取消/重试 | 面板/悬浮胶囊/下载管理器三处进度一致 |

### P4 · 泛用性与断点（5 天）

| # | 任务 | 验收 |
|---|---|---|
| 1 | `core/site-engine.js` JSONPath 子集 + 适配器 schema | 单测：喂 B 站 fixture JSON → 产出 3 变体 + 1 音频 |
| 2 | 把 YouTube/B 站/腾讯迁成 `sites/*.json` | 行为与迁移前一致（golden 快照对比） |
| 3 | 断点续传（分片位图 + ETag 校验） | 中途 kill offscreen，重开后续传不重复下载已完成分片 |
| 4 | 并发 AIMD + 限速 + 429 处理 | 弱网模拟（DevTools Slow 3G）下不失败 |

### P5 · 深度抓取（6 天）

| # | 任务 | 验收 |
|---|---|---|
| 1 | `page-hooks/hooks.js`（fetch/XHR/MSE/EME/createObjectURL）+ `bridge.js` | 一个 MSE 站点能看到 mimeType 与 init segment |
| 2 | 播放列表留档 + 过期提示 + 重抓 | 一次性链接站点：识别 10 分钟后仍可下载 |
| 3 | 归属链：blob → MediaSource → 分片集合 → `<video>` | 一页 3 个播放器，点哪个悬浮胶囊就下哪个 |
| 4 | 深度模式开关 + 成本提示 + 上限（32 列表 / 256KB） | 关闭时不注入 hooks，CPU 观测无差异 |

### P6 · 产品化（6 天）

| # | 任务 | 验收 |
|---|---|---|
| 1 | 设置页（画质偏好/命名模板/目录/并发/白名单/隐私/深度模式） | 全部设置项持久化且即时生效 |
| 2 | 下载管理器（队列 + 历史 + 续传 + 失败重试） | 10 个任务并发不混乱 |
| 3 | 字幕/音轨/多语言选择 + 命名模板 | 字幕与音轨可选、文件名符合模板 |
| 4 | 右键菜单 + 快捷键 + 拖拽 | 三项可用 |
| 5 | i18n 接入（zh_CN / en）+ 主题 | 切换语言全部生效 |

### P7 · 规模化与合规（5 天）

| # | 任务 | 验收 |
|---|---|---|
| 1 | 直播录制 | 录 10 分钟滚动 m3u8，产出可播放文件 |
| 2 | 权限收敛：`optional_host_permissions` + 按需注入 + 最小 content script 集 | `chrome://extensions` 权限提示降到可接受 |
| 3 | 商店材料：单一用途说明、隐私政策、截图 | 可提交审核 |
| 4 | 性能门禁进 CI（预算表 §5.1） | 超预算即失败 |

**总计约 44 人日**（≈ 6 周全职 / 9 周业余）。

### P8 · 整页快照（v1.1 已落地｜约 4 人日）

| # | 任务 | 验收 |
|---|---|---|
| 1 | DOM 序列化 + 占位符协议（内容脚本只做 DOM，文本处理全在 core） | 单测覆盖占位符/CSS/转义；真机存图文页可断网打开 |
| 2 | CSS 闭包：`url()`/`@import`/字体；跨域样式表由后台带凭证抓取 | `@import` 展开到深度 3；抓不到时保留绝对地址与媒体条件 |
| 3 | iframe 逐层 `srcdoc` 装配（帧树配对 + 单层转义） | 跨域子文档内容进 `srcdoc`；配对不上就保留原地址 |
| 4 | 预算与降级（单资源 / 总量 / 数量） | 超限只降级不失败，结果卡逐条列出原因；DOM 节点数不设上限（分片遍历，见 `ARCHIVE.md` §4.7） |
| 5 | 防盗链：403 时临时补 Referer 重试（会话规则 + `tabIds:[-1]`） | 规则加得上删得掉；开关只能来自设置 |
| 6 | 体积优化（对齐 SingleFile 默认）：删隐藏元素、精简未使用样式与字体、压缩 HTML | 结果卡列出省下的量；关掉开关后行为回到"原样保存"（`ARCHIVE.md` §4.8） |

> P8 是 v1.1 之后追加的能力，未计入上面的 44 人日；它复用了已有的
> `declarativeNetRequest`、`download_finalize` 与历史记录，没有引入新权限。

---

## 10. 测试与度量体系（没有它，"准确性"只是感觉）

| 层 | 内容 | 工具 |
|---|---|---|
| 单测 | identity / classify / pair / hls 解析 / mpd 解析 / mp4 remux 盒布局 / 命名清洗 / JSONPath | `node:test`（零依赖） |
| 探针门禁 | 现有 2 个探针：修好前应当**失败**（防止"看起来好的回归"） | `node test/probes/*.probe.cjs` |
| 语料 | 24 个 URL × 8 类（YouTube/B 站/腾讯/网易云/QQ音乐/普通 MP4 站/MSE 站/图片站），每个存 `golden.json`（卡片数、标题、变体数、大小、完整性） | Playwright `--load-extension`，快照 diff |
| e2e | 关键路径：发现 → 下载 8MB 测试流 → 校验字节 SHA-256 → 校验 `ffprobe` 流数 | Playwright + 本地 fixture server |
| 性能 | §5.1 预算表，语料页跑 10 次取 P50/P95 | 自定义 harness |
| 回归 | 站点改版时只改 `sites/*.json` 或 `golden.json`，代码不动 | — |

> 语料 harness 是这套路线图里**性价比最高的一件事**：它把"泛用性和准确性"从口号变成可比较的数字。当前项目最大的风险不是写不出功能，而是**改了也不知道是变好还是变坏**。

---

## 11. 风险、合规与许可

| 风险 | 说明 | 对策 |
|---|---|---|
| 版权/DMCA | 下载受版权保护内容是用户行为，但工具形态会被审视 | README 明确"仅限你有权下载的内容"；站点 opt-out 列表；不做 DRM 绕过；不内置任何"破解"逻辑 |
| 商店审核 | 宽权限（`<all_urls>` + `webRequest`）易被判越权 | 单一用途文案；按需注入；`optional_host_permissions`；深度模式默认关闭且需二次确认 |
| 依赖许可 | hls.js/mux.js/mpd-parser = Apache-2.0；mp4box.js = BSD-3；fflate = MIT；ffmpeg.wasm = LGPL（若用） | 本项目建议 **Apache-2.0**；ffmpeg.wasm 作为可选外挂，单独目录 + 许可证声明 + 源码提供链接 |
| 抄 cat-catch | 它是 GPL-3.0 | 只参考产品设计，不复制代码；依赖全部换成 Apache/MIT/BSD 同名能力库 |
| 站点封禁/改版 | 适配器迟早过期 | 适配器数据化 + 失败可诊断 + 社区可提交 JSON |
| 隐私 | `webRequest` 能看到全部请求 | 零遥测；数据只在 `storage.session`/内存；"隐私模式"不写历史；设置页可导出/清空 |
| 性能退化 | 每加一个钩子都可能拖慢页面 | §5.1 预算进 CI，超标即失败 |

---

## 12. 需要你拍板的 6 个选择

| # | 问题 | 选项 A | 选项 B | 建议 |
|---|---|---|---|---|
| 1 | 许可证 | MIT（最宽松，便于被复用） | Apache-2.0（含专利授权） | **Apache-2.0**（依赖多为 Apache-2.0） |
| 2 | 目标浏览器 | 仅 Chrome/Edge | + Firefox | 先 Chrome，架构上留 `browser.*` 适配层 |
| 3 | 深度抓取 | 默认关闭、需确认 | 常开 | **默认关闭**（cat-catch 同款取舍） |
| 4 | 转码 | 不做（只无损提取/重封装） | 可选 ffmpeg.wasm | **可选**，且不与"下载"同一入口，避免体积与许可风险 |
| 5 | 是否上架商店 | 上架（需收敛权限与文案） | 仅 GitHub 分发 | 先 GitHub，架构按可上架标准设计 |
| 6 | 悬浮胶囊 | 保留为默认 | 改为"点选模式"（点了才出现） | 先保留，P6 时做成可选 |

---

## 13. 下一步（本周就能落地的 5 件事）

1. `npm init` + esbuild 构建 + `dist/` —— 不解锁依赖，后面全是空谈。
2. 修 3 个"产错文件"的 bug（B5 兜底、A5 假 MP3、C4 popup/panel 打架）—— 改动量 < 100 行。
3. 把 `computeHash` 换成 `resourceKey` —— 10 行改动，直接消灭"资源凭空消失"。
4. 加 `storage.session` 快照 —— 约 40 行，"切标签页就没了"这个最伤体验的问题立刻消失。
5. 建 `test/corpus` 的第一个 fixture（B 站 + 一个普通 MP4 站），把"卡片数/变体数/大小"写成 golden —— 从此每次改动都有对错。

做完这 5 件事，再回头看 P1–P3，你会发现后面的每一步都变便宜了：因为有了图模型、有了构建、有了基线。
