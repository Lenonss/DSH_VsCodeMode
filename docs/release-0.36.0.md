# 0.36.0 — 审查捕获补上「非工具写盘」+ MCP 会话计时

日期：2026-11-24　基线：`@deepseek-ai/dsh@0.2.3-alpha.2`（Web）／`@deepseek-ai/dsh-desktop@0.2.2-rc.5`（桌面端）
上一版：v0.35.0（`9e35556`）

## 背景

审查捕获只认 DSH 的 `tools/result` 与写工具白名单（`edit` / `write` / `apply_patch` / `dsh-ops` 写工具）。
agent 用 `ops_bash` 跑 `node -e`、prettier / eslint --fix、代码生成器、python / sed / powershell 直接写盘时，
文件确实变了但插件毫不知情：审查面板空着、没有修改前快照、撤销无从下手。

用户原话：「文件确实变了，但插件完全不知道 —— 审查面板空着、没有 before 快照、`undoReview` 无从撤销，
用户以为 agent『没改』或『改了没记录』。本次事故中 5 个文件（含 1 个新建 .cs + .meta）全部漏采」。

MCP 一侧的问题是托管后端（官方 `mcpManager`）的会话卡片没有真实计时：托管不建本会话连接账目，
卡片把「正在起来」显示成 idle，配置就绪后会话状态还会停在 preparing。

## 决策

1. 路线取「watch + 补扫」组合：`fs.watch` 负责及时性，版本库补扫负责启动对齐与兜底；两条都写进现有待审投影，
   不新建存储。不采用「扫 bash stdout 猜路径」，漏检率高且拿不到修改前内容。
2. 唯一事实源是「插件已知内容」（条目 `new_text`、首次观察快照、版本库基线），因此两条路线天然不重复记录。
3. 修改前内容按 `已知 → 不存在 → 版本库基线 → 未知` 四级降级；拿不到就只标注、禁撤销，绝不伪造空内容。
4. 撤销白名单：只有 agent 来源且基线可信时直接可撤销；编辑器保存 / 版本库基线需确认；基线未知一律置灰。
5. 编辑器保存不做成待审行（每 800ms 防抖一次，会刷满面板），只推进基线。
6. MCP：托管后端的时间取自挂载时刻与官方 `connectedAt`；官方状态里 `reconnecting` /
   `waiting-credentials` / `waiting-authorization` 也算「正在起来」。

## 改动

### 一、外部改动采集（host）

| 文件 | 改动 |
| --- | --- |
| `src/pending/provenance.ts` | 新增：来源 / 归属枚举与映射、三类时间窗（工具调用、编辑器保存、插件自写）、去重键 `pathKey + sha256(content)`、撤销策略与徽标文案 |
| `src/pending/externalCapture.ts` | 新增：工作区递归监听 + 300ms 静默 / 2000ms 封顶合并、忽略清单、判定链、轮询版本号、四个补扫触发点（启动 / 版本库写命令后 / 手动 / 每 10 分钟） |
| `src/pending/externalAlign.ts` | 新增：一条 `git status` / `svn status` 出候选、按预算读基线与内容、截止时间到点即停并写缺口、无版本库时降级为只对齐已记录条目 |
| `src/pending/vcs.ts` | 新增 `vcsStatus`（候选与「干净」判据）与 `vcsBaselineOf`（`git show HEAD:` / `svn cat -r BASE`） |
| `src/pending/persist.ts` | 待审库 v3 → v4：新增 `source` / `origin` / `base_kind` 三列（带默认值，旧行可读）；`pendingVersion` 单调计数 |
| `src/pending/kernel.ts` / `store.ts` / `decide.ts` | 条目带来源字段；折叠时强通道保留来源；能力位按白名单给 `confirmRevert`；`applyDecide` 允许 `createIfAbsent` 重建已删除文件 |
| `src/pending/capture.ts` | `PendingWrite` 带工具名；`noteCaptureGap` 供外部采集上报缺口 |
| `src/index.ts` | 装配采集器、`tools/execute` 归属窗口、`session/created` 开监听、版本库写 RPC 后串行排补扫、卸载收尾 |
| `src/capture.ts` / `src/rpc.ts` | 远端镜像写穿与编辑器保存打窗口标记，避免自己的写盘被记成外部改动 |
| `src/fileOpenSettings.ts` | 新增 `externalWatch` / `externalScan` 两个开关（默认开）与 `external()` 视图 |
| `src/pendingRpc.ts` / `src/shared/rpc.ts` / `src/shared/pendingReview.ts` / `src/shared/review.ts` | 新增 `edrv.pending.align` / `edrv.pending.version`；`ReviewItem.sourceLabel`、`capability.confirmUndo` |

