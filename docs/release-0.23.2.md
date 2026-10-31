# v0.23.2：修复 Keep 在非活跃端（桌面端）点了没反应

作者：ddj，2026-10-31。

## 背景与根因

桌面端与 Web 端各自运行一套 DSH 宿主，同一会话只在其创建端处于活跃（live）状态。v0.20.5 起读类接口按持久化会话头的 cwd 冷读互通，写类接口仍要求本端活跃会话——于是「在 Web 端创建的会话，另一个端打开后差异栏能看、Keep 却按不动」：

- `edrv.review.decide` 第一行调用 `liveWorkspace()`，冷读作用域一进来就抛 `会话不存在或没有工作区`；
- 但 `edrv.review.detail` 的能力位完全由审查库推导（`capability.keep = 记录仍是 current 的待审行`），与 live 无关，所以冷端的 Keep 按钮照常亮着；
- 抛错经 `mountRoute` 的兜底变成 HTTP 500 `Plugin request failed`，客户端再映射成「DSH 请求失败（HTTP 500）」——用户看到的就是按钮可点、点了没有可读反馈。

实际约束并不对称：

| 操作 | 是否需要会话内容 | 结论 |
| --- | --- | --- |
| 官方记录 Keep | 否，只写共享审查库（`BEGIN IMMEDIATE` + operationId 幂等 + `id/seq/revision/current/decision` CAS） | 冷端可放开 |
| 官方记录 Undo | 需要会话证据并写回源文件 | 仍需本端活跃会话 |
| 待审投影条目 Keep / Revert | 写本机待审 JSON（无跨进程锁），与另一端 agent 编辑会互相覆盖 | 仍限本端活跃会话 |

### 第二处根因：已结算的待审投影顶掉了官方记录

放开冷端写权限后真机仍然「点不动」，日志与等宽探针显示差异栏根本没在审官方记录：

- `capabilityOf()` 对已结算（`oldText === newText`，即累计净变化为零）的待审条目返回 `{ keep: false, revert: false, reason: 'settled' }`；
- 但 `edrv.review.list` 的单文件通道把该路径的待审条目排在官方记录之前（`items = [...own, ...history]`），客户端取 `items[0]`，于是选中的是一条 Keep 恒不可用的已结算条目；
- 同时 `history` 又把同路径的官方行整体滤掉，差异栏里「待审 0」、Keep 禁用、点击无任何反馈——与用户看到的完全一致。

修复：`pendingPageOf()` 在交给官方审查通道前剔除 `settled === true` 的投影（它们的 `pending` 计数本来就不含自己，列表与计数就此自洽）。官方待审记录不再被已结算投影遮蔽，差异栏重新选中 `capability.keep === true` 的官方行。

## 变更

