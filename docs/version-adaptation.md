# DSH 版本适配机制（dsh-vscode-mode）

> 机制目的：DSH 以 alpha/rc 高频发布（0.1.2-alpha.x 起几乎每日一发且 Web 端自动更新拉取），
> 插件需在"影响性版本线"上自动切换 API 策略，失败一律安全降级并把状态写进
> 「设置 → VSCodeMode → 兼容性」报告与启动日志，而不是等用户回滚 DSH。
> 作者 ddj 2026-09-02 · 随 0.1.43 落地

## 一、机制骨架

```
src/dshVersion.ts            版本探测 + semver 比较/区间（createRequire 解析
                             @deepseek-ai/dsh-settings/package.json，候选降级）
src/fileOpenSettings.ts      runSettingsInstall：四策略分派（见下），模块级观测
                             状态 settingsInstallStrategy()/settingsInstallNote()
src/compat.ts                buildReport：报告并入 dshVersion + 版本适配行 +
                             高于实测版本 / 安装不可用 警告
src/client/ui/McpSettings.ts 兼容性页签新增「版本适配」分组与 DSH 版本标题
scripts/audit-dsh-compat.mjs 双树导出面/服务面例行比对（新 alpha 发布后跑）
docs/version-adaptation.md   本文档（版本线 × 影响 × 适配器矩阵）
```

### 设置 section 安装四策略（runSettingsInstall）

| 策略 | 触发条件 | 行为 |
|---|---|---|
| `legacy` | 动态导入的 `@deepseek-ai/dsh-settings` 仍导出 `installSettingsSection` | 原样调用 free function（rc 线，行为与 0.1.42 一致） |
| `service` | 导出已移除（0.1.2-alpha 起）→ `ctx.inject(['settings'])` 后探测 `provider.installSection` | 调用服务方法 `installSection(ctx, ns, schema, entry, hooks)`（等义封装：base 层 + fiber 卸载回退） |
| `forms` | `installSection` 已移除（0.1.7 起）且 `describe+update` 在场（SettingsForms） | 不装 section（设置并入插件 `export const Config` schema）；订阅 `settings/document-updated` 推 hooks（disposer 经 ctx.effect 随 fiber 卸载） |
| `none` | 两路皆不可用 | 仅告警并记录；fileOpenTool/keybindings/LSP 设置按配置值运行 |

全程 try/catch，**不产生未捕获 rejection**（0.1.2-alpha.2 曾因直接调用已移除导出
导致异步抛错 + `void` 调用 → unhandled rejection，即 restore 记录里的插件破坏根因）。

## 二、版本线 × 影响 × 适配矩阵（实证基准：rc.2 ↔ 0.1.2-alpha.2 双树比对）

