# Release 0.15.9 — 插件自我更新与可用更新提醒

> 日期：2026-10-16 · 作者：ddj · 基线：v0.15.8 @ `800eb32`

## 背景

此前插件升级需要用户手动到 DSH 官方插件管理页操作（或命令行重装）。本版在插件
设置页内置更新入口，并增加可用更新的主动提醒，闭环「发现新版本 → 一键更新」。

## 改动

| 文件 | 改动 |
|---|---|
| `src/selfUpdate.ts`（新增） | `compareVersion()` 版本比较纯函数（数值段比较、v 前缀剥离、预发布低于同号正式版）；`latestVersionOf()` 经 `subprocess.spawn` 在 profile 目录跑 `pnpm view dsh-vscode-mode version --json`（runner 取 `profileContext.packageManager`）；`checkUpdate()` 返回 `{ ok, current, latest, hasUpdate }`；`startSelfUpdate()` 防重入 + pluginManager 守卫 + setTimeout 1s 后 `removeBundle → installBundle`（编排脱离本插件生命周期，避免 remove 后 RPC 通道被 dispose） |
| `src/shared/rpc.ts` | 请求表新增 `vscode.updateCheck` / `vscode.updateSelf`；响应类型 `updateCheck { ok, current?, latest?, hasUpdate?, error? }`、`updateSelf { ok, started?, error? }` |
| `src/rpc.ts` | 两个 handler（devFormSet 之后，try/catch 风格） |
| `src/client/ui/McpSettings.ts` | 「文件与安装」面板新增插件更新行：当前版本 + 「检查更新」按钮 + 发现新版时「更新到 vX.Y.Z」按钮（confirm 风险说明：先卸载再安装、页面短暂断开、失败可在官方插件管理页重装）；devForm 开发形态启用时禁用 |
| `src/client/updateNotice.ts`（新增） | 启动 30s + 0~30s 抖动后探测更新；`hasUpdate` 且 `localStorage['vsm-update-notice']` ≠ 最新版号时 toast 提醒（每个版本只提醒一次）；失败与 devForm 开发形态静默 |
| `src/client/index.ts` | `installPageReload` 之后装配 `installUpdateNotice` |
| `tests/selfUpdate.test.ts`（新增） | `compareVersion` 单测 6 用例（相等/主版本/次版本/补零/v 前缀+预发布/非法输入） |

## 验证

- `pnpm build`：host + client 双 ✔ 0 error
- `vitest run tests/selfUpdate.test.ts`：6/6 通过（1.6s）

## 已知缺口

- 自我更新端到端链路（removeBundle → installBundle → 新版生效）需要先发布本版、
  之后有更新版本时才能实测；本次仅验证检查更新与 UI 链路。
- `installBundle` 失败时官方 PluginManager 会自动恢复 profile 的
  package.json / pnpm-lock.yaml，但恢复后本插件处于未安装态，需在官方插件
  管理页重装。