- `src/reviewRpc.ts`：删除 `workspace()` / `liveWorkspace()`，改为 `scopeOf()` 同时返回 `{ cwd, live }`（`live = !!scope.session`）；`edrv.review.list` / `edrv.review.detail` / `edrv.review.decide` 统一走它。
- `edrv.review.decide` 冷端语义收敛：官方 Keep 放行并写共享库（`log.info` 留一条 `[review] 冷端 Keep 官方记录 <id>`），官方 Undo 返回「Undo 需要在本端活跃的会话上执行……Keep 不受影响，可在任一端执行」，`pending:` 条目一律返回「待审条目的判定需要在本端活跃的会话上执行……」；整个处理器包 `try/catch`，判定失败一律 `{ ok: false, error }`，不再升级成 HTTP 500。
- `edrv.review.detail` 增加 `capability.live`：活跃端保持审查库结论，冷端关闭 `undo`（给出跨端原因）、`pending:` 条目 `keep`/`undo` 一起关闭，Keep 仍按审查库结论放行。
- `src/shared/review.ts`：`ReviewDetail.capability` 增加可选 `live`（缺省视为未知，只有 host 明确给 `false` 才代表会话不在本端活跃）。
- `src/client/reviewBatch.ts`：批量预检遇到冷端 `pending:` 条目时先给出「待审条目需要在会话活跃的一端判定」，不再笼统报「审查版本变化」。
- `src/client/ui/OfficialDiffBar.tsx`：冷端 Keep 的 title 追加「（会话在另一端激活：Keep 写入共享审查库，仍可执行）」。
- `src/reviewRpc.ts`：`pendingPageOf()` 剔除已结算（`settled`）的待审投影，避免它们顶掉同路径的官方待审记录；列表、详情、批量快照三个入口共享这一口径。
- `src/client/ui/EditorView.ts`：详情未加载时点 Keep 不再静默返回，改为给出可读提示；同时补 `[DEBUG reviewPath]` / `[DEBUG reviewList]` / `[DEBUG reviewDetail]` / `[DEBUG decideOfficial]` 诊断日志（仍受调试开关约束）。
- `src/client/ui/EditorView.ts`：切换会话后官方待审列表仍在载入时点批量按钮，不再直接报红「官方待审列表尚未就绪，未执行批量操作」，改为触发一次刷新并提示「正在载入，载入完成后请再次点击」。
- `src/client/ui/EditorView.ts`：打开文件时，若某条官方记录的改动已全部不在当前文件中（无可定位差异、缓冲区干净），自动按 Keep 结案（只标记已采纳，不改写磁盘），差异栏不再显示「本记录 N 处改动均已不在当前文件中」这类需要用户判断的失效叙事；结案失败只记诊断日志，记录留在待审列表下次再试。判定请求抽成 `submitOfficialDecision()`，与手动 Keep/Undo 共用同一幂等 operationId。
- `src/client/ui/reviewAllRow.tsx` / `OfficialDiffBar.tsx` / `SidecarDiffBar.tsx` / `EditorView.ts`：官方元数据首次载入期间（`review.page === null` 且无错误）不再按历史记录报「差异文件 x / y」，改为显示 `—` 并暂时禁用 Keep All / Undo All。此前每次重启会先闪出「40 多条待处理差异文件」（该工作区 199 条未归档历史记录里 41 个文件带未处理 hunk，而这些路径 100% 都在官方 `coveredPaths` 里，元数据一到就被接管），随后又掉回真实条数，属于显示时序错误而非数据错误。

## 验证

- `npx tsc -p tsconfig.json --noEmit`：0 error。
- `npx vitest run tests/reviewRpc.test.ts tests/reviewBatch.test.ts tests/reviewBar.test.ts tests/decideBatch.test.ts`：57/57 通过，2.5s。其中 `tests/reviewRpc.test.ts` 第三条用例改写为「冷端可 Keep、不可 Undo、不可判定待审条目」，新增冷/活跃端能力位对照用例与「已结算投影不得遮蔽官方记录」用例；`tests/reviewBatch.test.ts` 新增「冷端官方批次照常完成」「冷端快照含待审条目时整批中止且零决策」两例。
- 跨进程写安全由既有基座承担：审查库为每工作区 SQLite（`<DSH_HOME>/dsh-vscode-mode/data/archive/<hash>.sqlite`），`PRAGMA journal_mode=WAL; synchronous=FULL; busy_timeout=2000`，`decideReview` 用 `BEGIN IMMEDIATE` 串行化，CAS 未命中报「审查版本冲突，请刷新后重试」，不静默覆盖。
- 真机取证（`IslandSplash_BugFix2` 工作区、`session-9fdf1cd0…`）：修复前该文件差异栏选中 `pending:<记录>`、`capability.keep=false`；修复后同一请求返回的首条官方记录 `capability={ keep: true, undo: true, live: true }`。
- 已知缺口：桌面端 profile 需换包并重启 App 才会加载本版本；重启后若恢复的是另一个会话，需手动切回原会话再看差异栏。

## 升级

- 发布不自动部署；升级后重启 DSH 宿主并刷新页面。桌面端 profile 的插件目录是实体副本（Web profile 为指向本 checkout 的 junction），需要重新安装/换包才会拿到本版本。
