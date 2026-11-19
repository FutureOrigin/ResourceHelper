# 贡献指南

感谢你愿意花时间。这个项目对贡献的要求不多，但有几条是硬的——它们决定了别人能不能信任这个扩展。

> 动手之前请先读 [AGENTS.md](../AGENTS.md)（工程契约与红线）与 [ARCHITECTURE.md](ARCHITECTURE.md)（现在的代码长什么样）。
> 行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 1. 环境

- Node.js **22+**（仅构建与测试需要）
- Chrome / Edge **114+**（手工验证扩展行为时）
- 不需要任何全局依赖：`npm install` 都不必跑（零依赖，`package.json` 里没有依赖）

```bash
git clone https://github.com/FutureOrigin/ResourceHelper.git
cd ResourceHelper
npm run check      # 构建 + 单测 + 语料 + 效率 + 探针，全绿再动手
```

## 2. 仓库结构（速查）

| 路径 | 你能在这里改什么 |
| --- | --- |
| `src/core/` | 纯逻辑（决策 / 图 / 解析 / 合流 / 队列 / 字体）。**必须可单测** |
| `src/service/` `src/bg/` | 后台与需要 `chrome.*` 的模块 |
| `src/content/` | 页面侧采集脚本（只采集，不判定） |
| `src/sidepanel/` `src/options/` | UI |
| `src/sites/*.json` | 站点适配器（**加站点优先加 JSON**） |
| `test/` | 单测 / 语料 / 基准 / 探针 |
| `tools/` | 构建与建表脚本（零依赖、跨平台） |
| `docs/` | 文档 |

## 3. 提交流程

1. **先开 issue**（bug 或 feature），说明现象/动机与期望行为；小改动可以直接提 PR。
2. 从 `main` 切分支：`feat/<简述>`、`fix/<简述>`、`docs/<简述>`、`test/<简述>`。
3. 一个提交只做一件事；重构与行为变更分开。
4. 提交信息用 [Conventional Commits](https://www.conventionalcommits.org/)，允许中文描述：
   ```
   fix(mux): 重写 stco 偏移，双轨合流不再错位
   feat(sites): 新增某某站点适配器与语料
   docs(snapshot): 补充 iframe 跨域降级说明
   ```
5. PR 里写清楚：**改了什么、为什么、怎么验证的、还有什么不确定**。
6. 提交前跑 `npm run check`，把真实结果贴进 PR。

## 4. 什么改动最容易合入

- 新的**站点适配器 + 脱敏语料**（见 [SITE-ADAPTERS.md](SITE-ADAPTERS.md)）；
- 真实站点的问题复现：页面地址、现象、期望行为、必要时附侧边栏截图；
- HLS / DASH / 直播录制 / remux 的边角情况；
- 文档与代码不一致的修正（以代码为准）；
- 测试与守卫的补强。

## 5. 不会被合入的改动

- 任何 DRM 绕过、鉴权绕过、反爬对抗、付费墙绕过；
- 从第三方商业软件复制/反编译得到的代码、常量表、站点脚本；
- 新增运行时依赖、新增权限（没有充分理由与文档同步）；
- 用 `innerHTML` 拼接页面数据、`eval`、远程脚本；
- 为了"让 CI 变绿"而删除或弱化测试；
- 与功能无关的大规模重排/改名/格式化。

## 6. 测试与门禁

```bash
npm test           # 424 个单元测试
npm run corpus     # 站点语料 + KPI 门禁
npm run bench      # 效率基准（分类 / 扫描 / 内存）
npm run diagnose   # 缺陷探针
npm run check      # 全部
```

- 新增纯逻辑必须配 `test/unit/*.test.mjs`；
- 修复缺陷请先让探针或测试复现（红），再修（绿）；
- 语料 KPI 阈值不接受"调低一点"。

## 7. 文档

- 文档在 `docs/`，用中文写；面向国际读者的摘要放在 README 的 English 段。
- **行为变了就改文档**，并在 [CHANGELOG.md](CHANGELOG.md) 记一条。
- 新增文档后，在 README 的「文档」表里加一行。

## 8. 报告问题

- **功能异常 / 兼容性问题**：开 issue，使用 bug 模板，附：浏览器版本、页面地址（可脱敏）、
  侧边栏显示什么、期望什么、控制台是否有报错。
- **安全问题**：不要开公开 issue，见 [SECURITY.md](SECURITY.md)。
- **许可证 / 归属问题**：直接联系维护者，我们会优先处理。

## 9. 许可证

本项目使用 [Apache-2.0](../LICENSE)。提交 PR 即表示你同意以同一许可证发布你的贡献
（inbound = outbound），并确认你有权提交这些代码。
