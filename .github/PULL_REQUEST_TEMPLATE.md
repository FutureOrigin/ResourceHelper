## 这个 PR 做了什么

<!-- 一句话说清；关联的 issue 用 "Closes #123" -->

## 为什么

<!-- 解决什么问题？为什么现在做？有取舍就写出来 -->

## 怎么验证的

<!-- 跑了哪些命令、手工点了哪些路径、附截图/日志更好 -->

```
npm run check
```

## 类型

- [ ] feat（新能力）
- [ ] fix（修缺陷）
- [ ] docs（文档）
- [ ] test（测试/守卫）
- [ ] refactor / perf（不改变外部行为）
- [ ] build / chore（构建、脚本）

## 自查清单

- [ ] 读了 [AGENTS.md](../AGENTS.md)，改动符合其中的红线与规范
- [ ] `npm run check` 全绿（build / test / corpus / bench / diagnose）
- [ ] 新增逻辑有测试；新增站点有 fixture + case 与脱敏
- [ ] 没有新增依赖、没有新增 manifest 权限
- [ ] 没有 `innerHTML` 拼接页面数据、没有 `eval` / 远程脚本
- [ ] 用户可见的行为变化已同步 `docs/` 与 `docs/CHANGELOG.md`
- [ ] `git status` 里没有 `out/`、`work/`、密钥或个人路径
- [ ] 提交信息符合 Conventional Commits

## 备注 / 不确定的地方

<!-- 有风险、有未覆盖场景，写在这里比藏起来好 -->
