# AGENTS.md · 项目规范与 AI 协作守则

> 这是本仓库的**工程契约**。任何人（以及任何 AI 代理：Claude Code / Codex / Cursor / Copilot / 其他）
> 在改代码、改文档、提 PR 之前都必须读完本文。
>
> 分工：`README.md` 面向**使用者**，`docs/` 面向**理解者**，本文面向**修改者**。
> 三者冲突时：代码 > 本文 > docs/ > README。

---

## 0. 一分钟速览

```bash
node --version      # 需要 >= 22
npm run build       # src/ -> out/ResourceHelper（语法门禁 + manifest 资产门禁）
npm test            # 437 个单元测试
npm run corpus      # 站点语料回归 + KPI 门禁
npm run bench       # 效率基准
npm run diagnose    # 缺陷探针
npm run check       # 上面全部；提交前必须通过
```

**十条硬性红线**（违反其中任何一条，改动都不算完成）：

1. 不下载、不绕过 DRM（EME / Widevine / FairPlay / SAMPLE-AES），只识别并如实告知。
2. 不得引入第三方专有代码、逆向产物或"参考实现"的复制粘贴。
3. 不引入运行时依赖；构建脚本只用 Node 内置模块。
4. 不用字符串拼 HTML（`innerHTML` / `outerHTML` / `insertAdjacentHTML` 接页面数据）。
5. 不替换页面的 `fetch` / `XMLHttpRequest`，不注入 `<script>`，不用 `eval` / `new Function`。
6. 不加遥测、不上传数据、不请求开发者自己的服务器（本项目没有服务器）。
7. 不新增 manifest 权限。确有必要时，必须同时改 `test/unit/manifest.test.mjs` 与 `docs/STORE.md`、`docs/PRIVACY.md`。
8. 不删除、不弱化测试来"让 CI 变绿"；只能让实现符合测试，或与维护者讨论后修改测试语义。
9. 不把 `out/`、`work/`、密钥、抓包语料、个人路径提交进仓库。
10. 不在一个 PR 里做无关的重排/重命名/格式化，让别人能读懂 diff。

---

## 1. 项目定位与产品边界

**一句话**：一个完全本地运行、零依赖、对失败诚实的浏览器资源嗅探与下载扩展。

不可谈判的边界（产品决策，不是技术限制）：

| 边界 | 原因 |
| --- | --- |
| 不碰 DRM | 法律与道德红线；识别并拒绝是功能，不是缺陷 |
| 不做假 MP3 / 假扩展名 | 宁可拒绝，也不产出"看起来成功"的坏文件 |
| 不做云端解析、不做账号体系 | 隐私是第一卖点，也是与商业产品的差异化 |
| 不上传任何数据 | 没有服务器；任何"上报"都应被视为 bug |
| 失败必须可解释 | 缺音轨 / 缺 init / DRM / 需登录 / 被防盗链拒绝，都要说清是哪一种 |

---

## 2. 目录与职责

| 路径 | 职责 | 改动注意 |
| --- | --- | --- |
| `src/service/background.js` | Service Worker：消息路由、`webRequest` 旁路观察、归属、下载决策、DNR 规则 | 不要在这里写站点解析逻辑 |
| `src/content/` | 内容脚本：页面数据采集、悬浮层、文本解禁、整页快照、主世界钩子 | 只**采集**，不判定、不命名资源 |
| `src/sidepanel/` | 侧边栏 UI（视频/音频/图片/文本/快照/下载） | 只读资源图、只发命令 |
| `src/options/` | 设置页 | 新增设置项要同步 `core/settings.js` 与默认值 |
| `src/sites/*.json` | 声明式站点适配器 | 加站点优先加 JSON，不要加代码 |
| `src/bg/` | 后台专用模块（持久化、归属、适配器加载、历史、设置） | 需要 `chrome.*` 的放这里 |
| `src/core/` | 与平台无关的纯逻辑（决策/图/解析/合流/队列/字体） | **必须可单测**，不得 import `chrome.*` |
| `src/data/` | 字形指纹表等生成物 | 由 `tools/build-glyph-table.mjs` 生成，不要手改 |
| `test/unit/` | 单元测试 | 新增纯逻辑必须配测试 |
| `test/corpus/` | 站点语料与 golden | 新增站点必须配 fixture + case |
| `test/bench/`, `test/probes/` | 效率基准 / 缺陷探针 | 探针语义是"复现已知缺陷" |
| `tools/` | 构建、建表、诊断脚本 | 必须零依赖、跨平台 |
| `docs/` | 面向贡献者与审核者的文档 | 行为变了就同一 PR 里改文档 |

---

## 3. 架构不变量（改代码前先自查）

| 编号 | 不变量 | 具体含义 |
| --- | --- | --- |
| **I1** 身份唯一 | 每条资源有稳定、无碰撞的身份键 | 规范化 URL + 内容指纹；**禁止**用 32 位哈希做身份 |
| **I2** 逻辑唯一 | 一条视频 = 一张卡片，画质是子项 | 变体 / 镜像 / 分片挂在父节点下，不各占一张卡 |
| **I3** 依赖闭合 | 能播放才算资源，缺依赖标"不完整" | 播放列表→分片、视频轨→音轨、init segment 都必须闭合 |
| **I4** 归属确定 | 资源知道自己属于哪个 tab / document / frame / 导航代次 | **禁止**"找不到就随便挑第一条" |
| **I5** 保真 | 扩展名 / 体积 / 时长 / DRM 来自观测 | 魔数嗅探 + `Content-Length` / `Content-Disposition`，不靠猜 |

