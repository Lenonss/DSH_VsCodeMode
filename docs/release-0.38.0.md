# dsh-vscode-mode v0.38.0 — 合并式差异 + 卡顿治理

## 背景

两件事叠在一起：

1. 撤销线原先是「每次判定存一份前后全文」的栈，一段代码改三次就留三份，库和 WAL 一路涨到
   数百 MB；用户要求的是合并语义——始终只有一条差异，新改动并进旧差异。
2. Keep / Undo / Keep All / Undo All 与差异块显现都要等十几秒，还时不时冒出
   「审查版本冲突，请刷新后重试」这类报错。

## 诊断（有证据，不是猜）

- 桌面端跑 `DeepSeek Harness 0.2.2-rc.5`（插件 0.37.0 发布版），Web 端 0.2.3-alpha.2 + 本仓库
  link。插件对版本只有能力探测，没有版本相关慢路径，**不是 DSH 版本问题**。
- 卡顿是整进程一起卡：桌面端插件日志 2026-11-25 03:19:36–37（UTC，本地 11:19）连着 6 个文件读
  RPC，`rpcMs` 分别为 12116 / 11576 / 10886 / 12536 / 11312 / 15028，全部在同一秒返回——事件循环
  被同步任务堵死后的集中排空。
- 同步大活来自归档库清理：`startArchiveSweep` 启动 90 秒后对全机每个归档库跑
  `VACUUM INTO`（整库复制）+ `VACUUM`（整库重写），`node:sqlite` 的 `DatabaseSync` 全同步。
  现存库 180–653 MB、WAL 480–658 MB。时间戳吻合：桌面端 10:55:29 启动，
  `*.before-purge.bak` 生成于 10:57:13–10:57:25。

## 改动

### 0. 并入同一批的并行 WIP

工作区里还有另一路未提交的改动，与本次共用一个待审库结构，无法干净拆分，故一并发布：

- SVN 提交对话框重做（`src/client/ui/SvnCommitDialog.ts`、`svnCommitModel.ts` + 两个测试）。
- 待审采集补「证据强度 / 调用结局」（`kernel.ts`、`capture.ts`、`externalCapture.ts`、`provenance.ts`、
  `pendingCompat.ts`、`shared/pendingReview.ts` + 三个采集测试），对应 `pending_entries.evidence/verdict` 两列。

两部分都随本批的门禁（typecheck + 全量 vitest + `node --test` + build）一起验证。

### 1. 合并式差异（用户决策：按路径合并 + 旧轮次直接不留）

- 待审投影维持既有合并语义（`kernel.mergeEntries`：基线留最早、内容取最新），补测试固定住。
- 官方审查线：`reviewDb.insertSnapshot` 改成按 identity 处理——同一路径只留一条记录，锚点
  （id / turn / seq）不动，新事件只把 `diff` 与摘要换成最新、`revision+1`；内容完全相同的重发
  保持已判定状态不重开；已判定且内容真的变了才丢弃旧行、另起一条待审。因此旧轮次不再逐条留档。
- 撤销栈：`pending_history` 改为每条路径一行（`baseline` / `content` / `kind` / `wrote`），
  撤销回到本条基线，重做按同一判定重放；v5 旧库打开时自动折叠迁移（同路径取最近一次判定）。
- 归档清理不再按步裁撤销栈（已是 O(1)/路径），只保留幂等表裁剪。

### 2. 卡顿治理

- 删除与备份/VACUUM 分离：删行仍在进程内（毫秒级），备份与 `VACUUM` 交给独立 Node 子进程；
  子进程只认「文件 + 备份路径」，业务规则仍只有 `purgeArchiveDb` 一份。
- 按天打戳（`archive/.sweep-YYYY-MM-DD`）：桌面端与 Web 端共用同一 home，一天只扫一次。
- 新增 `src/slowLog.ts`：>300ms 的操作与 >500ms 的事件循环阻塞各记一条，RPC 分发统一埋点。
- 列表派生结果（增删行数、块状态）按 `revision + 两侧长度` 缓存，5 秒轮询不再逐条重算整文件 diff。

### 3. 批量 Undo

- 新增 `edrv.review.undoAll`：一次往返、单事务、逐条回报，遇冲突即停；
  非本会话工具写入的来源由宿主先返回 `needsConfirm`，客户端确认后带 `confirmed` 重试同一批。
- 客户端 `runUndoAll` 取代逐条 `detail` + `decide`（N 条记录从 2N 次往返降到 1–2 次）。

### 4. 块身份

- 块 id 改为 `hunkIndex:内容指纹:序号`（FNV-1a，宿主与浏览器端同结果）。行号只作兜底：
  判定与显示两侧都会用旧 `hunkIndex:oldLine:newLine` 再匹配一次，升级前落库的块判定不必重做。

## 验证

- `npx tsc -p tsconfig.json --noEmit`：0 error。
- `npm run test`：vitest **350 文件通过 + 2 跳过，4373 通过 / 22 跳过（40.47s）**；
  `node --test` **9/9**。
- `npm run build`：host `lib/index.js` 1,388,527 B + `client.js` 1,296,424 B，六产物齐全。
- 新增 `tests/mergeDiff.test.ts`（5 例）：改三次仍只有一条差异、Keep 后继续累积仍一条、
  撤销行一条路径一行、块指纹跨行号稳定、v5→v6 迁移把多行折叠成一行。
- 同步按新契约更新既有测试：`reviewDb`（跨轮次合并成一条、相同重发不重开、撤回本轮、
  分页改用不同路径）、`reviewUndo`（相同重发不换身份）、`reviewRegions`/`reviewEvidence`/
  `officialAnnotations`（块 id 改指纹后按真实块 id 断言）。

## 部署与回退

- 桌面端（profile `desktop`）跑的是发布包，**本次未自动部署**：升级需装 0.38.0 后重启宿主并刷新页面。
- 回退：`pending_schema` 5→6 迁移不可逆，迁移前请留一份 `~/.dsh/dsh-vscode-mode/data/archive/*.sqlite`
  备份；回退旧版插件时旧代码读不到新表，需连备份一起还原。

## 已知未做

- 两个宿主同开同一工作区时仍共享同一份 sqlite（`busy_timeout=2000`），极端并发下仍可能偶发
  `SQLITE_BUSY`。计划里的「桌面端独占写、另一端只读」这次没有实现（该项在计划页里未被勾选）。
