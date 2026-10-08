# dsh-vscode-mode 0.14.4 发布说明

> 2026-10-08；基线 v0.14.3。Desktop DSH rc.2 精确兼容、MCP 状态与配置管理修复、空差异栏隐藏。未增加 npm 依赖或新的数据迁移。

## 改动

- 六个 DSH peer 保留已有 0.1.x 和 `=0.2.0-rc.1` 范围，追加 `=0.2.0-rc.2`；版本线报告单列 rc.2。仍拒绝未经适配的 rc.3、0.2.0 正式版等版本，开发期旧 DSH 依赖没有统一升级。
- MCP 配置启用与连接健康分开显示：`ACTIVE`、实例数和工具数不单独作为在线证据；`configured` / `unverified` 使用中性色，只有明确连接证据显示在线。零工具服务合法，可以只提供资源。
- MCP 状态轮询使用只读 `mcp.snapshot`，不重复触发配置读盘与 reconcile；初次加载等待全部请求结束，避免半失败造成重叠轮询。表单与异步状态收尾覆盖失败/刷新路径，模块加载失败后允许重试。
- 全局与项目配置修改串行执行，避免并发读取—修改—写入丢服务；缺少项目 `.mcp.json` 同时识别 Node `ENOENT` 与官方 `FS_NOT_FOUND`。权限、IO、JSON 错误仍报告，不能把读取失败当空配置或清掉最后有效连接。
- 官方工具名 `mcp__${serverName}__${rawName}` 可能产生歧义：跨全局/项目双向拒绝 `__` 命名空间交叠，历史歧义工具安全隐藏，不凭最长前缀猜归属。保留项目 agent 的工具、资源与指令隔离。
- 编辑器底部差异操作条在当前及其他文件均无待处理差异时隐藏，两种布局一致；有其他文件差异、可定位区域、汇总尚未更新的差异或过时冲突时保留入口。最后一项决策后隐藏，新差异出现后恢复，不影响命令栏。

## 验证证据与边界

- 本地 TypeScript 检查退出码 0；Host/Client 构建通过。构建仍有既有 tsdown 弃用/CJS 提示及 Rolldown `INVALID_ANNOTATION` 告警，本次未扩大范围修改它们。
- 发布 JS 测试套件：Vitest **188 个文件通过、2 个文件跳过；2527 通过、14 跳过，15.59s**。跳过项为环境/可选集成测试，不据此主张全部端到端覆盖。
- 原生外部打开测试 `node --test tests/nativeOpen.test.mjs`：**9/9 通过，11.41s**。
- 另在实际打包 Desktop 宿主模块下运行 `tests/mcpOfficial.test.ts`，设置 `DSH_MCP_HOST_ROOT` 并使用 Electron Node 模式：**3/3 通过，1.47s**，覆盖官方连接、继承工具、资源和指令隔离。这是隔离的模块集成测试，未连接用户的外部 MCP 服务。
- rc.2 的实际安装树接口审计与桌面安装证据见 [版本适配记录第 9 节](version-adaptation.md#9-0144-对-desktop-dsh-020-rc2-的精确放行2026-10-08)。此前桌面安装候选包后用户已重启并反馈正常；该反馈不等于本次最终合并包的逐功能验收。
- 空差异栏已通过独立客户端构建部署至本机 desktop 安装目录；没有当前页面 DOM/浏览器验收证据。最终合并包的 MCP 设置页浏览器冒烟、Linux/macOS 现场验收和真实 Unity EditMode **未完成**，不能以类型检查或纯逻辑测试代替。

## 升级与回退

确认对应产物已可用后，从固定 `v0.14.4` Git tag、GitHub Release tgz 或 `dsh-vscode-mode@0.14.4` 安装到实际目标 profile。Desktop 应使用该版本的 Desktop 插件安装入口，不把 Web 示例或旧的 `.dsh-desktop` 路径套到当前实例。

本版同时修改 Host 与 Client：**升级后重启目标 DSH Host，再对原页面强制刷新**。只刷新页面不能加载新 Host，CSS 热重载也不能替代整页刷新。此次公开发布不自动替换用户现有本地 tgz 安装、不修改 profile 或重启进程。

升级前备份 profile 安装信息及项目 `.mcp.json`；历史交叠命名如需重新启用，应先检查并重命名配置，不能绕过归属检查。本版未迁移 MCP 配置或 SQLite schema。从 0.14.2 或更旧版本升级，以及回退到这些旧版本时，仍须遵循 [0.14.3 数据迁移与回退要求](release-0.14.3.md)，不要删除新库或用旧 JSON 覆盖当前数据。回退到 0.14.3 会重新引入本次修复的问题，且其 peer 范围不接受 Desktop DSH rc.2；不得用风险豁免把旧版强行安装到 rc.2。

本发布仅通过 Git tag 触发 `.github/workflows/release.yml` 生成 Release 和 npm 发布；本机不执行 `npm publish`。实际发布状态以 GitHub Actions、Release asset 和 npm 注册表读回结果为准。
