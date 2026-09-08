---
name: dsh-vscode-mode-dev
description: dsh-vscode-mode 插件开发/发布强制经验集——发布必须打 tag 走 GitHub Actions（禁止本地 npm publish）、CI 测试断言平台陷阱（ubuntu 会踩 Windows 路径）、DSH host 环境约束（subprocess stdio inherit/EditorPrefs 主线程/PATHEXT 污染）、Unity 外部编辑器 API 注意。发布、写测试、改 host 集成/launcher/Unity 包、CI 排错时必须使用。技能本身支持自我更新（见文末协议）。
---

# dsh-vscode-mode 开发/发布经验集（自我更新型技能）

> updated: 2026-09-08 · 维护者：ddj（AI 会话按文末协议追加，保持精炼、去重）

## 何时使用

- 发布新版本（commit/push/tag/npm 相关操作）。
- 编写或修改测试（尤其涉及路径、文件 URL、平台差异）。
- 修改 host 集成（subprocess/reg/csc）、launcher（C#/PS）、Unity 包（DshCodeEditor）。
- CI（GitHub Actions）失败排查。

## 发布流程（必须照做，禁止偏离）

1. 最终三门：`npm run typecheck` → `npm run test` → `npm run build` 全绿。
2. `git add -A` + commit：`release: vX.Y.Z <摘要>`（版本与 package.json 一致）。
3. `git push origin main` → `git tag vX.Y.Z` → `git push origin vX.Y.Z`。
4. tag 推送**自动触发** `.github/workflows/release.yml`：验证 tag==package.json 版本 → 三门 →
   npm pack → GitHub Release 挂 tgz → **有 NPM_TOKEN secret 才 npm publish** 并回读校验
   registry tarball 含 lib/index.js + lib/client.js。
5. **禁止本地 `npm publish`**：本机 npm 无凭据（whoami 401），发布只由 CI 完成。
6. 修复 CI 后重发布：删远端 tag（`git push origin :refs/tags/vX.Y.Z`）→ push 修复 → 重打 tag 推送。
7. CI 失败排查：jobs 日志 API 需 admin 权限；用公开接口
   `GET /repos/Lenonss/DSH_VsCodeMode/commits/<sha>/check-runs` → 失败 check 的
   `/annotations` 可直接拿到失败用例名与断言差异（无需任何凭据）。

## CI/测试平台陷阱（写测试前必读）

- CI 跑 ubuntu：新测试断言**禁止写死 Windows 反斜杠路径**。`path.join` 结果在 Linux 是 `/`
  分隔，断言前先 `.replace(/\\/g, '/')` 归一再比较（或两侧都用同一构造方式）。
- `pathToFileURL('C:\\x\\y')` 在 Linux 被当作**相对路径**按 cwd 解析（盘符不会成为路径段）；
  需要 file URL 的测试按 `process.platform` 分支构造合法 URL 并分别断言。
- .NET Framework 的 csc 是 **C# 5 方言**：无局部函数、无字符串插值、无 is-pattern；
  给 launcher 写编译探针时用传统语法。
- 本地 Windows 全绿不代表 CI 绿——发布前自问：新断言在 Linux 上成立吗？
- 2026-09-08 坑：DSH 会话沙箱内 vitest 必挂 esbuild `spawn EPERM`（esbuild 异步 build/transform
  API 恒 spawn 服务子进程，`ESBUILD_WORKER_THREADS` 只救 *Sync 变体，vite 不用）→ 测试/发布
  三门在用户真实终端或 CI 执行，会话内只跑 typecheck（tsc 无子进程）与 build（rolldown 原生）。

## DSH host 环境约束

- `ctx.subprocess.spawn` 的 stdio **必须** `{ stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' }`；
  管道收集模式（`{ maxBytes }`）在受管环境报 `spawn EPERM`。只需退出码的命令（reg/csc）用
  inherit；`handle.done` 成功解析为 `{ exitCode, signal }`（非 `{code}`）。
- teardown/卸载路径里直调子进程用 node `child_process.spawn` + `stdio: 'ignore'`
  （`execFile` 异步重载不支持 stdio 选项，TS2769）。
- 本会话审批策略为 never 时，pwsh 工具会降级 ConstrainedLanguage（子进程无输出、无
  `$LASTEXITCODE`，报 `Cannot run a document in the middle of a pipeline`）→ 派子代理跑构建；
  其环境 `PATHEXT` 被污染（=.CPL），需 cmd 内 `set PATHEXT=.COM;.EXE;.BAT;.CMD` 修正。
- PATH 里的 `bash` 是 WSL 残缺 stub（execvpe 失败）；shell 语法检查用
  `C:\Program Files\Git\bin\bash.exe`。
- 诊断通道：工作区注册表在 `~/.dsh/storages/workspace.json`
  （`tables.workspaces[id] = {path,title,sessionIds}`）；DSH `fs.resolve` 绝对路径直过
  （cwd 非边界），插件可读任意绝对路径文件，保存仍受会话沙箱 `policyOf` 约束。

## Unity 外部编辑器（com.dsh.editor）

- `EditorPrefs` 等 Unity API **仅主线程**：后台线程只做网络 IO + 纯计算；baseUrl 等必须在
  主线程读好后闭包捕获；回退 UI 操作经 `EditorApplication.delayCall` 切回主线程。
- `CodeEditor.Register` 的安装条目路径可能被下拉按存在性过滤 → 用真实存在路径
  （`EditorApplication.applicationPath`），`TryGetInstallationForPath` 同时认虚拟路径与真实路径。
- "Open C# Project" 传入**空路径** → 视为打开 Unity 项目根。
- 极简 JSON 提取器偏移：`"key":` 起点 = `key.Length + 3`；`"key":"` 起点 = `key.Length + 4`。
- 内嵌包更新 = 整目录替换 + Unity 重新聚焦自动生效；版本号驱动设置页「可更新」徽标；
  Unity 生成的 `.meta` 文件要随 git 提交（稳定 GUID）。

## 自我更新协议（技能如何更新自己）

1. **何时更新**：本次会话踩到本文件未记录的新坑（环境/流程/平台/接口），或既有条目已失效
   （API 变更、流程变更）。
2. **如何更新**：直接编辑本文件对应小节，追加一行 `- YYYY-MM-DD 坑：<现象> → <解法>`（一行
   讲完，超过两行说明就压缩）；失效条目改写而非堆叠。更新后把顶部 `> updated:` 改为当天。
3. **边界**：只沉淀会复发的事实与解法，不记录一次性调试过程与猜测；与既有条目重复时不加。
4. **同步**：本文件位于仓库内（`<项目根>/.dsh/skills/`），更新后随常规 commit/push 提交，
   技能内容即随仓库版本化。
