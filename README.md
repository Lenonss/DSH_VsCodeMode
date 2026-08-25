# dsh-vscode-mode

> 原 `@dsh-external/dsh-edit-review`（编辑差异审查）重构而来——DSH 上的**类 VSCode 编码体验**。

仿 VSCode 的 **Agent 文件编辑器 + 差异审查** DSH 插件：

- **侧边栏「文件编辑」Tab**（v0.1.23，推荐）：检测到 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)
  （`ctx.betterSidebar` 服务）时，编辑器注册为右侧栏 Tab——**AI 对话（中央）与文件编辑（右侧栏）同屏**，
  类主流 Code Agent 布局；Tab 可拖到下方成底部面板（全宽）、支持分栏；文件打开/差异跳转自动展开面板。
  **可选依赖**：未安装 dsh-better-sidebar 时自动回退旧「中央文件编辑页签」形态（插件零新依赖仍完整可用），
  并在编辑器顶部与设置页「兼容性」子 Tab 引导安装（`dsh plugin --profile web add dsh-better-sidebar`）。
  文件页签（脏点/关闭/「+」打开）+ `Ctrl+P` 快速打开（QuickOpen）+ **Monaco Editor**
  （语法高亮/行号/`Ctrl+F`/`Ctrl+G`/`Ctrl+S`/700ms 防抖自动保存）+ 顶部工具栏（路径/语言/Ln,Col/保存状态/差异/侧边栏/刷新）。
- **差异审查**：Host 捕获 agent 的 `edit`/`write`（`tools/result`），客户端统一使用**唯一一个挂在 DSH `conversation.input.dock` 的 DiffBox 实例**：
  编辑器未打开时显示紧凑「差异 N 个文件 · 查看下一个」按钮（点击自动打开侧栏编辑器并聚焦差异）；编辑器打开后 dock 切换为
  完整操作条（Keep / Undo / 跳转 / 回滚 / 归档对比），不会再出现第二个差异栏。header 差异角标 +
  DiffLauncher 全局总览 + 归档/批次回滚；状态持久化到工作区旁车（`.dsh-edit-review.json`，重启不丢）。
- **Monaco 离线分发**：`assets/vendor/monaco` AMD 构建随包发布，经 `/edrv/vendor/*` 前缀路由提供，全离线可用。
- **文件管理侧边栏**（类 VSCode 活动栏 + 面板）：编辑器内嵌活动栏 + 可拖拽调宽的面板区；首期「资源管理器」= 懒加载目录树
  （展开目录实时读取、点文件在编辑器打开、差异角标、活动文件高亮、`edrv:refresh`/手动 ⟳ 刷新、`Ctrl+B` 显隐并持久化；
  侧栏形态默认收起以节省面板宽度）。面板通过注册表装配（`ctx.provide('edrvSidebarPanels')`），新增面板只加一条注册，不改编辑器布局。
- **MCP 可视化管理**（设置 → VSCodeMode）：子 Tab「我的 MCP」（profile 全局）+「项目 MCP」（各项目根 `.mcp.json`）。
  项目级 MCP 对齐 Claude Code/Cursor：配置存于项目根目录 `.mcp.json`（`mcpServers`），随仓库共享；
  可查看各项目连接状态/工具、添加（stdio / streamable-http）、刷新、启用/禁用、删除。工具全局生效。

## 界面截图

![侧边栏编辑形态：AI 对话与文件编辑同屏](docs/screenshots/img1.png)

> dsh-vscode-mode 侧边栏编辑形态：betterSidebar 右侧栏内的 Monaco 文件编辑器与中央 AI 对话同屏，
> 差异条统一挂在对话输入框上方的原生 dock（编辑器未打开=「差异 N 个文件 · 查看下一个」，
> 打开后=完整 Keep / Undo 操作条）。

![文件编辑与差异审查界面](docs/screenshots/img2.png)

![文件编辑与差异审查界面](docs/screenshots/img3.png)

## 安装（官方 `dsh plugin` 方式，三选一）

```bash
# ① Git 安装（clone + prepare 构建；推荐打固定 tag）
dsh plugin --profile web add github:Lenonss/DSH_VsCodeMode#v0.1.23

# ② npm 注册表（发布到 npm 后）
dsh plugin --profile web add dsh-vscode-mode

# ③ GitHub Release tgz 直装
dsh plugin --profile web add https://github.com/Lenonss/DSH_VsCodeMode/releases/download/v0.1.23/dsh-vscode-mode-0.1.23.tgz
```

> `dsh plugin ...` 是 pnpm 转发器：git 安装会克隆仓库、执行该包 `prepare` 脚本（tsdown 双面构建）后安装，
> 再按 `dsh.bundle` 声明自动加入 profile 的 bundles 层。若 pnpm 提示构建脚本需批准，按提示把 key
> 加到 `~/.dsh/profiles/<profile>/pnpm-workspace.yaml` 的 `allowBuilds` 后重跑。