数据流方向：**采集（L2）→ 图（L3）→ 命令与任务（L4）→ UI（L5）**。
下层不得反向依赖上层；UI 永远不直接发网络请求。

---

## 4. 编码规范

- **模块**：ES Modules（`"type": "module"`），具名导出优先；import 必须带 `.js` 扩展名。
- **格式**：2 空格缩进、单引号、必须写分号、行宽约 120；LF 换行；UTF-8。
- **无 TypeScript、无打包器**：源码即产物；`src/` 里的文件会被原样复制到 `out/`。
- **注释写"为什么"**，不是"做什么"。涉及取舍时引用对应的 `AUDIT` 编号或文档章节。
  注释用中文，与现有代码保持一致。
- **命名**：`camelCase` 变量/函数、`PascalCase` 类、`SCREAMING_SNAKE` 常量；
  消息类型用 `RH_` 前缀（如 `RH_GET_MEDIA`）；存储键集中在 `core/settings.js` / `bg/*`。
- **错误处理**：面向用户的失败必须有归因；内部异常可以 `catch` 后返回 `null`，
  但**不允许**静默吞掉后返回一个"看起来能用"的错值。
- **DOM**：一律 `document.createElement` + `textContent`（见 `src/ui/dom.js`）；
  任何来自页面的字符串都当作不可信输入。
- **异步**：不要在没有必要的场景引入轮询；优先事件驱动（`webRequest` / `PerformanceObserver` / `storage.onChanged`）。
- **零依赖**：`dependencies` 必须为空。确需依赖时先在 issue 里讨论（体积、许可证、CSP、离线可用性）。

---

## 5. 测试规范

- 框架：`node:test` + `node:assert/strict`，文件名 `*.test.mjs`。
- 每个用例的标题是**一句中文行为描述**（`test('缺音轨时不生成假 MP3', ...)`），不写 `test1` 这类名字。
- 纯逻辑放 `src/core/`，测试直接 import，**不要**为了测试去 mock `chrome.*`；
  需要 `chrome.*` 的模块把逻辑抽出去，而不是把测试写成假浏览器。
- 新增/修复缺陷时：先让探针或测试复现（红），再修（绿）。探针放 `test/probes/`。
- 守卫测试是刻意存在的（权限清单、无 `innerHTML`、模块图、manifest 资产、接线检查）。
  它们失败时通常意味着"你漏了一处接线"，而不是"测试太严"。
- 语料门禁（`npm run corpus`）有 KPI 阈值：**不允许**通过调低阈值来通过。
- 不允许跳过测试（`skip`/`todo`）来交付功能。
- 性能敏感改动请跑 `npm run bench`，并说明前后差异。

---

## 6. 文档规范

- 文档全部在 `docs/`，用中文写；面向国际贡献者的摘要放在 `README.md` 的 English 段。
- 新增文档：加入 `README.md` 的「文档」表；否则它等于不存在。
- **行为变了就改文档**：同一 PR 内更新对应的 `docs/*.md`，以及 `docs/CHANGELOG.md`。
- 文档里不要写"声明式"但未实现的能力。已知限制必须如实列出（这是本项目的信誉来源）。
- 不要在公开文档里粘贴第三方专有软件的逆向细节、密钥、内部接口。
- 文档引用代码时写相对路径 + 章节号（如 `docs/ARCHIVE.md` §6），不要写本机绝对路径。

---

## 7. 提交与分支规范

- 提交信息：**Conventional Commits**，允许中文描述。
  `<type>(<scope>): <描述>`，例如 `fix(mux): 重写 stco 偏移，双轨合流不再错位`。
  - type：`feat` `fix` `docs` `test` `refactor` `perf` `build` `chore`
  - scope：`sidepanel` `content` `service` `core` `hls` `dash` `mux` `graph` `sites` `snapshot` `docs` `test` `build`
- 一个提交只做一件事；重构与行为变更分开。
- 分支：`feat/<简述>`、`fix/<简述>`、`docs/<简述>`；PR 目标分支为 `main`。
- 不提交 `out/`、`work/`、`node_modules/`、`*.crx`、`*.pem`。
- 不 force-push 别人正在 review 的分支；不 rebase 已合入的主干。
- 不重写已发布的历史（除非维护者明确要求清理敏感信息）。

---

## 8. 依赖与许可证政策

- 项目许可证：**Apache-2.0**；贡献即表示同意以同一许可证发布（inbound = outbound）。
- `dependencies` 必须为空；`devDependencies` 目前也为空。新增任何依赖都需要先讨论。
- **禁止**复制 AGPL / GPL 代码（例如 SingleFile 是 AGPL-3.0；本项目只借鉴功能边界并独立实现）。
- 引入第三方资源（字体、图标、样本、数据表）必须：
  1. 许可证允许再分发；
  2. 在 `docs/THIRD-PARTY.md` 登记来源、版本、许可证与是否修改；
  3. 必要时把许可证全文放进 `docs/licenses/`。
