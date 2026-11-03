# v0.26.0：Keep All 改为单次批量；差异审查旧通道遗留清理

作者：ddj，2026-11-03。

## 背景

Keep All 慢、而且脆。慢在两个层面：

- **RPC 次数与数据量**：客户端先取一次完整快照，再对**每一条**待审记录调一次
  `edrv.review.detail`（每条都带着完整 diff 序列化过桥），然后逐条调 `edrv.review.decide`。
  一次 Keep All 等于 `2N + 1` 次往返。
- **数据层复杂度**：待审投影侧，每一条 detail / decide 内部都先 `loadEntries(cwd)`
  把**整张表的 old_text / new_text 全文**读进内存再线性查找，于是 N 条就是 O(N²) 次全文读；
  官方侧每页 5 条聚合查询、每 50 条翻一页。

脆在「一票否决」：预检阶段只要有一条出现下列任一情况，整批直接中止、0 项写入；
执行阶段只要某一条 decide 返回失败，也会立刻停掉其余全部。

- 会话在另一端活跃（冷端）的待审条目；
- 快照之后 revision / seq 漂移（用户又改了一下文件、或另一条路径先结案）；
- `settled`（基线已追平内容，本就没得保留）、`oversized`（文本超上限）；
- 该文件有尚待核对的 Undo（`state='prepared'`）；
- 待审记录数在分页期间变化。

用户看到的往往是「点了 Keep All 什么也没发生，只剩一句红的『批量已停止』」——
只要 200 条里有一条过期，其余 199 条也留着不动。

## 实现方式

### 1. 新增宿主批量 RPC `edrv.review.keepAll`（只做 Keep）

一次往返完成整批保留，请求 `{ sessionId, batchId, items: [{ id, display, seq, revision }] }`，
响应 `{ ok: true, result: { completed, total, paths, skipped, error } }`。

- **宽容保留**：逐条判定，能保留就保留，不能就写进 `skipped`（带 display 与原因），
  不再让任何一条取消整批。段级异常（如官方库打不开）只写进 `result.error`，
  另一段照常执行。
- **以库内状态为准**：官方段先 `SELECT id, seq, revision FROM review_files
  WHERE current=1 AND decision='pending'` 取当前真相，CAS 时用**库内** revision 与 seq。
  客户端快照里的 revision 只用来标身份，过期不再等于失败——这正是「漂移即阻断」的根因。
- **单事务**：`BEGIN IMMEDIATE` 一次，逐条 `UPDATE ... WHERE id=? AND seq=? AND revision=?
  AND current=1 AND decision='pending'`，命中后把该文件的块一次性置 `accepted` 并按
  `pending > mixed > 单值` 聚合回写，再写一条 `review_ops` 审计行。
- **幂等**：`operationId = sha256(batchId | id | seq)`。同一批次重放命中 `review_ops`
  直接返回上次结果，不会把 revision 再推进一次。
- 仍然只跳过自己：`prepared` Undo 只挡它那一个文件；已结案 / 不再是待审的 id
  记为「已结案或不再是待审记录」。
- 超过 2000 条与原分页上限一致地拒绝，空列表直接 `{ ok: false }`。

### 2. 待审投影侧批量保留

新 `store.keepAll(cwd, items)`：一次 `loadEntries(cwd)` 建索引，逐条走既有 `decide`
（`keep` 全程不触磁盘：只把基线推进到最新内容、revision+1、块置 accepted），
收集后由新的 `persist.saveDecisions()` 在**一个事务**里带 `WHERE id=? AND revision=?`
CAS 落库，并写撤销快照。落库冲突（`changes !== 1`）只把该条从 kept 移到 skipped
（「待审条目已变化，请重试」），不影响其余。

冷端不再整批拒绝：官方记录照常保留，只有待审投影条目逐条 skip
（原因仍是既有的跨端说明），因为这些条目没有跨进程锁。

`saveEntry` / `saveBlocks` / `pushHistory` 内部抽出了 `upsertEntry` / `writeBlocks` /
`insertHistory`，单条路径与批量路径共用同一套 SQL，行为不变。

### 3. 客户端：正常两次 RPC

新增 `src/client/reviewKeepAll.ts` 的 `runKeepAll(port)`：

1. `guard()` —— 会话/编辑器已切换就直接返回，不取快照；
2. `loadPending()` 取一次完整快照（沿用原有的完整性校验）；
   校验失败（分页漂移/数量不完整）时**自动重试一次**快照，自愈掉这类瞬时竞争；
3. `port.keepAll(items, batchId)` —— 一次批量；
4. 再 `guard()` 一次，防止跨会话写入。

即：从 `2N + 1` 次往返降到 **2 次**，且只剩一条 SQL 事务。

### 4. 界面

`actReviewAll` 拆成 `batchSnapshot` / `undoAllBatch` / `keepAllBatch` /
`finishReviewAll` 四个职责段：

- Keep：状态栏「Keep All：已保留 X / Y，跳过 Z 条」；跳过明细用轻提示列前 3 条
  （`display：原因`），其余汇总成「等 N 条」。**跳过不是错误**，不再刷红色告警——
  它们仍在列表里，可逐个处理。
- Undo：**完全不动**。仍然逐条预检能力、遇冲突立即停止、精确报告已完成项。
  Undo 会改写磁盘，宁可停也不冒险。