| 版本线 | 影响性变化（实证） | 插件影响 | 适配器/状态 |
|---|---|---|---|
| `0.1.0-rc.7/rc.8`、`0.1.1-rc.1/rc.2`（08-17~08-21） | 基线：`dsh-settings` 导出 `installSettingsSection/settingsNamespace/deepEqualJson`；`slots`/`conversationEvents`/`conversationViews` 服务由 `dsh-client-runtime` 提供 | 无（插件诞生基线） | `legacy` 策略 · **rc.2 现网验证中** |
| `0.1.2-alpha.1`（08-28）起 alpha 线 | ① `dsh-settings` 移除 `installSettingsSection/settingsNamespace/deepEqualJson`，SettingsProvider 新增 `installSection(owner, ns, schema, entry, hooks)` 方法；② `dsh-client-runtime`、`dsh-host-apiproxy` 包从核心树移除（slots 服务改由 `dsh-client-ui-renderer` 提供；新增 api/sdk/controller 系列）；③ 部署期 apiproxy `WEB_SETTINGS_NAMESPACES` 白名单补丁不再适用（api-settings-controller 自动暴露） | ① host 两处设置 section 注册崩溃点 → **0.1.43 已适配（service 策略）**；② 插件 client 源码零静态依赖 @deepseek-ai 包、服务级 inject 9 名全部有同名提供者 → 加载关通过（审计表见下）；`dsh.client.inject` 收敛为空（图排序不校验 inject 存在性，实证自 dsh-client-modules 源码）；③ 无代码影响，部署脚本不再需要白名单补丁 | `service` 策略 · **待 alpha 实测闭环**（见第五节） |
| `0.1.2-alpha.3`（08-31） | 移除可选 SQLite Session 持久化后端 | 插件用 JSONL 会话、`sessions.list` 摘要 → 无影响 | 监控项 M1 |
| `0.1.2-alpha.4`（09-01） | `Session.events` → `seq/eventAt()/snapshotEvents()`；`SessionSeq`/`SessionLogOffset` 强类型 | 插件不消费 Session 事件流 → 无影响；未来接入会话日志按新 API | 监控项 M2 |
| `0.1.5-alpha.1` 起 | 官方右侧 Sidebar（`sidebarRight`/`sidebarRightTabs`）+ `sidebar.panellist` | 编辑区改住官方右侧 Sidebar Tab；`dsh-resource://file/**` 认领转发 | **0.1.44+ 已适配** |
| `0.1.6-alpha.1` | MCP SDK v2；Web 侧边栏终端；文件链接默认侧栏预览 | 版本探测宿主锚点修正（避免 dev-link 命中 rc 副本） | **0.4.4 已适配** |
| `0.1.6-alpha.2`（09-17）线 | ① **`sessions.list` 移除 `current`/`currentAddress`**（客户端 Session 多实例共存）；② 新增回合作产物：`dsh-workspace-changes` 回合改动卡片 + `dsh-client-ui-deliverables` 侧边栏逐文件审阅；③ 侧栏 Office 预览（`ui-sidebar-documentpreview`）；④ 侧栏浏览器 Tab；⑤ 侧栏布局持久化；⑥ 插件依赖改运行时解析 + 支持运行时卸载；⑦ 默认模型移除 V4 Flash 系列 | ① **命中 4 处读取**（Monaco 预热 / LSP 会话同步 / 编辑 Tab 跨会话恢复 / 文件链接上下文）→ 新增 `src/client/sessionScope.ts` 三级取值链（`uiSession.current` → `list.current` → `byId.retainedBy.mainView`）+ 订阅合流；② 数据源关系见 `plans/version-adapt-0.1.6-alpha.2/`（官方为回合级只读聚合，不可替代自有调用级记录源，仅作补充覆盖）；③ **命中冲突**：本插件 `extension` 档全量认领 `file/**` 会盖过官方 Office/builtin 渲染器 → `deferToOfficial()` 后缀 carve-out 让位（Office 11 项 + 官方不可预览 52 项，例外保留 `avif` 图片预览）；④⑤ 与自研 `sidebar.right.pane.tab` 不冲突，但恢复路径不得依赖内存态；⑥ 卸载洁净度审计（模块级单例复位）；⑦ `aiProvider/aiModel` 指向已下架模型时给降级提示 | **已适配（0.5.1）** · `service` 策略不变 |
| `0.1.5-0`+ 起（**包改名**） | vendored `schemastery` 改名为 **`@deepseek-ai/schemastery`**，全树 60+ 官方包统一 `import z from "@deepseek-ai/schemastery"`；安装树**不再有**裸 `schemastery`（rc 线仍有，且 rc.8 `dsh-settings` 的 peer 写的就是旧名） | **命中**：`fileOpenSettings.loadSettingsDeps` 用 `Promise.all([hostImport('@deepseek-ai/dsh-settings'), hostImport('schemastery')])`，裸名在 npm 安装树下解析失败 → 整体 reject → `installOpenSettingsSection` 早退 → **「设置 section 尚未装配」**（开发形态因插件自带 devDependency 副本而不复现） | **已适配（0.5.2）**：schema 库改候选链解析（新名优先、回退旧名），`dsh-settings` 独立解析且不再拖垮整体；命中库名进兼容性报告 |
| `0.1.7-alpha.1`（09-22）线 | ① **`settings.installSection` 移除**：settings.yaml 一次性导入 profile 插件配置，设置值 = loader entry Config（`SettingsForms.describe/update`，ns=profile entry id，revision 冲突抛 `SettingsConflictError`）；② **client `settingsScope` 服务移除** → 新 `configForms`（`ctx.configForms.get(entryId)` → `ConfigForm` 快照/写队列），官方包改走 `remote.settings` 镜像；③ 会话日志 V4（文件名 `session.jsonl[.zstd]` 不变，perf 仅 stat）；④ 官方新增 Excel 预览（含 **CSV/TSV**）与 `archiveSession(stopActivity)/pin/unpin`（持久标志位 `archivedSessionIds`，**不搬目录**，与插件 sessions-archive 搬移双轨）；⑤ 插件 manifest 可声明 `icon`（SVG/PNG/JPEG/WebP ≤256KiB）+ **包根 `locale/<lang>.json`**（en 必须，平面键 `title/description`，fallback 到 package.json name/description，实证 `readPluginMeta`/`dictionariesOf`）；⑥ Config schema 字段级 `.volatile()` 免重载；⑦ `--dump-config-schema` 导出 patch JSON Schema；⑧ Remote 二进制传输 | ① **命中**：`runSettingsInstall` 恒降级 `none` → **新增 forms 策略**：describe+update 在场即记 forms、订阅 document-updated 推 hooks；插件新增 **`export const Config = buildSettingsSchema(z)`**（与 section schema 同源，全字段默认值 → undefined/空配置经 schemastery 自动填充，rc/alpha 两代 cordis 启动校验实测必过）；读写统一 `sectionOf`（ns+形状双校验）与 `updateSection`（冲突重读重试一次）；② **命中 P0**：client inject 含 `settingsScope` = 整客户端停等 → 移出 inject + `compat.settingsBridge` 四级探测（configForms→webUiSettings→settingsScope→无）+ 15×2s 晚到重试 + `mountSettingsSyncs` 就绪重挂；③ 无影响；④ CSV/TSV **决策：不让位**（可编辑性优先，同 avif 例外先例，注释+测试落码）；perf 恢复接 `unarchiveOfficial` 幂等清官方标志 + 面板行 `archived/pinned` 徽标（`registryFlags/markOfficialFlags`，缺服务/字段静默降级）；⑤ **已落** `package.json icon`（assets/icon.svg 669B）+ `locale/en.json`/`locale/zh.json`（files 已含 locale）+ 设置字段 `nativeOpenExts`（shared/nativeOpen.ts 单一事实源：文件树原生打开 + claim canOpen 同步让位，默认=让位清单并集）；⑥ 无自定义 config 字段 → patch 注释预留写法；⑦ `audit-dsh-compat.mjs --dump-config-schema` 子命令（flag 预检 + 拿不到优雅跳过）；⑧ 新增 `edrv.readBinary`（octet-stream + x-edrv-* 头）+ 任何失败自动回退 base64 路径，routes.ts 已接线；⑨ 图片缩放对齐官方统一缩放（适应宽度默认/±10%/页签记忆），PDF 补百分比指示 | **已适配（0.7.x / 0.1.7-alpha.1 批次）** · forms + configForms 双策略 |
| 高于已实测版本 | 未知 | 能力探测降级 + 报告警告「高于已实测版本 0.1.7-alpha.1」 | 例行适配（见第四节） |

