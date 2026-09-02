# v0.1.43 发布说明

## 新增：DSH 版本适配机制（针对 0.1.2-alpha 系列等影响性版本）

背景：DSH 自 0.1.2-alpha.1（2026-08-28）起高频发布 alpha，其中 alpha.2 从
`@deepseek-ai/dsh-settings` 移除了 `installSettingsSection` / `settingsNamespace` 导出，
曾导致本插件（及 dshmarket、dsh-better-sidebar）在 alpha 上设置 section 注册崩溃。

- 运行时探测 DSH 核心版本（`src/dshVersion.ts`：解析 `@deepseek-ai/dsh-settings`
  版本代表核心版本，多候选降级；含 semver 比较/区间纯函数）
- 设置 section 安装三策略自适应（`runSettingsInstall`）：
  - `legacy`：rc 线（≤0.1.1-rc.2）仍走 dsh-settings free function，行为与 0.1.42 一致
  - `service`：0.1.2-alpha 起自动改走 `ctx.settings.installSection(…)` 服务方法
  - `none`：两路皆不可用 → 设置按配置值降级并告警；全程 try/catch，消灭 unhandled rejection
- 兼容性报告与启动日志新增「DSH 版本 / 版本适配」行（设置 → VSCodeMode → 兼容性），
  超过已实测版本（0.1.2-alpha.4）自动提示
- client 装配面收敛：移除已消亡包的 `dsh.client.inject` 引用（加载关审计见
  `docs/version-adaptation.md`；rc.2 实证 + 回滚门）
- 例行工具：`scripts/audit-dsh-compat.mjs` 双树导出面/服务面比对 + 适配矩阵文档
  `docs/version-adaptation.md`

## 测试
- 新增 tests/dshVersion.test.ts（解析/比较/区间/版本线）、tests/settingsAdaptive.test.ts（三策略分支）
- 全量 vitest 402 通过（3 失败为本机 VS Code 真实 EmmyLua 扩展干扰的环境前置问题）

## 已知
- 0.1.2-alpha 线终验需在 alpha 运行环境进行（Web 自动更新拉取后对照文档清单确认）。
