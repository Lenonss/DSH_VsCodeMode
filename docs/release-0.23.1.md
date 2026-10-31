# v0.23.1：修复 Keep All / Undo All 在待审超过一页时必定中止

作者：ddj，2026-10-31。

## 背景与根因

差异栏右下角的「Keep All / Undo All」原先复用官方审查的分页接口 `edrv.review.list`（每页 50 条）逐页取待审条目，途中把每页返回的 `pending` 当成「全量总数」做完整性校验。但 `pending` 其实是**展示用计数**：官方侧返回的是全局官方待审计数，待审投影（工作区历史改动）又把「本页未被官方行覆盖的条目数」加进去，于是它是页级量、且每页不同。结果：

- 官方待审超过一页（本仓库实测 150 条）时，页级计数恒定在 50，翻完页后 `items.length !== expected`，报「待审记录数量不完整，未执行批量操作」；
- 有历史改动投影时各页计数不同，先一步报「待审记录在分页期间变化」；
- 投影条目在每页都会重新返回，触发重复校验；
- 投影里已 settled 的条目会被映射成 `decision: 'accepted'`，直接触发「重复或版本变化」。

上述任一条都发生在任何 `decide` 之前，用户看到的现象是「批量已停止，已完成 0 项」。

## 变更

- `edrv.review.list` 新增 `all: true` 参数（`src/shared/rpc.ts`、`src/reviewRpc.ts`）：服务端一次性返回完整待审快照——循环分页取全官方 `current=1 AND decision='pending'` 行，与工作区历史改动投影（仅未 settled 条目）按路径去重后合并，返回 `nextCursor: null`、`pending` 为条目真实总数、并保留 `overview` / `gaps`。
- 快照规模上限 `BATCH_LIMIT = 2000`：超过时直接拒绝并提示「待审记录过多（N 条，上限 2000），请先分批处理后重试」，不做静默截断。
- 官方侧取全后再与 `first.pending` 对账，数量不一致仍返回「待审记录数量不完整，未执行批量操作」，保持失败即止的语义。
- 客户端 `src/client/reviewBatch.ts`：`BatchPort.list` 改为一次性 `snapshot()`；`loadPending` 只取一次快照，逐项校验「未重复 / 仍为当前版本 / 仍为待审」，再校验 `nextCursor === null` 且条目数等于 `pending`，否则整批中止。
- `src/client/ui/EditorView.ts` 的批量端口改为 `rpc('edrv.review.list', { sessionId, all: true })`。
- 差异栏的日常浏览（`reviewFeed`、`OfficialReview` 的「下一页」）继续走原分页接口，展示行为不变。

## 验证

- `npm run typecheck`：tsc 0 error。
- `npm run test`：`tests/reviewBatch.test.ts` 按快照契约重写（107 条单次快照全量决策并断言只取一次快照、Undo 能力预检、CAS 冲突部分完成、重复/半截/已 settled 快照拒绝且零决策、guard 抛错时不取快照、每次决策后复查 guard），`tests/reviewRpc.test.ts` 追加快照分支两用例（分页取全且 `pending` 与条目同源、2001 条时拒绝并含「上限 2000」）。
- 真实审查库（`<DSH_HOME>/dsh-vscode-mode/data/archive/<hash>.sqlite`，只读打开）核对：官方待审 150 行 / 54 个 distinct identity（37 个路径存在多轮行，属正常多轮），各会话快照 150~156 条均低于上限；`decideReview` 的 UPDATE 带 `id + seq + revision + current + decision` 条件，同路径多轮互不影响，逐行决策可全部成功。
- 已知缺口：**未在重启后的 GUI 上真实点按「Keep All / Undo All」**。本机 Web profile 的插件目录是指向本 checkout 的软链，客户端资源刷新即可加载新逻辑，但 host 半的 `batchSnapshot` 需要重启 DSH 才生效，因此本批次未做真机批量决策验收；用户在本批次接受该缺口。
- 未进行 Unity 全量验证（本包不涉及 Unity 工程）。

## 升级

按 README 三选一安装示例选择实际目标 profile。发布不自动部署：升级后需重启 DSH 并刷新页面，`edrv.review.list` 的 `all: true` 才生效；若只刷新页面而未重启 host，旧 host 会忽略该参数、退回分页结果，客户端据 `nextCursor !== null` 整批中止（不会误写，但也仍然做不了批量操作）。
