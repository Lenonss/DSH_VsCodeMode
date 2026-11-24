# 0.37.0 — 答复先送达再批准 + 幽灵待审记录治理 + 归档库每日清理

日期：2026-11-24　上一版：v0.36.0（`0451975`）
基线说明：本次只动插件自身的 RPC、采集与清理逻辑，宿主 DSH 版本与 0.36.0 相同。

## 背景

三件事在 0.36.0 之后攒到一起：

1. **计划页答复晚一步送到。** 「回复并执行」原来的顺序是「先结算审批，再把答复按 queue 送进对话」。
   审批一结算，宿主立刻把工具结果交给模型并开始下一步，而 queue 的消息属于**下一回合**；表现为
   agent 直接开跑，用户填的答复等这一轮结束才送到，看起来像被忽略。
2. **面板刷出幽灵待审记录。** 外部改动采集在拿不到版本库状态（没有 shell、`git status` 失败、
   Perforce / 无版本库）时，把监听到的「文件被读过」当成「文件被改过」——整树扫描、索引器、
   杀软 touch 都会触发事件。首次见到的路径一律按整文件新增建档，于是记录里的差异是在拿
   「读出来的内容」跟「不存在」比。而且此前没有任何清理入口，幽灵记录只能一条条点掉。
3. **归档库只增不减。** `batches` / `records` / `pending_history` 长期累积，没有保留期与上限。

## 决策

1. **送达顺序只能反过来：先 steer 正文，再结算审批。** `session/prompt` 的 `steer` 模式把消息
   送进当前回合，agent 下一次请求就能读到，批准结果与答复落在同一次模型请求里。
   - steer 失败就**不动审批**，保持待处理可重试，避免「批了但答复没送到」的半截状态；
   - 批准失败时明确提示「答复已送达」，并用 `steeredReplies`（同 callId + 同正文）去重，
     用户再点一次不会把同一份答复送两遍；
   - 旧宿主没有带 mode 的通道时，steer 直接回不可用，**不用输入框 `submit()` 顶替**
     （那会把「同一步送达」悄悄降级成下一回合）。
2. **幽灵记录两道闸门。** 采集侧：拿不到版本库状态时，首次见到的路径必须自带证据——
   文件 mtime 不早于监听开始时刻（留 2s 时钟容差）；不满足就只记一条缺口、不建档。
   运维侧：新增 `edrv.pending.purge`，按「采集通道 + 基线可信度 + 时间窗」清理，
   **有判定历史（Keep/Undo 过）的条目一律保留**，dryRun 只报数，真删后按需 VACUUM。
3. **归档库只删已判定的内容。** 未判完的批次（`batches.pending > 0` 或批内有 pending 记录）整批跳过；
   时间解析失败当「不超期」；删除顺序写死 `revert_intents → records → batches`（SQLite 默认不开外键）；
   真删前先留一份 `<db>.before-purge.bak`。

## 改动

### 一、计划页答复送达（client）

| 文件 | 改动 |
| --- | --- |
| `src/client/addToConversation.ts` | 新增 `TaskSendMode`（`queue` / `steer`）；`sendTaskResult` / `sendOwned` / `sendLegacy` / `httpTaskResult` 全部透传 mode；旧通道下 steer 不再回落输入框 `submit()` |
| `src/client/htmlPlan/planActions.ts` | 新增 `steerTask` 注入与 `steerIntoRun`；`submitPlanResponse(sessionId, text, approve)` 改为「先 steer 正文 → 再结算审批」，两种失败各自给可读原因；`steeredReplies` 去重 |
| `src/client/htmlPlan/HtmlPlanPanel.ts` | 「回复并执行」的提示改为「答复已随批准送进当前回合，agent 会带着答复开始执行」；`regenerate()` 把「继续规划」与修复指令合并成一次提交 |
| `src/client/htmlPlan/planPage.ts` | 页内按钮提示同步新语义 |

### 二、待审采集与清库（host）

