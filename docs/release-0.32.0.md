# 0.32.0 — DSH 0.2.3 兼容修复与官方审阅 / MCP 框架接入

日期：2026-11-23　基线：`@deepseek-ai/dsh@0.2.3-alpha.2`（`cordis` 4.2.0-alpha.1）

## 背景

升级到 0.2.3-alpha.2 后，插件在 Web profile 上整体不可用：`/edrv/rpc`、`/edrv/vendor/*`
返回 503，响应体是插件自己写的 `Host authentication service unavailable`。

排查结论（均为运行中 host 的实测，不只是 release notes）：

- 0.2.3 移除了 `connection.requestRejection`（安装树内命中 0 个文件）。
- 路由授权改由框架执行：`WebRoute.auth` 缺省 `required`，`dsh-client-connection` 监听
  `webserver/authorize`，用 cookie 鉴权；同源子资源请求同样带 cookie。
- 因此插件的自建闸门把**所有**请求判成 503，而不是只在缺少鉴权能力时拒绝。

同时发现两处静默失效与两处可接入的官方扩展面（详见
`docs/version-adaptation.md` §12）。

## 改动

| 文件 | 改动 |
| --- | --- |
| `src/httpGuard.ts` | `admitRoute` 只做方法校验；旧版宿主有 `requestRejection` 时沿用原闸门。新增 `routeAuthMode()` 供自检 |
| `src/routes.ts` | 路由注册显式 `auth: 'required'`，由框架授权后才进 handler |
| `src/dshVersion.ts` | 新增 `detectVersionLive()` / `versionSourceOf()`：优先 `getDshRuntimeVersion()`，失败回落包版本嗅探；`familyLabel` 增 0.2.2 / 0.2.3 线 |
| `src/compat.ts` | 兼容报告新增「版本来源」与「路由授权归属」两行；`buildReport` 改用 `detectVersionLive()` |
| `src/client/filesCssCompat.ts` | 目标样式表改 `data-plugin` + `data-path`（旧 `data-plugin-css` 保留回落）；规则改挂 `[data-files-navigator-row]`；新增 `navSelectorOf()` 与按哈希正则重定向 |
| `src/client/openPathRouter.ts` | 新增 `resolveOpenPathOwner()`；探测不到宿主就不安装（不再新建死属性） |
| `src/client/compat.ts` | `patchAccessor` 沿原型链找描述符，并在实例上装自有属性覆盖；新增 `memberDescriptor()` |
| `src/client/remoteOpenRouter.ts` | `openWorkspacePath` 补丁支持原型链上的方法形态 |
| `src/client/officialReview.ts`（新） | 官方变更视图扩展位：工具条 + 文件菜单两条动作 |
| `src/mcpManagerBridge.ts`（新） | 官方 `ctx.mcpManager` 端口、条目/视图映射、OAuth 凭据键派生、无服务时安全空转 |
| `src/mcp.ts` | `listMcp` 合并 manager 托管服务器（只读；`managed` / `managerState` / `phase`） |
| `src/rpc.ts`、`src/shared/rpc.ts` | 新增 `mcp.manager.views/restart/probe/authorize/cancel/signout` |
| `src/shared/mcp.ts` | `MpcConfig` 增 `toolLoading` / `oauth`；`MpcServer` 增 `managerState` / `managed` / `phase` |
| `src/client/mcpForm.ts`、`src/client/ui/McpSettings.ts` | 表单新增「工具加载（DSH 0.2.3+）」开关（eager / on-demand） |
| `src/client/localeClient.ts` | 新增审阅动作文案词条 |
| `src/client/index.ts` | 接线：审阅扩展位安装、openPath 宿主探测 |

## 验证

- `pnpm typecheck`：0 error。
- 目标测试 9 个文件：135 passed / 6 skipped。
  `routes` 24、`compat` 22、`dshVersion` 16、`officialReview` 9、`mcpManagerBridge` 12、
  `filesCssCompat` 10、`remoteOpenRouter` 14、`client-compat` 28；`mcpOfficial` 6 skipped（既有跳过）。
- `pnpm build`：host 与 4 个 client chunk 均产出成功。

## 验收（需 DSH 重启后执行）

运行中的 host 仍持有旧模块，重启后新产物才生效：

1. `POST /edrv/rpc {"method":"compat","args":{}}` → **200**；`/edrv/vendor/monaco/monaco.js` → 200。
2. 兼容报告显示 `0.2.3-alpha.2`，并有「版本来源：运行时 getDshRuntimeVersion」一行。
3. 对话里点文件链接 → 在插件编辑器打开。
4. 官方变更视图（GitHub/GitLab PR/MR 页面）工具条出现「在 VSCodeMode 打开」。
5. MCP 面板显示官方 manager 托管服务器；授权/登出/重启按钮来自官方通道；「工具加载」开关可保存。

## 未完成 / 下一批

- 项目级 `.mcp.json` 仍未改由 `ctx.mcpManager.register()` 托管：插件自有 `mcpRuntime`
  提供逐 agent 作用域、共享池与启动策略，manager 没有对等物，硬切会丢隔离语义。
  下一批先设计「agent 作用域 ↔ manager 注册」的映射。
- 审阅行注解（`registerAnnotations` + `forge.diff.line.annotation`）与
  `forge.review.conversation` 未接。
- 客户端产物仍用旧样式注入格式（`data-plugin-css`），未切 `meta.stylesheets`。