### 二、面板与设置（client）

| 文件 | 改动 |
| --- | --- |
| `src/client/state/reviewFeed.ts` | 1s 轮询待审版本号（只读内存计数），变号才整页重读：新记录出现延迟从 5s 量级降到 1s 量级 |
| `src/client/state/diffSummary.ts` / `src/client/ui/OfficialReview.ts` | 非 agent 来源在差异栏标签与审查列带徽标；审查列新增「补扫一次」按钮与结果提示 |
| `src/client/reviewBatch.ts` / `src/client/ui/EditorView.ts` | 撤销白名单闸门：非 agent 来源弹一次确认（批量撤销只问一次） |
| `src/client/ui/McpSettings.ts` | 设置页「改动捕获」分区：实时捕获 / 补扫对齐 |

### 三、MCP 会话计时（托管后端）

| 文件 | 改动 |
| --- | --- |
| `src/mcpManaged.ts` | 托管账目记挂载时刻 `mountedAt`，`stateOf` 带出 `since` 与官方 `connectedAt` |
| `src/mcpManagerBridge.ts` | 官方视图解析 `status.connectedAt` |
| `src/mcpRuntime.ts` | 新增 `managedServer`：托管后端按挂载时刻与连上时刻给阶段与耗时；`record.finishedAt ??= Date.now()` 修「配置就绪后会话状态停在 preparing」；`STARTING_STATES` 归一四种「正在起来」状态 |

### 四、测试

| 文件 | 改动 |
| --- | --- |
| `tests/externalCapture.test.ts` | 新增：忽略清单、判定链、修改前内容四级来源、去重与预算、撤销白名单、补扫触发点 |
| `tests/externalAlign.test.ts` | 新增：git / svn 候选与基线、删除与未跟踪、条数/基线/截止时间三个预算、无 shell 与命令失败降级 |
| `tests/externalWatch.test.ts` | 新增端到端：bash 写盘→记录→撤销恢复、连写 5 次只 1 条、新建/删除的撤销语义、工具写盘不重复、CRLF+BOM 字节不变、非 UTF-8 只记缺口 |
| `tests/reviewFeed.test.ts` | 按方法分发的 mock；新增「版本号变化 1s 内触发整页重读」 |
| `tests/settingsAdaptive.test.ts` / `tests/compat.test.ts` | 设置字段全集与 volatile 计数 22 → 24 |
| `tests/mcpManaged.test.ts` / `mcpManagerBridge.test.ts` / `mcpRuntime.test.ts` | 托管计时与状态归一 |

## 验证

- `npm run typecheck`：0 error。
- `npm run test`：vitest 343 个文件通过 / 2 跳过（345），用例 4292 通过 / 22 跳过（4314）；
  `node --test tests/nativeOpen.test.mjs` 9/9。
  新增三个采集文件共 40 例（`externalCapture` 23 / `externalAlign` 10 / `externalWatch` 7）。
- `npm run build`：`lib/index.js` 1,327,822 B、`lib/client.js` 1,292,410 B；client 产物校验通过。
- 全量跑中出现过一次 `tests/uiState.test.ts` 的 `EPERM rename`（`%TEMP%` 竞争），隔离 3/3 通过、
  该文件未被本批改动触及，判为环境抖动；随后两轮全量均绿。
- 缺口：watch / 补扫 / 手动按钮的真实 GUI 端到端未在本机复验（需重载 host 插件）；
  在真实工作区跑一次 `node -e "fs.writeFileSync('a.txt','x')"` 即可看到面板出现 `watch` 记录。

## 升级

- `npm i dsh-vscode-mode@0.36.0` 或按 README 的三种安装方式升级，装完重启 DSH。
- 待审库自动从 v3 迁到 v4：只加三列带默认值，旧记录照常可读，不需要手动迁移。
- 不想用新能力可在设置页关掉「改动捕获」两个开关，行为退回 0.35.0。
