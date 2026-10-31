# v0.23.3：已删除文件的差异条目不再卡死；重启后不再成串报「采集不完整」

作者：ddj，2026-10-31。对应 issue [#13](https://github.com/Lenonss/DSH_VsCodeMode/issues/13)、[#12](https://github.com/Lenonss/DSH_VsCodeMode/issues/12)。

## 背景与根因

### 一、已删除文件的差异条目把人卡在「加载中」（#13）

用户把文件删掉后，差异 dock 里那条改动指向的路径在磁盘上已经不存在。打开它：

- 编辑器停在「文件加载失败：Error: Unknown named parameter 'targetKey'」，进度 0%，重试同错，Keep / Undo 都执行不了，标签页也关不掉。

链路分两段：

1. **`Unknown named parameter 'targetKey'`（v0.22.0 及更早）**：`fs.resolve()` 在官方 provider 下返回的是不透明 FsTarget 对象（`{ targetKey, displayPath, … }`），旧代码把它当路径字符串继续用，最终绑进按路径查的 SQLite 语句；`node:sqlite` 是把对象当**命名参数**绑定的，语句里没有 `targetKey` 这个键，于是抛出这条与被审查文件无关的错误。v0.22.0 起 `hasOfficial()` 已加 `typeof path !== 'string'` 守卫（`tests/officialGuard.test.ts` 覆盖），这条 SQL 报错不再出现。
2. **修掉报错后仍是一堵墙（HEAD 仍存在）**：文件缺失时客户端走 `edrv.missingReview` 申请整文件删除预览，而这个入口对「已有官方审查记录」的文件一律拒绝（官方改动只应经差异栏 Keep 结案）。拒绝是一条普通 `Error`，客户端既分不清「已删除」也拿不到稳定原因，只能落到通用加载失败分支——`loadingBody('文件加载失败：' + loadError, 0, 重试)`，进度条钉在 0%。同时 `edrv.review.detail` 对这条记录给出的 Undo 原因是「缺少可验证的原始字节」，而真实原因是「文件已经不在了」，误导排查方向。

因此 v0.23.3 修的是**语义与出口**，不是 SQL 绑定：把「文件已在磁盘删除」变成一种有名字的终态。

### 二、重启后成串「轮次 N 采集不完整」（#12）

官方 `workspace/changes` 的 summary 由 `@deepseek-ai/dsh-workspace-changes` 放在宿主**内存 Map** 里。插件启动时 `backfill()` 会把该会话所有历史 `workspace/changes` 事件**无条件**入队，`collect()` 找不到 summary 就抛「官方事件已公告，但 summary 已失效或尚不可用」，`drain()` 的 catch 把每一轮都写进持久化的 `gap` 状态——面板于是出现成串「轮次 352/354/356 采集不完整」，且这些缺口永远补不上（summary 本身已随重启消失）。同批更晚的 358/362 反而 accepted，是因为它们落在重启后新产生的会话里、summary 还在内存中。

v0.23.3 让补采先探后入队：summary 已经不在内存里的历史事件直接跳过，只留一条汇总日志，不再制造不可修复的假缺口。

## 变更

- `src/officialCapture.ts`：`installCapture()` 的补采（backfill）先取 `workspaceChanges`，缺失时 `log.warn` 后放弃补采（实时事件照常采集）；每个历史事件入队前先 `source.summary(session.id, event.seq)` 探测，取不到就计数跳过，循环结束打一条 `官方历史补采跳过 N 轮已失效事件：官方 summary 不跨宿主重启保留，实时事件照常采集`。绝不为失效事件写 `gap`。
- `src/shared/rpc.ts`：新增 `MissingRefusal = 'official-covered' | 'official-decided' | 'no-records' | 'no-evidence' | 'too-large'`，`RpcResult` 的失败 `code` 联合并入。
- `src/missingReview.ts`：新增 `refusal(code, message)` 与 `refusalCodeOf(error)`；`missingReview()` 的可预期拒绝全部带上稳定码——官方记录仍有待审 → `official-covered`，官方记录都已处理 → `official-decided`，无待审历史 → `no-records`，缺完整快照 → `no-evidence`，快照过大 → `too-large`。文案从「请使用官方审查入口」改成可执行的下一步。
- `src/reviewDb.ts`：新增 `officialPending(cwd, path)`，只查 `current=1 AND decision='pending'`，用于区分「还要去差异栏 Keep 结案」与「记录都已处理、可以直接关标签页」；沿用 `hasOfficial()` 的 `typeof path !== 'string'` 守卫与 Windows 盘符路径折叠。
- `src/rpc.ts`：`edrv.missingReview` 的 catch 把 `refusalCodeOf(error)` 作为 `code` 回传，错误原文仍保留在 `error`。
- `src/reviewRpc.ts`：新增 `absenceCapability()`，`edrv.review.detail` 在有 Keep 能力时进一步核对——记录本身就是删除（`diff.kind === 'text' && !diff.after`）说明 Undo 缺少整文件内容；磁盘上已无该文件时把 `undo` 置 `false` 并换成「文件已在磁盘删除：Keep 按删除结案；Undo 需要读写该文件，当前不可用。」。只改文案与 `undo` 位，不参与判定写入；Keep 行为不变。
- `src/client/missingReview.ts`：新增 `GoneState` 与 `goneStateOf(failure)`，把上述拒绝码归并成「文件已在磁盘删除（· 有官方待审改动）」终态；非白名单错误返回 `null`，会话缺失/权限类仍走原失败路径（保留跨端提示）。
- `src/client/ui/EditorView.ts`：新增 `goneFile` 状态与 `goneNow` 派生、`settleGone()`、`goneBody()` 与终态渲染分支——标题 + 原因 + 「重试」「关闭标签页」两个按钮，不再画 0% 进度条；`loadMissing()` 的 `!ok` 走 `settleGone()`，`!review`（磁盘状态抖动）最多重读 2 次后给终态，消除「缺失 ↔ 重现」的无限递归；`loadContent()` 重新载入时清空终态。

## 行为对照（文件在磁盘上已删除）

| 场景 | v0.23.2 | v0.23.3 |
| --- | --- | --- |
| 有官方待审记录 | 「文件加载失败：Error: 该文件已有官方审查记录…」，0% 进度，不可关 | 终态「文件已在磁盘删除 · 有官方待审改动」+ 原因 + 重试 / 关闭标签页 |
| 官方记录都已 Keep | 同上（提示语仍说「已有官方审查记录」） | 终态「文件已在磁盘删除」+「官方审查记录均已处理：可直接关闭该标签页」 |
| 无任何待审历史 | 「文件加载失败：没有待审历史记录」 | 终态「文件已在磁盘删除」+ 可直接关闭 |
| Undo 原因 | 「缺少可验证的原始字节或受控写回能力」 | 「文件已在磁盘删除：Keep 按删除结案；Undo 需要读写该文件，当前不可用。」 |
| Keep | 可用（只看审查库） | 可用，语义不变 |

## 验证

- `npm run typecheck`：改动前后同为 37 个既有错误（全部是 `src/client/excel/codec.ts`、`src/client/excel/xmlGate.ts` 的 `Cannot find module 'fflate/browser'` 依赖缺失，属工作副本既有环境问题），`diff` 为空 → 零新增类型错误。
- 定向单测 111/111 通过（16 个文件），含新增 `tests/deletedFileReview.test.ts`（5 例：opaque FsTarget 下 `edrv.missingReview` 回 `code:'official-covered'` 且不含 `Unknown named parameter`、`edrv.review.detail` 的 `keep=true / undo=false` 与删除原因、Keep 之后转 `code:'official-decided'`、`goneStateOf` 白名单归并）与 `tests/officialBackfill.test.ts`（2 例：失效 summary 的历史事件不记 gap、只有可读事件被采集；缺 `workspaceChanges` 时既不采集也不记 gap）。
- EditorView 相关 5 个测试文件 82/82 通过；`npm run build` 四个 bundle 均 Build complete。

## 已知缺口与不打算做的事

- 待审记录「每轮一条」是既有语义：官方记录按 `(id, seq)` 逐轮落库，不合并成一条。需要成批清理时用差异栏的 Keep All / Undo All（`edrv.review.list` 的 `all:true` 完整快照通道）或差异总览批量处理；本次不改变记录粒度。
- 侧边栏 MCP 行的 ⚠️ 误报已在 v0.20.2 修掉（`mcpRowLabel()` 对 `stale` 直接不返回标签，悬停文案改为「状态查询暂不可用，不代表 MCP 初始化失败」）；#12 里看到的是 v0.20.0 的行为，升级即消失。
- `officialPending()` 的 Windows 盘符分支没有单测——与 `hasOfficial()` 现状一致，避免在 ubuntu CI 上写死盘符断言。
