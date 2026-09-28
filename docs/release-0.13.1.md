# dsh-vscode-mode 0.13.1 发布说明

> 发布准备记录，2026-09-28。基线为已发布的 `v0.13.0`（tag `75dd3d8`，该基线 CI 与
> GitHub Release 已确认通过）。本版是设置面收敛的补丁版本：移除插件自建的独立
> 「快捷键」设置页，把改键入口交给 DSH 官方弹窗。

## 本版变化

### 快捷键入口收敛到官方弹窗

- 移除独立「快捷键」设置区（`settings.section` id `vscode-mode-shortcuts`、
  `src/client/ui/ShortcutSettings.ts`），以及随之失去消费者的共享录制模块
  `src/client/shortcutRecorder.ts` 与其单测 —— 键位查看、录键、冲突校验与恢复默认
  全部由官方弹窗承担，避免同一套录键逻辑两处维护。
- VSCodeMode → 通用页新增「快捷键」面板：说明键位由官方机制统一管理，并提供
  「打开官方快捷键配置」按钮（`openOfficialShortcuts()` →
  `registry.invoke('shortcuts.open')`；官方入口缺失或唤起失败时就地给出手动打开方式，
  不抛错、不阻断设置渲染）。
- 清理仅被该页面使用的 `.vsm-kb-*` 样式与过时注释；`docs/commands.md`、README 同步。

### 不变的部分

- 键位数据、默认值与校验仍全部归官方：`shared/keybindings.ts` 的 profile 默认值、
  `shortcutsOfficial.ts` 的注册 / 迁移 / 弦表同步均未改动。
- 0.13.0 的修复保持不变：`normalized` 绑定与物理 Control/Meta 的转换、Web 工作区搜索
  使用平台允许的三修饰符组合、首开入口按会话 scope 路由。

## 影响面与兼容性

- 改动仅限 client 面 + 文档 + `package.json` 版本号；**host 面无改动**，无配置迁移，
  无依赖与 lockfile 变化。
- 设置区 id `vscode-mode-shortcuts` 消失：用户已保存的键位在官方存储里（Desktop
  `userData/keybindings.json`、Web `localStorage` 的 `dsh.keybindings.v1`），本版不改动
  它们，也不触发任何迁移或重置。
- 旧版 DSH 没有官方 shortcuts 服务时：通用页按钮给出「入口不可用 + 手动打开方式」
  说明，键位仍沿用原有窗口按键派发与旧 `keybindings` 设置。

## 回滚到 0.13.0

按原 profile 的官方插件管理方式安装 `v0.13.0`（tag `75dd3d8`）产物，随后重启 Host、
刷新原应用。本版未改动任何持久化格式，回滚不需要数据修复；恢复被移除的设置页需要
回到该 tag 的源码。

## 发布验证记录（2026-09-28）

| 检查 | 实际结果 |
|---|---|
| 版本与基线 | 包 `0.13.1`；基线 `v0.13.0` @ `75dd3d8`（CI 与 Release 已通过） |
| 类型检查 | `tsc -p tsconfig.json --noEmit` → exit 0 |
| 全量 JS/TS 测试 | `vitest run` → **175 文件通过 + 2 跳过（177）；2326 通过 + 12 跳过（2338）**，连续两次一致 |
| 定向验证 | `tests/shortcutsOfficial.test.ts` 新增 3 例：唤起成功返回空串并带 page 上下文 / 服务与 registry 缺失给出手动方式 / invoke 抛错不外抛 |
| 原生测试 | `node --test tests/nativeOpen.test.mjs` → 9 / 9 |
| 构建 | Host `lib/index.js` 726.52 kB；client `lib/client.js` 1.47 MB（tsdown 双面） |
| 用例差 | 随录制模块移除 `tests/shortcutRecorder.test.ts`，相对 0.13.0 净减 16 例 |
| 官方 Desktop 现场 | **未**做 GUI 冒烟（本会话无 chrome-devtools MCP）：按钮的实际唤起效果需要在应用内点击确认 |
| Linux / macOS | **未**现场验证（本版无平台分支改动） |

发布走仓库既有 tag → GitHub Actions 流程（验证 tag 版本 → 三门 → npm pack → GitHub
Release 挂 tgz），不在本地直接 `npm publish`。本文件记录发布准备与验收边界，不授权
额外部署、OS 注册或外部消息操作。
