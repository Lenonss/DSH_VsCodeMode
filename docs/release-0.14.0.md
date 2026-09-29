# dsh-vscode-mode 0.14.0 发布说明

> 发布准备记录，2026-09-29。基线为已发布的 `v0.13.1`（tag `c8d9843`）。本版是功能版本：
> 让插件界面状态（打开的页签与活动页签、光标/滚动位置、侧栏开关与宽度、编辑 Tab 激活态、
> Markdown 预览态、导航历史）**跨 DSH 重启**恢复。

## 背景：为什么以前重启必丢

DSH 桌面端/Web 每次启动监听**随机端口**，`http://127.0.0.1:<port>` 即浏览器的
origin，而插件的全部界面状态此前只写在 `localStorage` 里 —— 换 origin 就等于换了一份
空的存储。实测 Electron `Local Storage\leveldb` 内同时存在十余个随机端口 origin，
证实「仅靠 localStorage 不可能跨重启」。本版把界面状态镜像到 DSH home 下的磁盘文件，
启动时回填。

## 本版变化

### 1. Host 侧界面状态镜像（新增）

- 新增 `src/uiState.ts`：读写 `{version, updatedAt, keys}` 形状的镜像文件，**写前合并**
  （同一文件内不同工作区、不同键互不覆盖），拒绝超限内容。
- `src/paths.ts` 新增 `uiStateFile(cwd)` / `uiGlobalsFile()`：落
  `DSH_HOME/dsh-vscode-mode/cache/workspace/<hashOf(cwd)>/ui.v1.json` 与
  `cache/user/ui-globals.v1.json`；两者均纳入 `CACHE_SCHEMAS` 清理白名单（版本不符才清，
  当前版本受保护）。
- RPC 新增两个方法（`src/shared/rpc.ts` 双侧契约 + `src/rpc.ts` handler）：
  `edrv.uiState.get` / `edrv.uiState.set`，分「工作区键」与「全局键（跨工作区共享）」两分区。

### 2. 客户端镜像层（新增 `src/client/state/uiStatePersist.ts`）

- 包装 `localStorage` 的 `setItem`/`removeItem`：只镜像白名单键（`edrv.*` 前缀，排除目录
  条目缓存 `edrv.cache.entries.v2.*`），去抖（400ms）批量推送；窗口关闭前补推一次。
- 启动水合：取回 host 镜像 → 回填 localStorage（**本地已有值一律保留**，不覆盖用户
  当前 origin 的真实状态）→ 就绪后广播 `edrv:ui-state-ready`。
- 无 `localStorage` / 装配失败时静默退回原行为（纯 localStorage），不阻断插件加载。

### 3. 新增/补全的记忆项

- **官方编辑 Tab 激活态**：`edrv.editor-tab.v1.*`（此前是模块级内存变量，重启后编辑 Tab
  不会自动展开）。
- **Markdown 预览态**：`edrv.md-preview.v1.*`（新增 `src/client/state/mdPreviewCache.ts`，
  此前明确「不持久化」）。
- **导航历史**：`edrv.nav-history.v1.*`（新增 `src/client/state/navStateCache.ts`，此前
  纯内存、按 scope 上限 6 组 FIFO）。
- 既有项全部纳入镜像：页签/活动页签、`viewstate`（Monaco `saveViewState()` 光标与滚动）、
  侧栏开关/宽度/面板、资源管理器展开与工作区折叠、规则分页、搜索、SVN 过滤与折叠、
  调试面板监视/折叠与 DAP 分栏高度、断点。

## 本版修复（两次现场复盘）

发布前用户两次反馈「重启后没效果」，逐层取证后确认两条**并存**根因并修复：

1. **水合冷启动失败即永久放弃**：`apply` 期 host 的 `requireSession` 尚未就绪，返回
   「会话不存在」→ 取回抛错 → 旧代码 `if (filled > 0) emitReady()` **永不广播**就绪事件，
   界面侧迟到回填逻辑永不触发，也没有重试。现在：有界重试（8 次 × 800ms），且
   `settle()` 在成功**或重试耗尽**时都广播就绪（不再要求回填数 > 0）。
2. **界面在回填前把空初值写进 localStorage**：换 origin 后存储为空，编辑器挂载即写入
   `{"tabs":[],"active":null}`，而回填遵守「本地已有值优先」→ 迟到回填永远填不进去
   （host 镜像里工作区作用域那条恰好 25 字符的空值就是污染快照）。现在：编辑器页签/侧栏/
   导航三个写效应在「水合未结束」期间不写（`uiStateSettled()` 门控），并把水合完成标记
   加入依赖，迟到回填后**重跑恢复**（含侧栏，此前其恢复效应缺少该依赖）。
