# 第三方资源与许可证

本项目的**运行时与构建代码**全部为独立实现，采用 [Apache-2.0](../LICENSE)，不包含任何第三方专有代码。
下面列出仓库内**第三方资源**（数据、字体派生、测试样本）的来源与许可证——它们与代码许可证分开说明。

## 1. 字体字形指纹表 `src/data/glyph-table.bin`

| 项 | 内容 |
| --- | --- |
| 用途 | "字体反爬"还原：把私用区码位（U+E000–U+F8FF）的字形轮廓指纹反查成真字 |
| 来源字体 | Source Han Sans SC Normal（思源黑体），版本 **2.002R** |
| 来源地址 | <https://github.com/adobe-fonts/source-han-sans>（`2.002R` 标签，`OTF/SimplifiedChinese/SourceHanSansSC-Normal.otf`） |
| 生成方式 | `tools/build-glyph-table.mjs`：解析字体 CFF 轮廓 → 64 位 FNV-1a 指纹 → 取高 48 位 + UTF-16BE 码位，写入二进制表 |
| 本仓库中的形态 | **派生数据**（指纹与码位），不含字体文件，也不含可直接还原的字形轮廓 |
| 许可证 | SIL Open Font License 1.1，全文见 [`licenses/OFL-1.1.txt`](licenses/OFL-1.1.txt) |
| 版权声明 | Copyright 2014-2025 Adobe (<http://www.adobe.com/>), with Reserved Font Name 'Source'. |
| 修改说明 | 由原字体派生；派生数据同样以 OFL 1.1 提供；本项目不使用保留字体名 "Source" 作为名称或商标 |

> OFL 1.1 要求派生作品继续以 OFL 分发并保留版权与许可声明。这一条**只覆盖该数据文件**，
> 不改变项目其余代码的 Apache-2.0 授权。

## 2. 测试用字体样本 `test/fixtures/fonts/private-use-subset.otf`

- 来源：同一份思源黑体 2.002R，用 fontTools 裁出「雨夜雷声风灯影火」8 个字，
  去掉 hinting 与子程序，并把码位改到私用区 U+E000–U+E007；
- 用途：验证「字形轮廓 → 指纹 → 真字」链路，**仅用于测试**，不随扩展分发；
- 许可证：SIL OFL 1.1（同上）；
- 重新生成的方法见同目录 [`README.md`](../test/fixtures/fonts/README.md)。

## 3. 真实流清单 `test/fixtures/real/`

| 文件 | 来源 | 用途 |
| --- | --- | --- |
| `apple-master.m3u8`、`apple-media.m3u8` | Apple 公开发布的 HLS 示例流清单 | 验证 HLS 解析器吃真实清单 |
| `akamai-bbb.mpd` | Akamai 公开发布的 DASH 示例（Big Buck Bunny） | 验证 DASH 解析器吃真实清单 |

这些清单只作为**测试输入**保存在仓库里，不随扩展分发；其中的 URL 指向各自运营方的服务器。

## 4. 图标与品牌资源

`src/bitmaps/*.png`（应用图标与占位图）为本项目自绘，随项目以 Apache-2.0 授权。

## 5. 代码依赖

**无。** `package.json` 的 `dependencies` 与 `devDependencies` 均为空，
构建与测试只使用 Node.js 内置模块。

## 6. 许可证边界（与功能相近的项目）

本项目的"整页快照"在功能上与 [SingleFile](https://github.com/gildas-lormeau/SingleFile) 重叠，
但 SingleFile 采用 **AGPL-3.0**。本项目**未复制其任何源码**，占位符协议、CSS 闭包、
帧树装配与预算模型均为在本项目架构下的独立实现。详见 [ARCHIVE.md](ARCHIVE.md) §6。

如果你要为本项目引入第三方代码或资源，请先读 [AGENTS.md](../AGENTS.md) §8 的许可证政策。
