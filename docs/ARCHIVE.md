# 整页快照（单文件 HTML）

> 对应代码：`core/page-archive.js`、`core/page-frames.js`、`content/page_archiver.js`、
> `bg/archive-fetch.js`、`sidepanel/modules/page_archive.js`、`sidepanel/modules/page_tab.js`。
> 单测：`test/unit/page-archive.test.mjs`、`page-frames.test.mjs`、`archive-fetch.test.mjs`、
> `page-archive-pipeline.test.mjs`、`page-archive-wiring.test.mjs`。

## 1. 它做什么

把当前网页存成**一个** `.html` 文件：图片、样式表、字体、背景图全部内联成 `data:` URI，
脚本、CSP、自动跳转之类"联网才有意义"的东西去掉。结果断网、换电脑、丢进邮件附件都能打开。

这是 [SingleFile](https://github.com/gildas-lormeau/SingleFile) 的核心能力。本仓库按自己的
架构重写了一份（见 §6 许可证），而不是把它的代码搬进来。

**非目标**（明确不做，不是"以后再说"）：

- 不做"自解压压缩包"（SingleFile 的 gzip HTML 单文件），收益是体积，代价是要在文件里塞一段解压脚本；
- 不做注释、书签、自动保存、上传到 GitHub/Google Drive；
- 不做"移除隐藏元素""移除未使用样式"这类需要重排/回流的优化；
- 不做 PDF 导出（那是 `Page.printToPDF` 的事，需要别的权限）。

## 2. 一次归档的流水线

~~~
侧边栏（page_archive.js）             内容脚本（page_archiver.js）            后台（archive-fetch.js）
        │
        │ ① RH_ARCHIVE_COLLECT {frameId}
        ├──────────────────────────────────▶ 克隆 DOM
        │                                    把要内联的地址换成 rhres://<token>/<n>
        │                                    去掉 script / meta-CSP / refresh / preload
        │                                    iframe → rhframe://<token>/<n>
        │ ◀────────────────────────────────── { html, resources[], frames[], token, stats }
        │
        │ ② RH_ARCHIVE_FRAMES ─────────────────────────────────────────────────▶ webNavigation.getAllFrames
        │    对每个子 frame 重复 ①（最多 20 个、最深 3 层）
        │
        │ ③ 样式闭包：css-link / css-text 逐个处理
        │      scanCssReferences → url() → 批量抓 → data URI
        │                          @import → 递归展开（深度 ≤ 3）→ 失败退回绝对地址
        │                                    ┌────────────────────────────────▶ RH_ARCHIVE_FETCH
        │                                    │  credentials:'include'，单资源上限，边读边计数
        │                                    │  403 → 临时补 Referer 重试一次
        │ ④ 二进制批量抓取（每批 6 个，按 URL 去重，受总量预算约束）
        │
        │ ⑤ 装配：帧树从深到浅 —— 子文档先进 srcdoc，再替换父文档占位符
        │ ⑥ 落盘：buildArchiveDocument → Blob → download_finalize（写历史 + chrome.downloads）
        ▼
    一个 .html 文件
~~~

## 3. 三个协议

**资源占位符** `rhres://<token>/<n>`

- `token` 是每次采集随机生成的 10 位字符串，不是固定标记：页面正文里本来就可能出现
  `RH_RES_0` 这类字符串，固定标记会误伤。
- 占位符只出现在**属性值**、`<style>` 文本、`style` 属性三种位置，替换时一次性扫完整份文档
  （`replacePlaceholders`）。替换值不会被二次扫描，所以 data URI 里即使含 `rhres://` 也不会失控。
- CSS 内部的 `url()` **不走**这个替换：样式在装配前就已经被处理成最终的 `url("data:…")`，
  避免"插进去的 CSS 里还有占位符"这种二次展开问题。

**框架占位符** `rhframe://<token>/<n>`

- 内容脚本把 `<iframe src>` 换成它，并打上 `data-rh-frame="n"`；
- 侧边栏按 `frameId/parentFrameId` 建树，用 `src` 与浏览器报告的 frame URL 配对
  （精确匹配 → 退化到只比 pathname），配对不上就**还原成绝对地址**，绝不猜；
- 配对成功后把 `src="rhframe://…"` 整段换成 `srcdoc="…"`（转义一次），并删掉 `data-rh-frame`。

**消息**

| 消息 | 方向 | 作用 |
|---|---|---|
| `RH_ARCHIVE_COLLECT` | 侧边栏 → 内容脚本（指定 `frameId`） | 采集一个 frame |
| `RH_ARCHIVE_FRAMES` | 侧边栏 → 后台 | 列出当前标签页的 frame 树 |
| `RH_ARCHIVE_FETCH` | 侧边栏 → 后台 | 批量抓资源（`kind: binary\|css`） |

`chrome.tabs.sendMessage` **必须**带 `frameId`：不带时会广播给所有 frame，子框架可能抢答，
拿到的就不是主文档。

## 4. 几个关键决定

### 4.1 为什么 CSS 在侧边栏处理，而不是内容脚本

内容脚本是经典脚本（不能 `import`），没有可注入的测试环境。把 CSS 解析、地址解析、转义
全部放进 `core/page-archive.js`（纯函数）之后，"文件打开是坏的"这类风险就有了单测；
内容脚本只剩下"遍历 DOM、换属性"这种一眼能看懂的活。

代价是内容脚本里有一份**最小重复实现**：占位符格式与"绝对化判定"共两处（约 15 行）。
`test/unit/page-archive-wiring.test.mjs` 会检查两边的协议常量一致，防止改一边忘另一边。

### 4.2 为什么用 `srcdoc`，而不是把 iframe 展开成 `<div>`

`srcdoc` 是唯一"不开网络也能显示子文档"的写法，而且保留了 iframe 的样式隔离与文档语义。
展开成 div 会把子文档的 CSS（尤其是 `:root` 变量、`body` 背景）污染到父文档，属于"看起来像
但已经不对"。顺序必须是**最深优先**：子文档先处理完自己的 iframe，再整体作为属性值被父层
转义一次；反过来会出现 `&amp;lt;` 这种双重转义。

### 4.3 为什么用扩展 fetch，而不是页面里的 fetch

`<img>` 能显示，不代表页面脚本能读：跨域图片在页面上下文里会走 CORS，读不到字节。
扩展在持有 `host_permissions` 时可以跨域读响应体，这是"把图内联进去"的前提。

代价是没有 `Referer`（fetch 不允许设置该请求头）。所以抓取失败（401/403/406/412/451/网络错误）时，
后台会用 `declarativeNetRequest` **会话规则**临时给"没有标签页归属的请求"（`tabIds: [-1]`，
也就是扩展自己发的请求）补上页面 Referer 再试一次，用完立刻删规则。该开关在设置里
（默认开），且消息参数**不能**打开它。

### 4.4 为什么默认移除脚本

离线打开一个存下来的页面时，页面脚本既没有原站的后端、也没有原站的 CSP。让它继续跑通常是
坏体验（报错、白屏、重新拉广告），而且"存下来的页面偷偷联网"是隐私问题。所以默认：

- 删除 `<script>`；
- 删除内联 `on*` 事件属性；
- 删除 `href="javascript:…"`；
- 删除 `meta[http-equiv=refresh|content-security-policy|…]`、`<base>`。

想保留动态行为可以在设置里关掉这一项（后果自负：存下来的页面会重新联网）。

### 4.5 为什么冻结 `srcset`

归档的目标是"把这一次渲染冻住"，而 `srcset` + `sizes` 会让浏览器按当前视口重新挑图。
所以 `<img>` 只保留一张（`currentSrc`，即浏览器真正显示的那张），`<picture>` 里的 `<source>`
全部删掉。副作用：响应式图片只剩一个尺寸 —— 这与"单文件"的目标一致。

顺带处理了懒加载：当 `src` 还是占位 `data:` URI 时，从 `data-src` / `data-original` /
`data-lazy-src` / `data-actualsrc` / `data-echo` 里挑第一个 http(s) 地址作为真实资源。
这不是"猜站点"，是通用约定，且只在主地址不可用（不是 http(s)）时才生效。

### 4.6 预算

一次归档可能碰到 4K 图、整套图标字体、几十张背景图。硬上限（`settings` 可调）：

| 项 | 默认 | 行为 |
|---|---|---|
| 单资源 | 4 MiB | 超过就跳过，属性保留在线地址 |
| 整份快照 | 40 MiB | 到上限后停止内联，其余保留在线地址 |
| 资源数 | 400 | 同上 |
| 样式表数 | 60 | 其余 `@import` 不再展开 |
| `@import` 深度 | 3 | 更深的保留绝对地址 |
| iframe | 20 个 / 3 层 | 超出保留绝对地址 |
| DOM 节点 | 40000 | 超过直接拒绝（保护标签页） |

**任何一项超限都不会让整份快照失败**：能内联的内联，不能的保留在线地址，并在结果卡里
如实列出跳过了什么、为什么。这是这个功能的产品原则 —— 宁可少存一点，也不要给一个打不开的文件。

## 5. 失败与降级

| 情况 | 用户看到什么 | 文件里是什么 |
|---|---|---|
| 内容脚本不在（旧版本/受限页） | 自动注入一次再重试 | — |
| 始终不响应 | 「页面没有响应内容脚本……刷新后再试」 | 不产生文件 |
| 页面在采集时改 DOM | 「页面在保存过程中变化，请重试」 | 不产生文件 |
| 图片 403 | 结果卡里列"抓取失败（可能需要登录或被防盗链拦截）" | 绝对地址（联网可显示） |
| 图片超过单资源上限 | "单个文件超过体积上限" | 绝对地址 |
| 总量超预算 | "整份快照超出体积预算" | 前面已内联的保留，后面的用绝对地址 |
| 样式表抓不到 | "抓取失败" | 该 `<style>` 为空（不留半截 CSS） |
| `@import` 抓不到 | — | `@import url("绝对地址") 媒体条件;` |
| 跨域 iframe 抓不到 | "N 个 iframe 没能抓取……已保留原地址" | 原 `src` |
| 画布 | "N 块画布没有内联" | 空白画布 |

## 6. 许可证：为什么是重写而不是复制

SingleFile 是 **AGPL-3.0**，本仓库是 **Apache-2.0**。把 AGPL 代码复制进 Apache-2.0 项目会造成
许可证冲突（AGPL 的传染性会覆盖整个作品），这不是"改改注释"能解决的。同一个理由在本仓库
对待 cat-catch（GPL-3.0）时也用过：**借鉴产品设计，不复制代码**。

具体边界：

- 参考的：功能清单（内联哪些资源、移除哪些东西）、`srcdoc` 装配思路、"保存失败要能解释"的产品取舍；
- 没参考的：它的任何源码、CSS/HTML 处理实现、选项结构、消息协议、字符串；
- 本文件里的所有实现（占位符协议、帧树装配、CSS 闭包、预算模型）都是为本仓库的架构写的，
  与它的实现没有对应关系。

如果将来确实要复用它的代码，正确做法是**整个衍生作品改用 AGPL-3.0**，并满足
AGPL §13 的源码提供义务 —— 那是一个产品决策，不是一次重构。

## 7. 与 SingleFile 的能力对照（实话版）

| 能力 | 本扩展 | 说明 |
|---|---|---|
| 完整 DOM 序列化 | ✅ | `documentElement.cloneNode(true)` |
| 图片/图标/封面/ SVG 内联 | ✅ | 含 `currentSrc` 与懒加载兜底 |
| 样式表内联（含跨域） | ✅ | 后台带凭证抓取 |
| `url()` / `@import` / 字体 | ✅ | 递归展开，失败保底 |
| iframe 内嵌 | ✅（跨域需要内容脚本在子框架里） | `srcdoc` |
| 移除脚本 | ✅（默认） | 含内联事件属性 |
| 移除隐藏元素 / 未使用 CSS | ❌ | 需要重排/回流的启发式，收益不确定 |
| 压缩 HTML | ❌ | 收益有限，且会让 diff 变得不可读 |
| 自解压单文件（gzip） | ❌ | 需要在产物里塞解压脚本 |
| Canvas / WebGL 快照 | ❌ | 跨域污染 + 需运行时重绘 |
| 视频/音频内联 | ❌（保留在线地址） | 体积上不现实 |
| Shadow DOM | ❌ | `cloneNode` 不复制影子树；结果里是空的宿主元素 |
| 保存选区 | ✅（选项） | `range.cloneContents()`，此时拿不到 `currentSrc` |
| 注解 / 书签 / 自动保存 / 云盘 | ❌ | 不在本扩展的产品范围内 |

## 8. 已知限制

1. **Shadow DOM 内容会丢**：宿主元素存下来了，影子树没有。Web Components 站点会缺块。
2. **`<template>` 里的资源不处理**：序列化器按"元素树"遍历，模板内容是独立片段。
3. **画布是空白**：不做 `toDataURL`（跨域图会污染画布，且大量站点用它实时绘制）。
4. **跨域 iframe 依赖子框架里的内容脚本**：`about:blank`、`data:`、被浏览器禁止注入的框架
   拿不到内容，会保留原地址；本身带 `srcdoc` 的 iframe 也原样保留（它已经是内联文档，
   再嵌一层会出现重复属性，内容会张冠李戴）。
5. **不内联 `background-image` 的"计算样式"**：只处理样式表与 `style` 属性里写出来的地址；
   由脚本在运行时设置的背景图不在范围内。
6. **`srcset` 只保留当前那一张**：见 §4.5。
7. **超时与重试**：单次抓取 20 秒超时，不做重试（除 Referer 重试一次）。慢站会缺图。
8. **整个装配在侧边栏内存里完成**：几十 MB 的页面会占用面板内存；关闭面板会中断本次保存。
9. **仅在 Chromium 124+ 上按 `document_idle` + `all_frames` 设计**，未在 Firefox 验证。

## 9. 怎么验证

已被单测覆盖（`npm test`）：

- 占位符生成/解析/一次替换；CSS 扫描（引号、转义、`@import` 媒体条件、`#fragment` 跳过）；
- CSS 重写与三类转义（属性值 / `<style>` 文本 / CSS 字符串）；base64 编解码往返；
- 文档装配、文件名模板与非法字符、选项规整、预算归类；
- 帧树（含环）、配对（含重定向 fallback 与"不串框"）、`srcdoc` 单层转义；
- 完整流水线（假依赖）：同源/跨域抓取、去重、`@import` 展开、抓取失败降级、iframe 装配、
  内容脚本缺失时的注入重试、总量预算、消息契约；
- 接线守卫：manifest 注册、协议常量一致、后台接口、Tab 接线、设置项齐全。

**没有**被自动覆盖的部分（需要在真实 Chrome 里手测）：

1. DOM 序列化本身（`page_archiver.js`）—— Node 里没有 DOM；
2. `chrome.tabs.sendMessage` 的 `frameId` 语义、`declarativeNetRequest` 会话规则
   （`tabIds: [-1]` 是否命中扩展请求）—— 只能在扩展环境验证；
3. 真实站点的 `Content-Type`/`Content-Length` 缺失、压缩传输、大文件流式读取。

建议的手测清单（5 分钟）：

1. 打开一个图文长页（例如维基百科条目）→ 保存 → 断网 → 打开文件：图片与排版是否完整；
2. 打开一个带跨域 iframe 的页面（例如嵌了 YouTube/B 站播放器的文章）→ 保存 → 检查
   `iframe` 的 `srcdoc` 是否有内容；
3. 打开一个用 webfont 的站点 → 保存 → 断网打开：字形是否正常（字体已内联）；
4. 打开一个防盗链图床页面 → 保存 → 看结果卡里"跳过"的原因是不是 403；
5. 在 `chrome://extensions` 里看 Service Worker 控制台有没有 `updateSessionRules` 报错。