3. **无会话期诊断会丢**：`edrv.debug` 同样先 `requireSession`，冷启动期的水合失败上报会被
   拒成 `{ok:false}`。现在该 handler 在取不到会话时回退伪 cwd `ui-state` 落
   `logs/debug.<hashOf('ui-state')>.log`，保证诊断必达。

另：`apply` 改为 `async`，在 slot 注册前于「已知会话」时短等待（≤600ms）水合，争取回填
早于任何面板挂载；末尾再兜一道 ≤1.2s 等待。两处都有超时，失败不抛、不拖慢启动。

## 影响面与兼容性

- 新增 host 模块、2 个 RPC 方法、3 个客户端状态模块与 2 个 new 缓存文件；无配置迁移，
  无依赖与 lockfile 变化。
- 老版 DSH / 无 `localStorage` 环境：镜像装配失败即退回纯 `localStorage`，行为与 0.13.1
  一致。
- 体积与隐私：镜像只收 `edrv.*` 白名单键，目录条目缓存不入镜像；单键按 64 KB 分片上传，
  写前合并不覆盖其他工作区；镜像文件位于 DSH home，不会写入被审查的工作区（除非该工作区
  本身就是 DSH home）。
- 已知遗留（非本版缺陷）：镜像里**已被旧版本写坏的空值不会自愈**（回填遵守「本地优先」），
  在该工作区手动打开一次文件即恢复真实状态；`viewstate` 仅在切页签/卸载等保存点采集，
  某工作区若从未切过页签，其光标位置本就无可恢复内容。

## 回滚到 0.13.1

按原 profile 的官方插件管理方式安装 `v0.13.1`（tag `c8d9843`）产物，随后重启 Host、刷新
原应用。回滚**不需要数据修复**：新增的 `ui.v1.json` / `ui-globals.v1.json` 只是旧版不会
读取的缓存文件，留在磁盘上不影响 0.13.1 行为。

## 发布验证记录（2026-09-29）

| 检查 | 实际结果 |
|---|---|
| 版本与基线 | 包 `0.14.0`；基线 `v0.13.1` @ `c8d9843` |
| 类型检查 | `pnpm run typecheck` → exit 0 |
| 全量 JS/TS 测试 | `pnpm test` → `vitest` **179 文件通过 + 2 跳过（181）；2377 用例通过 + 12 跳过（2389）**，16.21s；`node --test tests/nativeOpen.test.mjs` 9/9；整体 exit 0 |
| 新增用例 | `tests/uiStatePersist.test.ts`（19）、`tests/uiState.test.ts`、`tests/mdPreviewCache.test.ts`、`tests/navStateCache.test.ts`、`tests/paths.test.ts` 扩展 |
| 构建 | `pnpm build` exit 0 → `lib/index.js` 734144 B；`lib/client.js` 1499417 B（tsdown 双面，2026/9/29 11:01:40） |
| 端到端现场验证 | **已做**：冷启动新 origin `127.0.0.1:11960` 实测（日志时间线见下），页签 2 个、活动页签、导航历史 `past=1`、侧栏 `on=true width=300 panel=explorer` 全部恢复；镜像写入失败计数 0 |
| Linux / macOS | **未**现场验证（本版无平台分支改动） |

现场时间线（`DSH_HOME/dsh-vscode-mode/logs/`）：

```
10:54:42.019  镜像装配成功（origin=http://127.0.0.1:11960）
10:54:42.019  水合失败（第 1 次，800ms 后重试）: Error: 会话不存在
10:54:42.863  水合开始（第 2 次）→ 回填键 ×12
10:54:42.863  水合完成：host 镜像 13 键、本地搬运 0 键、回填 12 键
10:54:42.863  水合阶段结束（就绪；已回填）
10:54:53.737  页签恢复（scope=ws:…/dsh-edit-review）：存档 2 个、保留 2 个、活动 .workbuddy/memory/2026-08-26.md
10:54:53.737  导航历史恢复：past=1 future=0 ／ 侧栏恢复：on=true width=300 panel=explorer
```

发布走仓库既有 tag → GitHub Actions 流程（验证 tag 版本 → 三门 → npm pack → GitHub Release
挂 tgz），不在本地直接 `npm publish`。本文件记录发布准备与验收边界，不授权额外部署、
OS 注册或外部消息操作。
