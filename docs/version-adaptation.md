# DSH 版本适配机制（dsh-vscode-mode）

> 机制目的：DSH 以 alpha/rc 高频发布（0.1.2-alpha.x 起几乎每日一发且 Web 端自动更新拉取），
> 插件需在"影响性版本线"上自动切换 API 策略，失败一律安全降级并把状态写进
> 「设置 → VSCodeMode → 兼容性」报告与启动日志，而不是等用户回滚 DSH。
> 作者 ddj 2026-09-02 · 随 0.1.43 落地

## 一、机制骨架

```
src/dshVersion.ts            版本探测 + semver 比较/区间（createRequire 解析
                             @deepseek-ai/dsh-settings/package.json，候选降级）
src/fileOpenSettings.ts      runSettingsInstall：三策略分派（见下），模块级观测
                             状态 settingsInstallStrategy()/settingsInstallNote()
src/compat.ts                buildReport：报告并入 dshVersion + 版本适配行 +
                             高于实测版本 / 安装不可用 警告
src/client/ui/McpSettings.ts 兼容性页签新增「版本适配」分组与 DSH 版本标题
scripts/audit-dsh-compat.mjs 双树导出面/服务面例行比对（新 alpha 发布后跑）
docs/version-adaptation.md   本文档（版本线 × 影响 × 适配器矩阵）
```

### 设置 section 安装三策略（runSettingsInstall）

| 策略 | 触发条件 | 行为 |
|---|---|---|
| `legacy` | 动态导入的 `@deepseek-ai/dsh-settings` 仍导出 `installSettingsSection` | 原样调用 free function（rc 线，行为与 0.1.42 一致） |
| `service` | 导出已移除（0.1.2-alpha 起）→ `ctx.inject(['settings'])` 后探测 `provider.installSection` | 调用服务方法 `installSection(ctx, ns, schema, entry, hooks)`（等义封装：base 层 + fiber 卸载回退） |
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
| 高于已实测版本 | 未知 | 能力探测降级 + 报告警告「高于已实测版本 0.1.2-alpha.4」 | 例行适配（见第四节） |

### 加载关审计表（回答"运行时适配能否过加载关"）

| 关口 | rc.2（现网） | alpha.2（备份树实证） | 结论 |
|---|---|---|---|
| host 静态导入 | 对 `@deepseek-ai/*` 零静态导入 | 同 | 两版皆过 |
| host 服务级 inject（sessions/fs/webServer/loader/tools/workspaceRegistry/agents） | 提供者：dsh-session/dsh-fs/dsh-host-webserver/…/dsh-workspace | **同名同提供者** | 两版皆过 |
| client 模块加载 | `__ModuleLoader__.load`，源码零 `@deepseek-ai` require | 同 | 两版皆过 |
| client 服务级 inject（slots/timer/locale/connection/remote/workspaces/sessions/conversation/settingsScope） | slots←dsh-client-runtime | slots←dsh-client-ui-renderer；workspaces←dsh-api-workspace-controller；其余同名 | 两版皆过 |
| `dsh.client.inject`（包名清单） | runtime/ui-slots | 已亡 id | 收敛为空 + rc.2 实证回滚门（`docs` 记录于 0.1.43 交付时复验） |

## 三、版本探测约定

- 以运行时解析的 `@deepseek-ai/dsh-settings` 版本代表 DSH 核心版本：核心包发布锁步同版
  （rc.2 / alpha.2 全树同版实证）；候选降级链 `dsh-settings → dsh-web-app → dsh-base → dsh`。
- 解析失败返回空串：报告「未探测到版本号」，功能按能力探测运行。
- 上界常量 `TESTED_DSH_MAX = '0.1.2-alpha.4'`（src/compat.ts）：超过则报告警告，驱动例行适配。

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