### 加载关审计表（回答"运行时适配能否过加载关"）

| 关口 | rc.2（现网） | alpha.2（备份树实证） | 结论 |
|---|---|---|---|
| host 静态导入 | 对 `@deepseek-ai/*` 零静态导入 | 同 | 两版皆过 |
| host 服务级 inject（sessions/fs/webServer/loader/tools/workspaceRegistry/agents） | 提供者：dsh-session/dsh-fs/dsh-host-webserver/…/dsh-workspace | **同名同提供者** | 两版皆过 |
| client 模块加载 | `__ModuleLoader__.load`，源码零 `@deepseek-ai` require | 同 | 两版皆过 |
| client 服务级 inject（slots/timer/locale/connection/remote/workspaces/sessions/conversation；**设置桥服务全部移出 inject**——0.1.6 `settingsScope` / 0.1.7 `configForms` 桥名互斥，写死任一都会在另一版本停等 → `compat.settingsBridge` 探测 + 15×2s 有界重试 + whenReady 重挂同步） | slots←dsh-client-runtime | slots←dsh-client-ui-renderer；workspaces←dsh-api-workspace-controller；其余同名 | 两版皆过（0.1.7 复验：settingsScope 提供方包已删该服务） |
| `dsh.client.inject`（包名清单） | runtime/ui-slots | 已亡 id | 收敛为空 + rc.2 实证回滚门（`docs` 记录于 0.1.43 交付时复验） |

