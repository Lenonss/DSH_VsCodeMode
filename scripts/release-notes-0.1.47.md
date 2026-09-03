# v0.1.47 发布说明

## 新增：C# 语言服务器（DotRush 全链路）+ 环境自动配置

背景：此前编辑器仅 Lua 有语言服务器。C# 通过市场安装 DotRush 扩展后经历三层问题：
**发现不到**（自动发现只认 ms-dotnettools.csharp）、**初始化挂起**（服务器阻塞等待配置通知，
工作区永不加载，UI 却显示就绪）、**运行时缺失**（DotRush 需 .NET 10，常见机器最高 9）。
本次三层全解：打开 `.cs` 文件即自动就绪，缺环境时设置页可见、可一键安装。

### 自动发现（host）

- `nromanov.dotrush-*` 多版本并存取清单版本最高者；启动参数对齐官方扩展：
  `dotnet <ext>/extension/bin/LanguageServer/DotRush.dll`（stdio）
- 所需运行时大版本从服务器 `*.runtimeconfig.json` 解析（不硬编码），
  `dotnetWithRuntime(minMajor)` 按大版本挑选可用 dotnet
- SDK 环境注入：`DOTNET_ROOT` / `DOTNET_MSBUILD_SDK_RESOLVER_CLI_DIR` / `DOTNET_SDK_PATH`
  （runtime-only 的 dotnet 会让 MSBuild 求值与 restore 退化）

### 初始化门控修复（关键）

DotRush 服务器 `OnInitializeAsync` 阻塞等待带 `dotrush` 段的
`workspace/didChangeConfiguration`，缺失则工作区永不加载——definition / references /
hover / documentSymbol 全部返回空，而 initialize 已完成、能力全量广播，UI 照样显示就绪。
现 csharp 服务器初始化完成后统一发送该通知（其它 C# 服务器按协议忽略，安全）。

### 环境自动配置 + 通用机制

- `dotnetProvision`：缺运行时时后台下载官方 runtime（releases.json 解析地址 → sha512
  校验 → 解压到用户级目录 `%LOCALAPPDATA%\Microsoft\dotnet` / `~/.dotnet`），
  静默自动、失败 10 分钟退避；状态机（downloading/extracting/done/failed）供 UI 轮询
- `envRequirements` 检测/安装注册表：按语言注册检测器、按需求 id 注册安装器，
  新 LSP 接入环境提示只需各加一条；`status`/`redetect`/`configUpdate` 携带 `missingEnv`
- 设置页 C# 卡片：缺失时展示提示区域，每项 [一键安装]（下载中…/安装中… 实时变化）
  + [官网下载] 链接；完成后自动刷新状态并重同步编辑器——零手动步骤

### 兼容性

- Lua 链路零变化：配置通知按 `languageId === 'csharp'` 发送，检测器 lua 恒空
- 新增 RPC：`edrv.lsp.envInstall` / `edrv.lsp.envState`；
  `LspServerStatus` 新增可选 `missingEnv`（旧客户端忽略）
- 测试隔离钩子：`DSH_LSP_EXT_DIRS` 覆盖扩展扫描列表（修复 3 个因真实
  `~/.vscode/extensions` 引起的既有环境性失败）；`DSH_LSP_AUTO_RUNTIME=0`
  可关闭运行时自动下载

## 测试

- 全量 vitest：447 通过（providers / envRequirements / dotnetProvision 新增 24+ 用例，
  含"必然缺失"的 99.0.0 版本号技巧保证缺失分支稳定覆盖）
- 黑盒验证：LSP stdio 探针对真实 PopIsland 工作区（IslandSplash_MainToolDev，59 工程）——
  正规时序下 definition 命中、references 129 条、documentSymbol 正常；
  DotRush.dll 以用户级 .NET 10.0.11 常驻等待 LSP 帧
- typecheck 零错误；host + client 构建通过；设置页白屏问题（effect 依赖 TDZ）已修复

## 已知

- 工作区根含多个 `.sln` 时，DotRush 自身要求根目录恰好 1 个 sln/csproj（其内置约束）；
  建议会话/工作区根落在具体分支目录
- ms-dotnettools.csharp 官方扩展依赖自身扩展代码在运行时下载服务器，DSH extmgr
  仅解包 VSIX，此路不通——C# 请使用 DotRush
- 手动配置无法表达 `dotnet xxx.dll` 形式的启动参数（只能配可执行文件路径/命令名）
