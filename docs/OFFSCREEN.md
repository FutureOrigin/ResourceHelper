# 把下载引擎搬到 offscreen：设计与验证计划

> 状态：**已实现**（构建搬到 offscreen，落盘留在后台；不支持时自动回退侧边栏）。
> 本文记录已确认的事实、选型理由、协议，以及真实环境里仍需确认的点。
> 对应架构债：ARCHITECTURE.md「下载引擎活在侧边栏文档 → 关面板 = 任务死亡」——已解决。

## 问题

引擎类下载（HLS / DASH / 合流 / 直播录制）目前跑在**侧边栏文档**里。
侧边栏是普通扩展页面，关闭面板 = 销毁上下文 = 中止任务。
直链下载不受影响（`chrome.downloads` 一旦由浏览器接管就不依赖我们的进程）。

## 已确认的事实

| 事实 | 依据 |
| --- | --- |
| Service Worker **没有** `URL.createObjectURL` | MV3 SW 无 DOM 绑定；社区实践明确提到该限制 |
| Offscreen 文档**有** DOM，可以 `URL.createObjectURL` | offscreen 存在的目的就是给 SW 补 DOM 能力 |
| Offscreen 文档**不能**调用绝大多数扩展 API（含 `chrome.downloads`） | 官方文档：offscreen 文档只保留 `chrome.runtime` 等少数 API |
| 社区通行做法：offscreen 建 blob URL → 交给 SW → SW 调 `downloads.download` | 多个独立来源描述同一模式（大 Blob 下载的 MV3 变通） |

结论：**"取数 + 组装"可以离开侧边栏，"落盘"必须留在 SW。**
这两件事恰好对应一次清晰的重构。

## 需要的重构：把"构建"与"提交下载"分开

现在三个下载器都是"一边拉一边直接 `chrome.downloads.download`"。
改成两段式：

~~~
build*()   ->  { blob, filename, meta }      // 纯构建，不碰 chrome.downloads
finalize() ->  chrome.downloads.download(...) // 只有这里调用下载 API
~~~

- `build*` 可以在 offscreen / 侧边栏 / 未来任何 DOM 上下文运行；
- `finalize` 由 SW（或侧边栏）执行。

顺带解决另一个问题：这段重构让"下载"变成可替换的末端，未来接 File System Access
或"直接写盘"都不必再动引擎。

## 消息协议草案

~~~
侧边栏/SW  -> offscreen:  { type:'RH_BUILD', jobId, kind:'hls'|'dash'|'mux'|'live', payload }
offscreen  -> 旁观者:      { type:'RH_BUILD_PROGRESS', jobId, percent, text }
offscreen  -> SW:          { type:'RH_BUILD_DONE', jobId, blobUrl, filename, meta }
SW         -> offscreen:   { type:'RH_BUILD_ACK', jobId }        // 下载已接管
SW         -> downloads:   chrome.downloads.download({ url: blobUrl, filename })
SW         -> offscreen:   { type:'RH_RELEASE', jobId }          // 下载完成后 revoke
~~~

生命周期要点：

1. offscreen 文档由 SW 用 `chrome.offscreen.createDocument` 创建，**任务期间保持存活**；
2. blob URL 在下载完成（`downloads.onChanged` 的 `complete`/`interrupted`）之后再 revoke，
   否则浏览器可能拿不到数据；
3. 全部任务结束后再 `closeDocument`，不要每个任务开关一次。

## 实现状态

已按本文件实现：

- `src/offscreen/offscreen.js` 只做构建，产出 blob（或整文件直链）交回后台；
- `src/bg/offscreen.js` 管文档生命周期（单例、任务期间保活、空闲才关闭）；
- `src/core/offscreen-protocol.js` 定义消息契约并校验输入（有单测）；
- 后台在下发下载后登记 blob URL，等 `downloads.onChanged` 结束再释放并关文档；
- 侧边栏先尝试委托，失败立刻回退到本地构建，并提示原因。

## 真实环境仍需确认的三件事

在真实 Chrome 里最小化验证（每步只需十几行代码）：

1. **offscreen 里创建 blob URL → SW 调用 downloads 是否真的能下下来？**
   若不行：改为 offscreen 写入 OPFS，再由有 DOM 的上下文读回并下载（网络部分仍能扛住关面板）。
2. **offscreen 关闭后 blob URL 是否立即失效？**
   决定"下载完成再关"还是"可以提前关"。
3. **`chrome.offscreen.createDocument` 的 justification 是否被接受？**
   需要写成用户能看懂的理由（例如"在后台完成用户已开始的大文件下载"）。

## 兜底策略

任何一步验证失败都**不影响现有功能**：

- 侧边栏路径继续保留，作为默认实现；
- offscreen 作为"增强路径"：只有在探测通过（自检消息往返成功）时才启用；
- 启用后若某个任务在 offscreen 侧失败，回退到侧边栏执行，并把失败原因写进历史记录。

这样即使 offscreen 方案在某个 Chrome 版本上有差异，用户也只是"回到现在的行为"，
而不是"下载坏了"。