**安装即生效，无需任何手动配置**：本包自带的 `cordis.patch.yml` 是标准 bundle 自挂载补丁
（`- insert: { id: dsh-vscode-mode, name: dsh-vscode-mode }`），加入 bundles 层后重启
DSH 即自动把插件行挂进 loader 树，**不要**再往 profile 用户层 `cordis.patch.yml` 手写
`insert`（旧的非标准做法，会与本 bundle 行撞同一 id，触发 duplicate loader entry id 启动失败）。

自定义配置（如图标目录 `imageDir`）用 **id 定向覆盖**合并到 bundle 行上，而不是再 insert 一次：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml（用户层，应用顺序在 bundle 层之后）
- id: dsh-vscode-mode
  config:
    imageDir: C:/Users/me/Pictures   # 可选，默认读插件包内 assets/
```

> 迁移提示：若你之前按旧版指引在 profile 用户层手写过 `insert`（id 恰为 `dsh-vscode-mode`），
> 升级后请把那一段 `insert` 改成上面的 id 定向覆盖（或直接删除），避免与本 bundle 行重复装配。

更新：`dsh plugin --profile web update dsh-vscode-mode`；卸载：`dsh plugin --profile web remove dsh-vscode-mode`。

## 开发构建（自足，无需 DSH 源码 checkout）

```bash
pnpm install          # 安装 devDeps（typescript/tsdown/@types/node/@types/react/react/vitest）
pnpm build            # tsdown 双面：lib/index.js（host esm）+ lib/client.js（client cjs）
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest 纯函数用例
npm pack              # 产物 tgz（含 lib/assets/src/cordis.patch.yml）
```

`scripts/build.sh` 已被 `dev_build_plugin` 等注入工具调用（本地标准构建）。
`prepare` 脚本 = 构建，git 安装 / npm publish 都会自动执行。

## CI（GitHub Actions）

- `.github/workflows/ci.yml`：push/PR → install → typecheck → test → build → `npm pack` 校验 + 上传 tgz。
- `.github/workflows/release.yml`：打 `v*` tag → 同上构建 → GitHub Release（附 tgz）→
  **若配置了 `NPM_TOKEN` secret** 则同时 `npm publish`（npm 通道）。
  未配 NPM_TOKEN 时仅 GitHub Release 通道，不影响安装。

## 源码结构

```
src/
├── index.ts            Host 入口：name/inject/apply（薄装配，含兼容性报告启动日志）
├── shared/             ★ 双面契约（禁 node/react）：types.ts（记录/归档/摘要）+ rpc.ts（11 个方法类型化）
│                       + compat.ts（兼容性报告形状）+ mcp.ts（MCP 契约）
├── compat.ts           ★ Host 兼容层：身份常量、外部插件探测、路由/重复装配护栏、依赖守卫、兼容性报告
├── devForm.ts          Host 开发形态管理：link:/junction 安装切换（RPC vscode.devForm* + 设置页开关）
├── model.ts            Host 纯域逻辑（可单测）：normalize/markDecision/resolved/summary/reconstruct/批次/归档
├── store.ts            Host 存储层：sidecar 读写合并 + 归档持久化 + stale 检测
├── workspace.ts        Host 工作区文件扫描（TTL 缓存）+ 快速打开搜索
├── revert.ts           Host 回滚/删除（fs + subprocess，fs.contains 边界校验）
├── registry.ts         Host 每工作区记录桶注册表
├── tree.ts             Host 目录树纯函数（normalizeRel/toTreeEntries，edrv.listDir 用，可单测）
├── rpc.ts              Host RPC 分发表（类型化 handler 表替代巨型 switch，含 compat）
├── routes.ts           Host webServer 路由（/edrv/rpc、/edrv/assets/*、/edrv/vendor/*，带冲突护栏）
└── client/
    ├── index.ts        Client 入口：slot 注册（inject=['slots','timer']）；betterSidebar 探测分流（侧栏 Tab / 旧页签回退）
    ├── compat.ts       ★ Client 兼容层：设置桥三级降级（webUiSettings→settingsScope）、slot 安全注册、openPath 链式补丁、外部插件常量
    ├── sidebarBridge.ts ★ 侧边栏编辑区桥：可选探测 ctx.betterSidebar、注册「文件编辑」Tab、打开路由/角标计数（纯函数可单测）
    ├── rpc.ts          Client 类型化 fetch 包装 + 诊断日志
    ├── events.ts       窗口事件助手（edrv:refresh/open-editor/show-launcher；侧栏路由优先、旧页签回退）
    ├── state/          records.ts（摘要/计数/空差异）+ regions.ts（差异区域/行裁剪）纯函数
    ├── monaco/         loader.ts（AMD 加载/语言映射）+ diffRender.ts（差异自绘渲染器）
    ├── diffDock.ts     差异 dock 轮转/文案/形态纯函数（对话 dock 与 DiffBox 共用）
    ├── sidebar/        ★ 侧边栏面板系统：registry.ts（注册表，镜像 fileOpeners）+ SidebarView.ts（活动栏/面板区/拖拽调宽）
    │                   + types.ts（SidebarPanelDef/SidebarCtx）+ panels/FileExplorer.ts（文件树面板 #1）
    ├── styles/editor.css  编辑区样式（tsdown CSS-inline 注入；含侧栏形态/引导条）
    └── ui/             EditorView（编排，tab/side 双形态）/ SideEditorTab（betterSidebar Tab 包装）/ QuickOpen
                        / DiffBox（chat/editor 双模式）/ ConversationDiffDock / DiffBarEmpty / DiffLauncher
                        / DiffBadge / McpSettings（含「兼容性」子 Tab）
```

**兼容层（`src/compat.ts` + `src/client/compat.ts`）**：集中处理与其他插件 / DSH 版本的适配——
运行时探测 `@deepseek-ai/dsh-mcp-client`、设置桥（`webUiSettings` → `settingsScope`）等外部依赖，
护栏检测 `/edrv` 路由前缀冲突与本插件重复装配（duplicate loader entry），
`@deepseek-ai/dsh-settings` / `schemastery` 以动态加载引入（缺失时插件仍可加载，设置持久化降级）。
「VSCodeMode」设置页 →「兼容性」子 Tab 或 RPC `edrv.compat` 可查看完整报告。

**开发形态（`src/devForm.ts`）**：开发 = profile 中以 `link:` 依赖 + junction 指向工作区的安装。
「VSCodeMode」设置页 → 通用 里在开发形态开启时显示「关闭开发形态」开关（切回正式版安装，重启生效）；
AI 后续开发时可通过 RPC 自动开启/关闭：

```bash
# 读取当前形态（compat 报告亦含 devForm 字段）
curl -s -X POST http://127.0.0.1:3080/edrv/rpc -H 'content-type: application/json' \
  -d '{"method":"vscode.devFormGet","args":{}}'
# 开启开发形态（link 到工作区；path 必填，重启后生效）
curl -s -X POST http://127.0.0.1:3080/edrv/rpc -H 'content-type: application/json' \
  -d '{"method":"vscode.devFormSet","args":{"enabled":true,"path":"D:/Work/ToolsDev/DeepSeekHarnessPlugin/packages/dsh-edit-review"}}'
# 关闭开发形态（改回 ^<version> + 删 junction + pnpm install，重启后生效）
curl -s -X POST http://127.0.0.1:3080/edrv/rpc -H 'content-type: application/json' \
  -d '{"method":"vscode.devFormSet","args":{"enabled":false}}'
```

**扩展缝（VSCode 化后续迭代）**：新能力 = `shared/rpc.ts` 加方法 + `src/rpc.ts` 加 handler +
`client/` 加组件，其余模块零改动；`monaco/*` 是可复用的编辑器服务（资源树/对比/诊断面板共用）；
侧边栏面板系统（`edrvSidebarPanels` 注册表）可承载后续面板（搜索/差异/时间线），`edrv.listDir` 为通用目录树 API。

## 架构要点

- **捕获**：Host 监听 `tools/result`，对 `edit`/`write` 取 `result.value` + `result.meta.diffs` 落记录。
- **持久化**：工作区旁车 `.dsh-edit-review.json`（version 2，按 cwd 分桶，写前合并，v1 自动迁移）；
  归档 `.dsh-edit-review-archive.json`（按 path+batch 合并批次，含每 hunk 决策与 before）。
- **RPC**：静态包经 webServer 精确路由 `/edrv/rpc`，Client 同源 fetch；载荷形状由 `shared/rpc` 类型化。
- **批次/融合/归档**：每次新 edit/write 递增文件 batch，早于最新批次的未归档差异自动"融合"归档；
  每条差异处理完成（采纳/拒绝/被覆盖）立即单条归档；DiffLauncher「归档」页按批次浏览 + 回滚。
- **Client 挂点**：betterSidebar Tab `edrv-editor`（侧栏形态，未装 dsh-better-sidebar 时回退 `conversation.view` 页签
  id `edrv-editor`）+ `conversation.session.header.utilities`（id `edrv-diff-badge`）+ `conversation.input.dock`
  （id `edrv-diff-dock`，唯一差异栏：编辑器未打开=紧凑按钮，打开后=完整操作条）。内部路由/slot/事件/CSS 前缀沿用 `edrv-*`（防回归），包身份为 `dsh-vscode-mode`。
- **⚠️ Host 改动需重启 DSH 应用**（Node ESM 模块缓存）；Client 经 `dsh-client-hmr` 热重载。

## 开发 / 卸载（超级模组注入器，开发期可选）

- 热装配：`dev_install_package {dir: packages/dsh-edit-review}`；更新：`dev_reload_package {packageName: "dsh-vscode-mode"}`
- 卸载：`dev_uninject_plugin {match: "dsh-vscode-mode"}`（生产环境用 `dsh plugin remove`）
