# 站点适配器（声明式 JSON）

> 对应代码：`src/core/site-engine.js`（求值引擎）、`src/bg/adapters.js`（加载注册）、
> `src/sites/*.json`（适配器）、`test/corpus/`（语料与 KPI 门禁）。
>
> 设计动机：站点知识应该是**数据**，不是散落在内容脚本里的 `if` 分支。加一个站点 = 加一个 JSON，
> 不发版改核心文件。

## 1. 三层发现，适配器只是其中一层

| 层 | 谁在干活 | 产出 |
| --- | --- | --- |
| 网络层 | `service/background.js` 旁路观察 `webRequest` | "有一条看起来像媒体的请求" |
| 页面数据层 | `content/extractor.js` 采集内联 JSON / DOM 媒体元素 | 原始页面数据（不做站点判断） |
| **适配器层** | `src/sites/*.json` + `core/site-engine.js` | 把页面数据映射成**媒体变体**（清晰度、音轨、DRM） |

三层的结果在资源图里合并：URL 相同的观测只会出一次卡（I1/I2）。所以适配器缺一个字段时，
网络层仍然能兜住"有这条资源"，只是拿不到清晰度、音轨归属等结构化信息。

## 2. 适配器结构

```json
{
  "id": "bilibili-video",
  "version": 1,
  "priority": 10,
  "match": ["*.bilibili.com/video/*", "*.bilibili.com/list/*"],
  "title": ["$.data.videoData.title", "$doc.title"],
  "titleCleanup": ["\\s*[-_—|]\\s*哔哩哔哩.*$"],
  "media": {
    "id": "$.data.bvid || $.bvid",
    "drm": "$.data.is_drm == 1",
    "video": {
      "each": "$.data.dash.video[*]",
      "url": "$.baseUrl || $.backupUrl[0]",
      "quality": "$.id",
      "width": "$.width",
      "height": "$.height",
      "bitrate": "$.bandwidth",
      "codec": "$.codecs",
      "videoOnly": true,
      "labels": { "80": "1080P 高清" }
    },
    "audio": {
      "each": "$.data.dash.audio[*]",
      "url": "$.baseUrl || $.backupUrl[0]",
      "bitrate": "$.bandwidth",
      "lang": "$.lang"
    }
  },
  "headers": { "Referer": "https://www.bilibili.com/" },
  "referer": "https://www.bilibili.com/"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 适配器标识，只用于调试与语料报告 |
| `priority` | ✅ | 数字，越大越先执行。站点适配器用 10，`generic-dom` 固定 0 |
| `match` | ✅ | URL 通配（`*` 转 `.*`，其余字符按字面量匹配）。`["*"]` 表示兜底 |
| `title` | ✅ | 标题表达式数组，按顺序用 `||` 兜底（通常是页面标题 → `$doc.title`） |
| `titleCleanup` | — | 正则数组，从标题里剥掉站点后缀（如 ` - 哔哩哔哩`） |
| `media.id` | — | 逻辑媒体 ID（如 bvid）。**不给**时由调用方按 URL 分组 |
| `media.drm` | — | 布尔表达式；真值会让整条媒体标记为 DRM 并拒绝下载 |
| `media.video` / `media.audio` | 至少一个 | 变体规格，见下 |
| `headers` / `referer` | — | 下载时附带的请求头提示（后台按站点规则使用） |

变体规格（`video` / `audio` 两个对象）：

| 字段 | 说明 |
| --- | --- |
| `each` | 展开数组的表达式（`$.data.dash.video[*]`）。求值结果里的每一项成为"当前项" |
| `filter` | 在同一数组里混有音视频时用来分流（`$.kind == 'video'`） |
| `url` | 变体地址，必填；为空则该变体被丢弃 |
| `id` / `quality` / `width` / `height` / `bitrate` / `codec` / `lang` | 结构化元数据 |
| `container` | 容器/扩展名提示（如 `mp4`）。最终扩展名仍以嗅探结果为准（I5） |
| `videoOnly` | `true` 表示这是纯视频轨，必须配到音轨才可播放（I3） |
| `labels` | `quality → 人类可读标签` 的映射（"1080P 高清"） |

## 3. 表达式语法（够用的 JSONPath 子集）

| 语法 | 含义 |
| --- | --- |
| `$.a.b` | 取属性 |
| `$.a[0]` | 取数组下标 |
| `$.a[*]` | 展开数组（产生多个结果） |
| `$.a \|\| $.b \|\| '字面量'` | 依次尝试，取第一个非空值 |
| `$.x == 1` | 比较（支持字符串 / 数字 / `true` / `false` / `null`） |
| `$.x contains 'v'` | 子串判断，返回布尔 |
| `$doc.title` / `$doc.url` | 页面上下文（标题、地址） |
| `$media[*]` | 内容脚本采集到的 DOM 媒体元素 |
| `'字面量'` | 带引号即字面量，不会被当成路径 |

限制（刻意不做）：没有函数调用、没有算术、没有过滤器语法、没有递归下降。
够用就好——复杂到需要写代码时，说明这个站点应该在 `src/core/` 里新增能力，而不是把引擎做成 JS。

## 4. 新增站点的完整流程

1. **看数据**：在目标页面的控制台里找到播放器数据（内联 JSON 变量、`window.__INITIAL_STATE__`、
   `<video>` 元素等）。**只读公开数据，不要逆向压缩代码或破解加密参数。**
2. **写适配器**：`src/sites/<站点>.json`，从 `bilibili.json` 复制结构。
3. **注册**：在 `src/bg/adapters.js` 的 `ADAPTER_FILES` 里加一行（有守卫测试会提醒你忘了）。
4. **加语料**：
   - `test/corpus/fixtures/<站点>.json`：页面数据的**脱敏样本**（去掉签名、token、个人信息）；
   - `test/corpus/cases/<站点>.json`：声明期望结果（卡片数、标题、清晰度、DRM 判定等）。
5. **跑门禁**：`npm run corpus`，再看 `npm test`（`site-engine` 与 `module-graph` 守卫）。
6. **写文档**：在 [CHANGELOG.md](CHANGELOG.md) 记一条；如果站点能力有特殊限制，写进对应文档的「已知限制」。

## 5. 语料（fixture / case）怎么写

```json
{
  "name": "bilibili-video",
  "url": "https://www.bilibili.com/video/BV1xx411c7mD",
  "title": "【测试】某视频_哔哩哔哩_bilibili",
  "fixture": "bilibili-playinfo.json",
  "domMedia": [],
  "expect": {
    "matchedAdapter": "bilibili-video",
    "variantCount": 6,
    "title": "【测试】某视频",
    "hasAudio": true,
    "drm": false
  }
}
```

- fixture 必须**脱敏**：签名 URL 换成 `https://example.invalid/...` 或保留域名但去掉查询参数；
- 负例也要有：DRM 页面、只有图片的页面、空数据页面（见 `negative-blank.json`）；
- 语料 KPI 是门禁：泛用性 P 与准确性 A 未达标会直接失败，**不要**通过调低阈值来通过。

## 6. 什么时候不该写适配器

- 站点只用 `<video src>` / `<audio src>` 播放 → `generic-dom.json` 已经覆盖，不用写；
- 站点把流喂给 MSE（`blob:`）→ 适配器拿不到 URL，应该用「边播边录」；
- 需要解密、签名计算、破解混淆 → **不做**。这是产品边界，不是能力缺口。