## 三、版本探测约定

- 以运行时解析的 `@deepseek-ai/dsh-settings` 版本代表 DSH 核心版本：核心包发布锁步同版
  （rc.2 / alpha.2 全树同版实证）；候选降级链 `dsh-settings → dsh-web-app → dsh-base → dsh`。
- 解析失败返回空串：报告「未探测到版本号」，功能按能力探测运行。
- 上界常量 `TESTED_DSH_MAX = '0.1.7-alpha.1'`（src/compat.ts）：超过则报告警告，驱动例行适配。

## 四、新 DSH 版本发布后的例行适配清单

1. 读 release notes（https://github.com/deepseek-ai/deepseek-harness/releases）中「其他变更/破坏性」条目；
2. `node scripts/audit-dsh-compat.mjs <旧树> <新树>`（新树可从 `_backup`/`npm pack` 取），看导出面/服务面差异；
3. 对照第二节矩阵逐行评估：命中「影响」列即新增/调整适配器（改 `runSettingsInstall` 分派或在
   `src/dshVersion.ts` 增判定），并补单测（tests/dshVersion.test.ts、tests/settingsAdaptive.test.ts）；
4. 更新本文档矩阵、`TESTED_DSH_MAX`，跑 `npx tsc --noEmit` + `npx vitest run` + `npm run pack`；
5. 用户侧重启后查看兼容性报告与日志（应显示 `DSH <版本> · <策略>`，无「设置 section 安装」警告）。

## 五、0.1.43 交付验证记录

- [x] typecheck / 新增单测 / 全量 vitest（402 通过；3 失败均为本机 VS Code 真实
      tangzx.emmylua 扩展干扰的环境前置问题，与本次改动无关）
- [x] audit 双树断言通过（rc.2 ↔ 0.1.2-alpha.2）
- [ ] rc.2 现网 E2E：swap-vscode-mode.ps1 → 重启 → 设置持久化 / 兼容报告（`0.1.1-rc.2 · legacy`）
- [ ] alpha 实测闭环（Web 自动更新拉取 alpha 时）：兼容报告应显示 `0.1.2-alpha.x · service`，
      设置持久化可用；若 client 装配异常请回报（ADAPT-002 决策点：dsh.client.inject 是否需要按版本区分）

## 六、回滚

改动前备份在 `plans/version-adapt/backup-<ts>/`；发布态回退 = 安装既有 `dsh-vscode-mode-0.1.42.tgz`。
`dsh.client.inject` 收敛若在 rc.2 出现 web boot pending/槽位缺失 → 恢复备份 package.json 原清单重建。
