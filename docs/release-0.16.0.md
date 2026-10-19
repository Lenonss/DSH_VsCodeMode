# Release 0.16.0 — C# 智能体体验增强

> 日期：2026-10-19 · 作者：ddj · 基线：v0.15.9 @ `89af5e0`

## 背景

Unity C# 项目实测（PopIsland / IslandSplash，2026-10-19）发现两类问题：

1. **C# provider 优先级**：ms-Roslyn（`ms-dotnettools.csharp` 的
   `Microsoft.CodeAnalysis.LanguageServer.dll`）依赖 C# Dev Kit 的 serviceBroker
   加载解决方案——无 Dev Kit 时即使发 `solution/open` 也不加载项目，表现为
   references 不跨文件、元数据符号 definition 全空；而 DotRush 服务器从 cwd
   自动发现 sln 并自行加载（restore/compile/索引），元数据符号可跳转反编译源码
   （实测 `GameObject.Find` → `_decompiled_/UnityEngine.GameObject.cs`）。
2. **Roslyn 元数据上下文**：Roslyn LSP 启动后若收不到 solution/project 通知，
   会停留在「杂项文件」模式——工作区内自有符号可解析，但 Unity 引擎程序集 /
   NuGet 包等元数据符号的 definition/hover 一律返回空。

另：DAP 调试发现 DotRush 的 Unity 适配器（`monodbg.dll`）声明
`runtime: "dotnet"`，旧版 discovery 直接按不支持运行时置灰。

## 改动

| 文件 | 改动 |
|---|---|
| `src/lsp/providers.ts` | `resolveCSharpProvider` 优先级调整：DotRush 优先于 ms-Roslyn（两者都发现时）；Roslyn 分支保持原状作为回落 |
| `src/lsp/server.ts` | csharp 握手后 `findSolutionFile()` 找工作区根第一个 `.sln`（字典序），发 Roslyn 专有 `solution/open` 通知；其它 C# 服务器按协议忽略未知通知，无 sln 静默跳过，lua 等其它语言不发 |
| `src/dap/discovery.ts` | `runtime='dotnet'` 视为支持（DotRush monodbg dll 形态），reason 文案同步更新 |
| `src/dap/provider.ts` | 新增 `dotnetLaunch()`：优先扩展内置 SDK dotnet，其次按 dll 同目录 runtimeconfig 要求的运行时大版本找满足的 dotnet（复用 LSP 侧 `runtimeMajorOf`/`dotnetWithRuntime`），兜底任意 dotnet |
| `tests/providers.test.ts` | 优先级用例改为「有满足 .NET 10 的 dotnet → DotRush 优先；有 dotnet 无 .NET 10 → Roslyn」 |
| `tests/lspSyncVersion.test.ts` | 新增 solution/open 用例（根有 sln 发 file:// URI、无 sln 不发、lua 不发） |
| `tests/dapDiscovery.test.ts` | 新增 runtime=dotnet → available=true 用例 |
| `tests/dapProvider.test.ts` | 新增 runtime=dotnet 规格解析用例（有满足 dotnet → dotnet+dll；无 → null） |

## 验证

- `npm run typecheck`：0 error
- `npm run test`：2961 passed + 15 skipped（`dapFakeAdapter` / `archiveDb` 两例
  已知计时抖动不在本次 diff，隔离重跑 20/20 全绿）
- `npm run build`：tsdown host + client 双 ✔

## 已知缺口

- 本次为 host 侧 LSP/DAP 逻辑改动，未做真实 GUI 冒烟；DotRush 优先与
  solution/open 的端到端效果在真实 Unity 项目中实测过（见背景），发布即以该
  现场验证为准。
