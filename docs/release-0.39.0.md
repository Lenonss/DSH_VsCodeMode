# dsh-vscode-mode v0.39.0 — AI 追踪窗口差异模型

日期：2026-11-25　基线：与 0.38.0 相同（Web `@deepseek-ai/dsh@0.2.3-alpha.2` / 桌面 `0.2.2-rc.5`）
上一版：v0.38.0

## 背景

面板里反复出现 `index.json` 这类待审记录，但它们不是 AI 写的。三条采集线都会造记录：

- `pending/capture.ts`：环绕 AI 文件工具，本来只认工具写入。
- `pending/externalCapture.ts`：监听整个工作区，没见过的路径会按「不存在 / 版本库基线 / 未知」建档，
  Unity 重写 `index.json`、生成 `.meta` 就进来了。
- `officialCapture.ts`：宿主 `workspace/changes` 用回合起止的 git 快照做整树 diff，回合内 Unity 改的
  文件天然在列表里，插件只是忠实搬运。

而且没有「关窗」概念：文件处理完以后，外部再改一次就又会冒出待审记录。

## 决策（用户确认）

1. **只认文件工具**：`edit` / `write` / `apply_patch` / `str_replace_editor` / `ops_*` 写工具确认改动才开窗；
   `bash`、代码生成器、MCP 直接写盘不追踪（宁可漏收，也不把 Unity 改动记成待审）。
2. **官方线按追踪集合过滤**：官方快照只保留当前开窗文件，未追踪文件不落库、不读 diff。
3. **旧记录直接清空**：v7 迁移删除旧待审、官方快照与旧工具活跃行；不做同步整库备份（避免 0.38 的卡顿）；
   归档批次保留。

## 窗口模型

```
idle ──AI 文件工具确认改了内容──▶ tracking(open)   基线 = 写前磁盘内容
tracking(open) ──窗口内任何改动──▶ tracking(open)   基线不动，内容取最新
tracking(open) ──处理完 / 内容回到基线──▶ closed
closed ──外部/Unity 改动──▶ closed（忽略）
closed ──AI 再次确认改内容──▶ tracking(open)   新基线 = 本次写前内容
```

- 关窗：文件级 Keep / Undo 成功；块级判定做完且无净差异；内容被折回基线。关窗后条目留在库里供
  撤销判定，但不再出现在列表，也不再接收外部改动。
- 重开：清掉该路径旧窗口的块决定与撤销行，避免跨窗口撤销。
- 持久化：窗口状态存在工作区 SQLite（`pending_entries.tracking` / `opened_at`），宿主重启、插件重载、
  Web/桌面切换都不丢；重启后启动校准把离线期间的改动补进同一条差异。
- 覆盖集：`PendingPage.coveredPaths` 含已关窗路径，面板据此压住官方旧行与旧工具记录，关窗后不复活。
- 旧宿主兼容：0.38 不写 `opened_at`，这类行一律按「已关窗」处理（不显示、不接收外部改动）；
  另写独立的 `tracking_schema` 标记，旧宿主把 `pending_schema` 写回旧值时不重复迁移、不反复开写事务。

## 改动

### 一、追踪窗口内核（host）

| 文件 | 改动 |
| --- | --- |
| `src/pending/tracking.ts` | 新增：`trackingOf` / `isOpenEntry` / `nextTracking` / `isTrackedPath` / `coveredPathsOf`；没有 `opened_at` 的旧宿主行按已关窗处理 |
| `src/pending/kernel.ts` | 条目带 `tracking` / `openedAt`；合并保留窗外时刻；新增 `applyTracking` |
| `src/pending/persist.ts` | v7 迁移（加两列 + 清空旧表 + 活跃记录重置标记 + `tracking_schema` 快路径）；列读写；`dropBlocks` / `dropHistory` |
| `src/pending/store.ts` | `foldWrite` 关窗后重开；`recordWrite` / `foldTracked` / `withWindow`；列表只返回开窗条目；判定与撤销后收尾；`emptyBaseOf` 只看 `earlierVersion`；删除版本库导入 |
| `src/pending/externalCapture.ts` | 只跟随开窗路径：未开窗事件直接丢弃；校准（启动 / 每 10 分钟 / 手动）；`setCapture` / `captureSync` |
| `src/pending/provenance.ts` | 去掉 agent 工具时间窗，只留自写 / 编辑器标记 |
| `src/pending/externalAlign.ts`、`src/pending/vcs.ts` | 删除：不再有版本库补扫与导入 |