- `src/data/glyph-table.bin` 是思源黑体（SIL OFL 1.1）的**派生数据**，不要删除其来源说明。

---

## 9. 安全与隐私红线

- `webRequest` 只读元信息，**不读请求体/响应体**。
- Cookie 只在用户显式点击的动作（如整页快照）里、且只向资源自身域名发送。
- 不把页面内容、下载历史、URL 发往任何第三方；没有遥测。
- 不在仓库里放：密钥、令牌、个人路径、真实用户数据、抓包文件。
- 提交前自查：`git diff` 里是否出现 `Bearer`、`token=`、绝对路径、邮箱、内网地址。
- 安全问题的处理流程见 `docs/SECURITY.md`；不要在公开 issue 里贴可用攻击代码。

---

## 10. AI 协作守则

面向在本仓库工作的 AI 代理（也适用于"让 AI 帮我改一下"的人类）：

**开始之前**

1. 读 `AGENTS.md`（本文）→ `docs/ARCHITECTURE.md` → 改动相关目录的代码。
   不要凭文件名猜实现。
2. 用仓库里已有的抽象（`core/*`、`ui/dom.js`、`bg/*`）。新增抽象前先说明为什么现有抽象不够。
3. 不确定 API 行为时，查代码或查 MDN；**不要编造** `chrome.*` 的参数、返回值和事件名。

**改动时**

4. 最小改动：不重排无关代码，不顺手改文案，不批量"优化"。
5. 保持既有风格：中文注释、单引号、2 空格、`RH_` 消息前缀。
6. 新增纯逻辑 → 放 `src/core/` 并补 `test/unit/`；新增站点 → 加 JSON + 语料。
7. 触及权限、版本号、许可证、品牌资源前先停下来说明理由，不要"顺手对齐"。
8. 不触碰 `work/`（本地私有资料，未入库）。

**完成之前**

9. 跑 `npm run check`，把**真实结果**贴出来；失败就修，不要用"应该没问题"结案。
10. 明确列出：改了什么、为什么、验证了什么、还有哪些不确定/未覆盖。
11. 不要声称做了没做的事；不要为了让结论好看而删测试或改断言。

**绝对禁止**

- 生成 DRM 绕过、鉴权绕过、反爬对抗的"增强"代码。
- 把逆向第三方商业软件的产物、反编译代码或笔记写进仓库。
- 引入远程脚本 / `eval` / 动态 `<script>`（MV3 会直接拒绝，也不符合本项目安全模型）。
- 未经要求重写 git 历史、强推分支、或修改 `LICENSE`。

---

## 11. 提交前检查清单

- [ ] `npm run check` 全绿（build / test / corpus / bench / diagnose）
- [ ] 新增逻辑有测试；新增站点有 fixture + case
- [ ] 没有新增权限、没有新增依赖
- [ ] 没有 `innerHTML` 拼接页面数据；没有 `eval` / 远程脚本
- [ ] 用户可见行为变化已同步 `docs/` 与 `docs/CHANGELOG.md`
- [ ] 文档里的链接可点，没有本机绝对路径
- [ ] `git status` 里没有 `out/`、`work/`、密钥或无关文件
- [ ] 提交信息符合 Conventional Commits，一个提交只做一件事

---

## 12. 常见任务配方

**新增一个站点适配器**

1. `src/sites/<id>.json`（照抄 `bilibili.json`）：`id` / `priority` / `match` + JSONPath 映射；
2. 在 `src/bg/adapters.js` 的 `ADAPTER_FILES` 注册；
3. `test/corpus/fixtures/<id>.json` + `test/corpus/cases/<id>.json`；
4. `npm run corpus` 看 KPI；
5. 细节见 `docs/SITE-ADAPTERS.md`。

**新增一个设置项**

1. `src/core/settings.js` 加默认值与校验；
2. `src/options/index.html` + `options.js` 加控件（保持"标题 + 说明"两行结构）；
3. 使用处读取设置，并处理"用户没设过"的情况；
4. `test/unit/settings.test.mjs` 补默认值/边界用例；
5. `docs/STORE.md` 若涉及新的数据读写，同步说明。

**新增一种下载模式**

1. 在 `core/` 或 `bg/` 里实现 `build*`（只产 `{ blob, filename, meta }`，不碰 `chrome.downloads`）；
2. 落盘统一走 `finalize`，保证历史留痕；
3. 接入串行队列与进度广播；
4. 补单测：成功、失败归因、预算护栏；
5. 更新 `docs/ARCHITECTURE.md` 的数据流图。

---

## 13. 相关文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 现在的代码长什么样
- [docs/ROADMAP.md](docs/ROADMAP.md) — 要往哪走、KPI 与验收
- [docs/AUDIT.md](docs/AUDIT.md) — 历史问题清单与证据
- [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) — 面向人类贡献者的流程
- [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md) — 第三方资源与许可证