- 确认弹窗补一句「个别条目若已变化或需在活跃端判定会被跳过并留在列表里，可逐个处理」，
  保留「不改写文件」的既有语义。

## 另一组修复：差异审查旧通道遗留

用户实报两个症状：点 Keep 被红字拦住（「该文件已由待审累计基线接管，请使用面板
Keep/Revert」），以及「1 处差异处理失败（可能已被后续修改影响），可刷新后重试」。
根因是三处口径不一致：

- **可见性**：`EditorView.currentRecords` 只按官方覆盖过滤，被待审接管的路径仍渲染
  旧 sidecar hunk 的 Keep / Undo 药丸，点下去走的却是旧写入口，于是必然被守卫拒绝
  ——「看得见、点不动」。
- **作用域**：守卫 `legacyBlocked` 按「工作区 + 路径」判，而待审列表 `loadPage` 按
  会话过滤；别的会话持有接管时，本会话既看不到该条目、又不许用旧通道处理，形成死锁。
- **错误透传**：`actMany` 拿到宿主 `{ ok: false, error }` 后只返回 `{ fail: N }`，
  `acceptFile` 再用固定文案覆盖 —— 真实原因（典型是 `会话不存在`，即该会话不在当前
  宿主端 live）永远看不到。

修复分五处：

1. **覆盖登记按会话**（`src/pendingCompat.ts`）：`coveredBySession: Map<session, Set<key>>`
   加一个工作区级集合；`trackPendingCover(cwd, path, covered, sessionId?)`（旧 2 参调用
   即工作区集合，向后兼容）、`setPendingCovers(cwd, sessionId, paths)` 整集重建（顺带
   清掉已不存在的接管，避免永久残留）、`pendingCovers(cwd, path, sessionId?)`、
   `pendingCoverOwner(cwd, path)`。`src/index.ts` 写入钩子带上 `write.sessionId`，
   `pending.list` / `pending.import` / `pending.remove` 全部按会话登记。
2. **旧记录自动结案**（`src/store.ts` 新增 `retireCovered`）：按 `loadEntries(cwd)`
   取全工作区待审条目（用 `pendingSamePath` 兼容相对/绝对写法），把已被接管的旧记录
   批量置 `superseded` 并归档，原因写
   「已由待审累计基线接管，旧工具记录不再单独决策」；挂在 `edrv.list` 既有的 10s
   节流块里，与 `autoArchiveStale` 同一处，异常按原标记回滚。
3. **守卫按会话判**（`src/rpc.ts:legacyBlocked`）：只有「本会话可见的接管」才拦旧写入口，
   `edrv.accept` / `edrv.reject` / `missingReview` / `missingDecide` / `decideBatch` 五处同步。
4. **客户端不再渲染旧 hunk**（`src/client/state/diffSummary.ts` 新增 `coveredPathKeys`）：
   官方覆盖集 ∪ 待审覆盖集，`EditorView.currentRecords` 与 `allPending` 都用它过滤，
   待审接管的路径不再出现在编辑器与 Keep All 批量里。
5. **错误不再被覆盖**：`actMany` 返回 `error`，`batchError` / `batchFailText` 优先展示
   宿主真实原因；`会话不存在` 映射成「这个会话没在当前端激活，Keep/Undo 没有执行
   （记录未改动）；在会话里发一条消息激活后重试」；「历史改动」通道 Keep 成功后的状态
   文案改为「已标记为看过（未改动文件）」（`SIDECAR_KEEP_DONE`）。

## 验证

- `npx tsc -p tsconfig.json --noEmit` → 0 error。
- 定向单测 8 文件 67 例全过：`reviewKeepAll`（新增 7）、`reviewDb`（12）、
  `pendingStore`（20）、`reviewRpc`（10）、`reviewBatch`、`reviewAllConfirm`、
  `reviewFeed`、`reviewFlow`。
- 新增用例覆盖：一次快照 + 一次批量、漂移重试一次、guard 先于快照、
  过期 revision 仍被接受、同批重放幂等、`prepared` Undo 只挡自己、
  冷端官方照常完成而待审只 skip、空列表与超 2000 条拒绝。

- 旧通道清理侧定向单测：`pendingCoverGuard`（3）、`supersedePending`（4）、
  `pendingStore`（+2）、`diffSummary`（+1）共 32/32 通过；相邻回归 71/71、
  客户端回归 60/60 通过。
- 现场验收（重启 DSH 后，在本仓工作区的 live 会话上）：
  `edrv.accept` 与 `edrv.decideBatch` 对被本会话接管的记录返回守卫文案且**零写盘**；
  `edrv.list` 节流块内的自动结案已产生 895 批次 / 1096 条归档（reason 见上），
  被接管文件在差异栏只剩「待审」徽标、不再出现「历史改动」药丸。
- 跨会话放行分支无现场样本（本机旧记录已被批量结案清空），由
  `tests/pendingCoverGuard.test.ts` 第 3 例覆盖。

**未验证项**：GUI 点按验收需要重启 DSH 并部署本版后方可进行，本次未做；
真实大工作区（数百条待审）的耗时对比未实测，速度结论来自 RPC 次数与数据层复杂度分析。
