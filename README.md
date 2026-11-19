<div align="center">

<img src="src/bitmaps/logo-128-color.png" width="112" height="112" alt="ResourceHelper logo" />

# ResourceHelper · 资源助手

**本地运行的浏览器资源嗅探与下载扩展 —— 视频 / 音频 / 图片 / 文本 / 整页快照**

[![CI](https://github.com/FutureOrigin/ResourceHelper/actions/workflows/ci.yml/badge.svg)](https://github.com/FutureOrigin/ResourceHelper/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4.svg)
![Chrome 114+](https://img.shields.io/badge/Chrome-%E2%89%A5%20114-34A853.svg)
![Runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)
[![Tests](https://img.shields.io/badge/tests-410%20passing-brightgreen.svg)](#测试与质量门禁)
![Node 22+](https://img.shields.io/badge/Node-%E2%89%A5%2022-339933.svg)

[简体中文](README.md) · [English](#english) · [文档](docs/) · [路线图](docs/ROADMAP.md) · [参与贡献](docs/CONTRIBUTING.md)

</div>

---

## English

**ResourceHelper** is a local-first browser extension (Manifest V3) that discovers and downloads the
media a page is actually playing: videos (plain MP4, HLS, DASH, fragmented MP4), audio, images, and
protected text. It can also save a page as a single self-contained HTML file.

Highlights:

- **Nothing leaves your machine** — no server, no telemetry, no analytics, no accounts.
- **Zero runtime dependencies** — plain ES modules, no bundler; the build script uses only Node built-ins.
- **Honest about failure** — DRM (EME / Widevine / FairPlay) is detected and refused, never bypassed;
  a missing audio track is reported instead of producing a silent or mislabelled file.
- **Engine runs off the side panel** — HLS/DASH/mux jobs run in an offscreen document, so closing the
  panel does not kill the download.
- **Tested** — 410 unit tests, a site-corpus regression gate, an efficiency benchmark and bug probes.

> The UI, documentation and commit messages are in Chinese. Issues and pull requests in English are welcome.
> Full instructions live in [docs/](docs/).

---

## 目录

- [能做什么](#能做什么)
- [明确不做](#明确不做)
- [快速开始](#快速开始)
- [使用](#使用)
- [开发](#开发)
- [测试与质量门禁](#测试与质量门禁)
- [项目结构](#项目结构)
- [新增站点适配器](#新增站点适配器)
- [文档](#文档)
- [参与贡献](#参与贡献)
- [安全与隐私](#安全与隐私)
- [许可证](#许可证)
- [免责声明](#免责声明)

## 能做什么

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 网络层媒体发现 | ✅ 可用 | 旁路观察 `webRequest`（只读），按 URL、响应类型与站点关键词识别媒体请求，不修改任何请求 |
| 声明式站点适配器 | ✅ 可用 | `src/sites/*.json` 用 JSONPath 子集把页面数据映射成变体；已内置 B 站、YouTube 与通用 DOM 兜底 |
| 站点特征覆盖 | ✅ 可用 | 腾讯视频、抖音、网易云音乐、QQ 音乐、酷狗、酷我 等通过域名规则 + 防盗链规则覆盖，无需额外代码 |
| 单文件下载 | ✅ 可用 | `chrome.downloads` 直连，带进度回传与失败归因（缺音轨 / 缺 init / DRM / 需登录 / 被防盗链拒绝） |
| HLS（m3u8） | ✅ 可用 | 解析主/媒体播放列表，并发下载 + 按序拼装，支持独立音轨组（`#EXT-X-MEDIA`）自动合流 |
| DASH（mpd） | ✅ 可用 | 解析 MPD，支持多变体、SegmentBase / SegmentTemplate、密钥与重试 |
| 音画合流 | ✅ 可用 | 采样级 remux（整文件与 fMP4 分片），重写 `stco` 偏移，合流前检查体积预算 |
| 直播录制 | ✅ 可用 | HLS 滚动播放列表按序列号增量采集、边播边录、滚动落盘 |
| 图片扫描 | ✅ 可用 | DOM + Shadow DOM + `srcset` + 背景图 + 动态网络图，支持批量下载 |
| 文本解禁与正文提取 | ✅ 可用 | 解除 `user-select` 与事件拦截，正文转 Markdown；**字体反爬**（私用区码位）还原成真字 |
| 整页快照 | ✅ 可用 | 图片 / 样式表 / 字体 / 背景图内联为 `data:` URI，iframe 走 `srcdoc`，产物断网可开；默认做体积优化（隐藏元素 / 未使用样式与字体 / HTML 压缩），可逐项关掉 |
| 页面内悬浮按钮 | ✅ 可用 | Shadow DOM 隔离，跟手显示在 `<video>` 上 |
| 下载历史与设置 | ✅ 可用 | 四类下载路径统一留痕、状态随 `downloads` 事件更新；设置同步到 Chrome 账号 |

## 明确不做

这些不是"以后再说"，而是产品边界：

- **不下载 DRM 内容**：EME / Widevine / FairPlay / `SAMPLE-AES` 一律识别并如实告知，不做任何绕过。
- **不做假 MP3**：站点没有独立音轨时明确拒绝，而不是把视频轨改个后缀交给你。
- **不做"万能"字体还原**：内置指纹表来自思源黑体（SourceHanSansSC-Normal 2.002），
  换参考字体的站点如实报「未能还原」，不瞎猜。
- **不做云端解析**：没有服务器，没有遥测，没有账号。
- **不替换页面的 `fetch` / `XMLHttpRequest`**：只用 `PerformanceObserver` 旁路读取，
  页面自己的请求被 CSP 拦下时报错不会落到扩展头上。
- **不承诺完整网页克隆**：Shadow DOM、`<template>`、画布、音视频流不内联；跨域 iframe 拿不到就保留原地址。

## 快速开始

**环境要求**

- Chrome / Edge **114+**（Manifest V3，`sidePanel` + `offscreen`）
- Node.js **22+**（仅构建与测试需要；扩展本身零依赖、离线可用）

```bash
git clone https://github.com/FutureOrigin/ResourceHelper.git
cd ResourceHelper
npm run build        # src/ -> out/ResourceHelper
```

安装（开发者模式）：

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启「开发者模式」；
2. 点「加载已解压的扩展程序」，选择 `out/ResourceHelper`；
3. 点击工具栏图标，或按 <kbd>Alt</kbd>+<kbd>Up</kbd> 打开侧边栏；<kbd>Alt</kbd>+<kbd>Down</kbd> 在当前标签页打开。

> 升级时先 `npm run build`，再在扩展页点一次「重新加载」。

## 使用

侧边栏由六个页签组成，每个页签只做一件事：

| 页签 | 你会看到 | 典型操作 |
| --- | --- | --- |
| 视频 | 当前页面的视频资源，按逻辑视频聚合成卡片，画质/编码是子项 | 选画质下载；HLS/DASH 走引擎下载；MSE 页面提示「边播边录」 |
| 音频 | 独立音轨与音频文件 | 下载、试听；缺音轨时会说明原因 |
| 图片 | DOM / Shadow DOM / 背景图 / 动态网络图，可按尺寸过滤 | 多选批量下载 |
| 文本 | 正文提取结果（Markdown） | 点「解除限制」后可复制；点「提取正文」导出 |
| 快照 | 整页快照的选项与进度 | 保存为单文件 HTML，结果卡会列出跳过了什么 |
| 下载 | 下载历史与进行中的任务 | 查看进度、取消排队、按模式重下、清空历史 |

设置页（`chrome://extensions` → 详情 → 扩展程序选项）提供：深度模式、MSE 提示、
图片最小边长、单页条数上限、文件名模板（`{title} {quality} {ext} {site} {date}`）。

**快捷键**：<kbd>Alt</kbd>+<kbd>Up</kbd> 打开侧边栏 · <kbd>Alt</kbd>+<kbd>Down</kbd> 在当前标签页打开。

## 开发

零运行时依赖，构建脚本只用 Node 内置模块；没有打包器，源码即产物（构建时只做复制、版本注入与门禁）。

```bash
npm run build      # 复制 src/ -> out/ResourceHelper + 版本注入 + 语法门禁 + 资产门禁
npm test           # node:test 单元测试（决策层 / 图 / 合流 / HLS / DASH / 适配器 / 守卫）
npm run corpus     # 站点语料回归 + KPI 门禁（泛用性 P / 准确性 A，未达标即失败）
npm run bench      # 效率基准：SW 分类 / 5000 节点扫描 / 下载峰值内存
npm run diagnose   # 缺陷探针（已知坏 → 修复后转绿）
npm run check      # 以上全部串起来跑一遍：提交前请确保通过
```

`test/fixtures/real/` 里是真实线上清单（Apple HLS、Akamai DASH），用来验证解析器吃真货而不是只吃合成数据。

## 测试与质量门禁

| 门禁 | 内容 | 通过标准 |
| --- | --- | --- |
| 单元测试 | `npm test`，448 个用例 | 全绿 |
| 语料回归 | `npm run corpus`，10 种页面形态的 golden 比对 | 泛用性与准确性 KPI 达标 |
| 效率基准 | `npm run bench`，分类 / 扫描 / 内存三项 | 不超过目标 4 倍 |
| 缺陷探针 | `npm run diagnose`，复现历史缺陷 | 全部 `[通过]` |
| 构建门禁 | `npm run build`，语法检查 + manifest 资产存在性 | 无问题项 |

CI 见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。

## 项目结构

```
src/
  manifest.json          扩展清单（MV3）
  service/               后台 Service Worker：消息路由、抓包、归属、下载决策
  content/               内容脚本：页面数据采集、悬浮层、文本解禁、整页快照、主世界钩子
  sidepanel/             侧边栏 UI（视频 / 音频 / 图片 / 文本 / 快照 / 下载）
  options/               设置页
  sites/                 声明式站点适配器（JSON）
  bg/                    后台专用模块（持久化、归属、适配器加载、历史、设置）
  core/                  与平台无关的纯逻辑（决策 / 图 / 解析 / 合流 / 队列 / 字体还原）
  ui/                    DOM 构造器与静态图标
  data/                  字形指纹表（源自思源黑体，见 docs/THIRD-PARTY.md）
test/
  unit/                  单元测试
  corpus/                站点语料与 KPI 门禁
  bench/                 效率基准
  probes/                缺陷探针
  fixtures/              真实清单与字体样本
tools/                   构建与诊断脚本
docs/                    架构、路线图、设计与合规文档
out/ResourceHelper/      构建产物（已 gitignore）
```

## 新增站点适配器

**加一个站点 = 加一个 JSON**，不需要改内容脚本：

1. 在 `src/sites/` 下新建（照抄 `bilibili.json`），写 `id` / `priority` / `match`；
2. 用 JSONPath 子集把页面数据映射成变体（`$.a.b[*]`、`||` 兜底、`==` / `contains`）；
3. 在 `src/bg/adapters.js` 的 `ADAPTER_FILES` 注册（有守卫测试会提醒）；
4. 在 `test/corpus/` 加一份 fixture + 一个 case，`npm run corpus` 会给出 KPI 结论。

如果站点只是把流放进 `<video>` / `<audio>`，**一行代码都不用写** —— `generic-dom.json` 已经兜住这种情况。
细节见 [docs/SITE-ADAPTERS.md](docs/SITE-ADAPTERS.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 运行时组成、数据流、不变量与架构债 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 目标架构、KPI 与迭代计划、验收标准 |
| [docs/AUDIT.md](docs/AUDIT.md) | 历史审计：v1.0.0 的 57 项问题清单与可复现证据（多数已在 P0–P8 修复） |
| [docs/ARCHIVE.md](docs/ARCHIVE.md) | 整页快照：流水线、协议、预算、许可证边界与已知限制 |
| [docs/OFFSCREEN.md](docs/OFFSCREEN.md) | 下载引擎搬离侧边栏的选型、协议与验证计划 |
| [docs/SITE-ADAPTERS.md](docs/SITE-ADAPTERS.md) | 站点适配器规格与新增流程 |
| [docs/PRIVACY.md](docs/PRIVACY.md) | 隐私说明：接触到什么、不做什么、数据如何删除 |
| [docs/STORE.md](docs/STORE.md) | 上架材料：权限表、数据流、已知限制、检查清单 |
| [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md) | 第三方资源与许可证（思源黑体 OFL 1.1 等） |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 变更记录 |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | 贡献指南（分支、提交、测试、文档） |
| [docs/SECURITY.md](docs/SECURITY.md) | 安全问题报告流程 |
| [docs/CODE_OF_CONDUCT.md](docs/CODE_OF_CONDUCT.md) | 社区行为准则 |
| [AGENTS.md](AGENTS.md) | 项目规范与 AI 协作守则（给人和 AI 的工程契约） |

## 参与贡献

欢迎 issue 与 pull request。开始之前请读 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)，
并确认 `npm run check` 在本地通过。提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)。

特别欢迎这类贡献：

- 新的站点适配器 + 对应语料（最容易上手，也最有用）；
- 真实站点的问题复现（附页面地址、现象、侧边栏截图）；
- HLS/DASH 边角情况、直播录制、合流正确性；
- 文档纠错：文档与代码不一致时，以代码为准，并请顺手修文档。

## 安全与隐私

- 全部解析在本机完成，**不上传任何数据、不含遥测**；没有服务器，也没有账号体系。
- 扩展会接触什么、为什么需要那些权限，见 [docs/PRIVACY.md](docs/PRIVACY.md) 与 [docs/STORE.md](docs/STORE.md)。
- 发现安全问题时请通过 GitHub 的私密漏洞报告（Security → Report a vulnerability）提交，见 [docs/SECURITY.md](docs/SECURITY.md)。

## 许可证

[Apache-2.0](LICENSE) © 2026 ResourceHelper contributors。

捆绑的第三方资源（字体字形指纹表等）遵循其各自许可证，见 [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md)。

本仓库**不包含**任何第三方专有软件的代码：所有实现均为本项目的独立实现（含整页快照能力，
按 SingleFile 的功能边界重写而非移植，见 [docs/ARCHIVE.md](docs/ARCHIVE.md) §6）。

## 免责声明

本扩展仅供**下载你拥有版权或已获授权**的内容。使用者需自行承担由此产生的全部法律责任；
作者不对任何直接或间接后果负责。请遵守你所在地区的法律与所访问站点的服务条款。