### 二、官方线与覆盖口径

| 文件 | 改动 |
| --- | --- |
| `src/officialCapture.ts` | `tracked(cwd, identity)` 依赖；未追踪文件不读 diff 不落库；过滤后重算 `total/added/deleted`；一条不剩标 `complete` |
| `src/reviewDb.ts` | `captureState` 接受 `complete` |
| `src/pendingCompat.ts` | `mergedPage` 用覆盖集压官方行，返回 `pendingCoveredPaths` |
| `src/reviewRpc.ts` | 批量快照与单文件入口同口径覆盖 |
| `src/client/state/diffSummary.ts` | 覆盖集同时压住官方概览行与旧工具记录 |
| `src/store.ts` / `src/archiveDb.ts` / `src/registry.ts` / `src/rpc.ts` | 活跃记录重置标记（`markActiveReset` / `takeActiveReset` / `reclaimActive`），库与内存桶一起清 |

### 三、RPC、设置与客户端

| 文件 | 改动 |
| --- | --- |
| `src/pendingRpc.ts` | `edrv.pending.align` 改为校准追踪窗口，返回 `{checked, folded, gaps}`；删除 `pending.import` / `pending.refresh` |
| `src/shared/rpc.ts` | 方法表与返回类型同步 |
| `src/index.ts` | 接 `isTrackedPath` 过滤官方快照；接跟随器折叠；删除工具时间窗与版本库写命令补扫 |
| `src/client/ui/OfficialReview.ts` | 「补扫一次」→「校准一次」，文案按新返回值 |
| `src/client/ui/McpSettings.ts` | 「实时捕获 / 补扫对齐」→「实时跟随 / 定期校准」 |

### 四、测试

| 文件 | 改动 |
| --- | --- |
| `tests/pendingTracking.test.ts` | 新增 13 例：开窗、折叠、关窗、重开清撤销行、覆盖集、旧宿主行隐藏、v6→v7 迁移清库 |
| `tests/externalCapture.test.ts` | 重写 21 例：只跟随开窗、编辑器/自写窗口、删除、预算、校准 |
| `tests/externalWatch.test.ts` | 重写 7 例：真库端到端，未开窗文件不建档、Keep 后不复活、重开新基线、BOM/CRLF 保真 |
| `tests/officialCapture.test.ts` | 新增 2 例：按追踪集合过滤并重算总数、全过滤时标 complete |
| `tests/externalAlign.test.ts`、`tests/pendingVcs.test.ts`、`tests/pendingP4.test.ts` | 删除：被测模块已移除 |
| `tests/pendingKernel.test.ts`、`tests/pendingStore.test.ts`、`tests/reviewRpc.test.ts` | 按关窗后列表隐藏、重开基线、覆盖字段更新断言 |

### 五、版本文档

- `package.json` 0.38.0 → 0.39.0。
- `README.md` 差异审查与数据迁移说明、更新日志。
- `docs/gui-acceptance.md` 补 v0.39.0 验收项（真机待跑）。

## 验证

- `npx tsc -p tsconfig.json --noEmit`：0 error。
- `npm test`：vitest **352 文件通过 + 2 跳过（354）**，用例 **4387 通过 / 22 跳过（4409）**，约 35s；
  `node --test tests/nativeOpen.test.mjs` **9/9**，12.7s。