| 文件 | 改动 |
| --- | --- |
| `src/pending/externalCapture.ts` | 新增「首次见路径的建档证据」闸门：无版本库状态 + 路径没被见过 + mtime 不新 → 只记缺口不建档；`noteGapOnce`（去重表上限 500）、`noteStatusOnce`（每工作区 5 分钟节流）；`EXTRA_IGNORE_SEGMENTS` 注释澄清「不按目录名一刀切」 |
| `src/pending/vcs.ts` | `vcsStatus` / `gitStatus` / `svnStatus` 增加 `onFailure` 回调，把「为什么没有状态」写进缺口（含命令 stderr 前 200 字） |
| `src/pending/persist.ts` | 新增 `purgeEntries`（事务内删条目与块，保留已判定条目，`bumpVersion`）与 `vacuumEntries`；`PurgeFilter` / `PurgeOutcome` |
| `src/pending/store.ts` | 新增 `purgePending`：默认口径 `watch` 通道 + `absent` 基线（幽灵记录就长这样），dryRun / VACUUM 可选 |
| `src/pendingRpc.ts` / `src/shared/rpc.ts` | 新增 `edrv.pending.purge`，回执带命中/删除/保留条数与 VACUUM 耗时；删除后重建「待审接管」集合 |

### 三、归档库清理（host）

| 文件 | 改动 |
| --- | --- |
| `src/archivePurge.ts` | 新增：保留期 30 天 / 每路径 20 批 / 每条目 10 步撤销栈 / `op_ids` 留最近 500；`pickCandidates` 只挑已判定批次；真删前备份；`startArchiveSweep` 启动后按天扫描本机所有归档库 |
| `src/index.ts` | 装配每日清理并在卸载时 `dispose` |
| `src/rpc.ts` / `src/shared/rpc.ts` | 新增 `edrv.archive.purge`（缺省 dryRun，显式 `false` 才删） |

### 四、文档与测试

| 文件 | 改动 |
| --- | --- |
| `tests/archivePurge.test.ts` | 新增 7 例：保留期、未判完整批保留、每路径上限、dryRun 不动库、撤销栈截断、连带清撤销意图、每日扫描多库 |
| `tests/pendingPurge.test.ts` | 新增 5 例：dryRun、默认通道口径、已判定条目保留并计数、时间窗筛选、无命中不 VACUUM |
| `tests/externalCapture.test.ts` | 补 5 例：无状态且未改动 → 不建档只记缺口、刚写过 → 仍建档且基线 unknown、观察过的路径照常记录、版本库说有改动不受闸门影响、读盘失败只记缺口 |
| `tests/htmlPlanActions.test.ts` | 补 7 例：先 steer 再同意执行、steer 失败不结算审批、「回复并执行」全链路、批准失败报「已送达」不重复送、继续规划同样先 steer、无待审批退化、空指令失败文案 |
| `skills/dsh-vscodemode-html-plan/SKILL.md` / `docs/gui-acceptance.md` | 答复语义与验收口径同步 |

## 验证

- `npm run typecheck`：0 error。
- `npm run test`：vitest 345 个文件通过 / 2 跳过（347），用例 4312 通过 / 22 跳过（4334），33.68s；
  `node --test tests/nativeOpen.test.mjs` 9/9（12.3s）。本轮无抖动，未出现 `dapFakeAdapter` / `treeIndex` 已知抖动。
- `npm run build`：`lib/index.js` 1,344,145 B、`lib/client.js` 1,293,026 B；另有 `client.rules.js` 14,162 B、
  `client.debug.js` 18,279 B、`client.excelcodec.js` 1,003,048 B、`client.excel.js` 11,600,224 B；
  `check-client-artifacts` 通过（`EDRV_MODULE_LOADER` 未设，Host loader 真加载未校验）。
- 构建告警均为既有项：`external` / `noExternal` 已弃用、`INVALID_ANNOTATION` 若干处 `/* @__PURE__ */`
  位置问题，均不在本批改动内。

## 缺口

- 计划页「回复并执行」的**真机 GUI 端到端未复验**（需要重载 host 插件并打开真实计划页走一遍），
  本次按用户要求带上该缺口发布：送达顺序、失败不结算、去重三个分支由单测覆盖，真浏览器路径未跑。
- 归档清理的每日扫描只在本机单库、单进程下验证；多工作区并发同时开扫未演练。

## 升级

- `npm i dsh-vscode-mode@0.37.0` 或按 README 三种安装方式升级，装完重启 DSH（host 侧新增 RPC 与清理任务）。
- 不需要数据迁移：待审库与归档库结构未变，`edrv.pending.purge` / `edrv.archive.purge` 均为新入口。
- 想先看不删：两个入口都支持 `dryRun`，`edrv.archive.purge` 缺省就是 dryRun。