- 全量连跑多轮，其中一轮出现一次 `tests/uiState.test.ts` 的临时目录竞争（隔离 10/10 通过、
  该文件未被本批改动触及，随后几轮全量绿），判为环境抖动。
- `npm run build`：`lib/index.js` 1,501,804 B、`lib/client.js` 1,306,207 B；`client.rules.js` 14,162 B、
  `client.debug.js` 18,279 B、`client.excelcodec.js` 1,003,048 B、`client.excel.js` 11,600,224 B；
  `check-client-artifacts` 通过（未设 `EDRV_MODULE_LOADER`，Host loader 真加载未校验）。
- `node -e "import('./lib/index.js')"`：构建后 host 模块可加载，`name` / `apply` 正常；
  `lib/index.js` 含「差异窗口折入」「active_reset_v1」，`lib/client.js` 含「校准一次」「实时跟随」。
- **真机冒烟（Web 端 127.0.0.1:3080，2026-11-25 18:14–18:22）**：
  1. `write` 工具改 `tmp/smoke-tracking.txt`：DB 出现 `tracking=open`、`opened_at` 有效、
     基线 `base`、内容 `ai-1`。
  2. `pwsh` 改同一文件：同一条目折入，基线仍 `base`、内容 `unity-1`、`origin=external`、`unseen=1`。
  3. `pwsh` 连改没有被工具动过的 `tmp/smoke-untracked.txt` 两次：DB 里没有该路径的任何记录。
  4. 页面内调 `edrv.review.decide` Keep：`revision=2`，列表 pending 归零，覆盖集保留该路径。
  5. Keep 后再用 `pwsh` 改同一文件：条目保持 `tracking=closed`、内容不变，不复活。
  6. 再用 `write` 工具改：重开窗口，基线是 `unity-after-keep`（Keep 后外部改出来的内容），
     `opened_at` 换新、`revision=3`。
  7. 收尾 Keep + `edrv.pending.remove` 清掉测试条目，删除临时文件，DB 回到 0 条。

## 缺口

- **桌面端仍是 0.38.0**（`~/.dsh/profiles/desktop` 固定 npm 0.38.0）：两个宿主共享同一份工作区库时，
  旧端仍按旧逻辑显示并写入没有 `opened_at` 的行。新端已把这些行按「已关窗」隐藏、也不再折入外部改动，
  并加了 `tracking_schema` 快路径避免被旧端回写 `pending_schema` 后反复迁移；但旧端自己的面板仍会看到
  旧记录，需要把桌面端也升到 0.39.0（或先停掉桌面端）才能完全一致。
- 真机验收走的是 DB + 页面内 RPC（`edrv.review.decide` 等），没有逐点点击面板按钮；按钮调用的是同一组 RPC，
  但鼠标路径未逐步演练。
- 脚本 / 代码生成器 / MCP 写盘不再进审查是明确取舍；后续如需覆盖，另加显式「纳入追踪」入口。
- 双宿主同时打开同一工作区时，v7 迁移的并发行为未专项演练（迁移仍走 `BEGIN IMMEDIATE`，失败可重试）。

## 升级

- `npm i dsh-vscode-mode@0.39.0`，装完重启 DSH。link / 开发形态需先 `npm run build`。
- **Web 与桌面两端都要升级**：只升一端时，旧端仍按旧逻辑写行、显示旧记录；新端会隐藏它写出的
  `opened_at=0` 行，但两端对同一工作区的看法不一致。升级前建议先退出另一端。
- 首次打开工作区时自动跑 v7 迁移：清空旧待审条目、官方快照与旧工具活跃行（归档批次保留），
  不需要手动操作。
- 回退：`git revert` 本批提交并装回 0.38.0 可以启动，但被清空的旧记录不会恢复；需要保留旧记录时
  请在升级前自行备份 `~/.dsh/dsh-vscode-mode/data/archive/*.sqlite`。
