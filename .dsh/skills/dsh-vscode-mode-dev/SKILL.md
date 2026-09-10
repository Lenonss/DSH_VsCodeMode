---
name: dsh-vscode-mode-dev
description: dsh-vscode-mode 插件开发/发布强制经验集——发布必须打 tag 走 GitHub Actions（禁止本地 npm publish）、CI 测试断言平台陷阱（ubuntu 会踩 Windows 路径）、DSH host 环境约束（subprocess stdio inherit/EditorPrefs 主线程/PATHEXT 污染）、Unity 外部编辑器 API 注意。发布、写测试、改 host 集成/launcher/Unity 包、CI 排错时必须使用。技能本身支持自我更新（见文末协议）。
---

# dsh-vscode-mode 开发/发布经验集（自我更新型技能）

> updated: 2026-09-10 · 维护者：ddj（AI 会话按文末协议追加，保持精炼、去重）
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
- 2026-09-08 坑：工作区有未提交 WIP 时，步骤 2 的 `git add -A` 会把未完成代码扫进发布，且 CI 构建
  的是推送树而非本地目录（脏树跑过的三门不代表发布内容）→ 先 `git stash push -u` 隔离，净树跑
  三门，release commit 只 add package.json，tag 推送后 `git stash pop` 还原（v0.1.57 实测）。
- 2026-09-08 事实：awesome 收录条目（PR #2532，category git）的 `tarball:` 钉在 v0.1.36，发版即过期；
  npm 映射自动、该字段冗余 → 改自己条目时删 tarball 行，勿再钉版本号。
- 2026-09-09 事实：pnpm 在本环境跑 run 脚本会先做 deps-status check 触发 store SQLite 报错
  （`unable to open database file`）→ 三门直接调 node_modules/.bin（tsc.cmd/vitest.cmd/tsdown.cmd）绕过。

## 开发/部署形态切换（profile 安装形态）

- 开发形态 = profile node_modules 里 Junction → 源码目录（构建即生效）；正式形态 = npm 版本依赖。
  解除：备份 profile `package.json` → 依赖改 `^<version>` → `cmd /c rmdir` 删 Junction（只删重解析点，
  禁用 `Remove-Item -Recurse` 以防触达源码）→ profile 内 `pnpm install` → 重启 DSH 生效
  （运行中 host 半仍是旧代码）。解除后源码改动不再直达 profile，需走 tag 发布 + `pnpm install`。
- 2026-09-08 坑：profile 依赖写 `file:...tgz` 但实际装的是手动 Junction 时，`readDevForm` 只认
  `link:` 前缀 → 兼容性报告误报「非开发形态」；依赖声明必须与实际安装方式一致。
- 2026-09-08 事实：web profile pnpm 为 `nodeLinker: hoisted`（无 .pnpm 分层，包是顶层实目录）；
  pnpm v11 默认拦截依赖构建脚本，白名单在 profile `pnpm-workspace.yaml` 的 `allowBuilds`。
- 2026-09-08 事实：`@vscode/ripgrep` 新版经平台可选包（`@vscode/ripgrep-win32-x64`）分发 rg.exe，
  不在 `@vscode/ripgrep/bin`（勿按旧路径判缺失）；rg 不可用时插件搜索报「ripgrep 不可用」并降级。
- 2026-09-22 坑：裸 Junction（manifest 依赖仍是版本号）会被 DSH 启动从插件缓存恢复成实目录覆盖 →
  持久开发形态 = manifest 依赖写 `link:<源码目录>` + Junction + profile `pnpm install`
  （本插件可直接 RPC `vscode.devFormSet {enabled:true,path}`，返回 restart:true 后重启生效）。
- 2026-09-22 事实：运行中判别 host 是否新构建——POST /edrv/rpc 调只有新代码才有的方法，旧版统一回
  「未知方法: ...」；vendor 静态资源看 `/edrv/vendor/*` 状态码与 Content-Type。
- 2026-09-22 坑：client CSS 构建期内联 `<style data-plugin-css>`（同 tagId 幂等跳过）→ 同文档热重载
  旧样式残留，改 CSS 必须整页刷新才生效；验证是否随包生效直接 grep lib/client.js。
- 2026-09-22 坑：编辑区新增命令式面板外壳（React 条件分支的空 div）不给尺寸样式 → flex 子项
  0 高度，面板执行正常但整片空白无报错；对齐 .edrv-monaco-host 模式（外壳 flex:1+min-height:0+
  position:relative，内层 absolute inset:0）。
- 2026-09-22 事实：client 包内加载第三方 ESM 库（v0.1.55 pdf.js）= vendor 产物入 assets/vendor/ +
  VENDOR_MIME 补扩展名（.mjs 必须 text/javascript，ESM import 严格校验 MIME；.bcmap/.pfb 等标 binary）+
  运行时一条 module-script 按序 import 产物挂 window handoff（打包器会改写源码内 import(URL)）；
  库枚举值跨版本漂移（pdf.js AnnotationEditorType.NONE=0/1），对照官方接线源码核实后再硬编码。
- 2026-09-10 坑：client bundle 由 host 按内容算 rev 实时读盘（改代码**不需要**重启 host），但浏览器按
  同一 rev URL 命中 HTTP 缓存 → 普通刷新仍跑旧 bundle；生效/验证必须 ignoreCache 硬刷新，判别 =
  `__DSH_BOOT__.entries` 里该包 rev 是否变化。
- 2026-09-10 事实：官方 UI 原语 `@deepseek-ai/dsh-client-ui-primitives` 是 loader 虚拟模块（磁盘无包
  目录，40+ 官方包 require 消费）→ 插件要用必须（a）加进 tsdown `CLIENT_EXTERNALS`，（b）加 ambient
  `.d.ts` 垫片，（c）审计脚本从 `dsh-web-frontend/dist/assets` 断言导出面；`Icon*` 组件直接渲染
  `<svg class=…>`（不是 span 包 svg，探针别用 querySelector('svg') 误判），props = `{size, className}`。
- 2026-09-10 事实：跟随官方主题（ctx.theme + 令牌）——`--dsw-alias-*` 定义在 **body**（不是 :root），
  `--shiki-background/-foreground` **不存在**（代码面底色用 `--dsw-alias-markdown-code-block`、前景用
  label-primary），令牌值可能是 `hsl(0 0% 4.3% / 5%)`（百分比 alpha 要 /100）；Monaco 的 token `''`
  基础规则会盖住 editor.foreground，必须显式覆盖 `.mtk1`；免挂编辑器的验证手段 = 先
  `monaco.editor.colorize()` 触发主题样式生成，再读 `<style>` 里 `.mtk*` 的实际颜色。
- 2026-09-10 坑：`[data-edrv-view]` 作用域内重新定义 `--dsw-alias-*` 会让插件永久不跟随 DSH 主题
  （v0.1.63 移除）→ 想跟随官方令牌就不要在插件作用域重定义同名变量，回落值写在 `var(..., 值)` 里。
- 2026-09-10 坑：DSH **没有** `window.dsh` 命名空间（全仓库无赋值；真实全局仅 `__ModuleLoader__`/
  `__DSH_BOOT__`/`__edrvExtPoll` 等）→ 插件对外暴露能力**禁止**挂 `window.dsh.*`：条件式
  `if (window.dsh) …` 是死代码、读取方恒得 undefined。改用 `window.__edrv*__` 风格自有键，
  且**首选模块内引用直传**（全局只作镜像）——v0.2.0 命令栏空列表即此因（桥装配日志正常但浮层读不到注册表）。
- 2026-09-10 坑：单实例「宿主认领」若 claim 返回 boolean 而调用方自造令牌（`claim() ? {} : null`），
  与 store 内部对象**身份不同** → release 的身份校验恒失败 → 令牌永久泄漏 → 之后任何实例都渲染 null，
  表现为 `Ctrl+Shift+P`「**完全没有反应**」且永不恢复（v0.3.0 修）。规矩：claim 必须**返回 internal
  存下的同一对象**、释放后 `notify` 让其余实例重试认领（宿主更替自愈，slot 重挂/骨架形态切换会触发）；
  且认领**禁止写在 render 期**（`useState` 初始化器等）——StrictMode 双调用会让首次认领被判失败。
- 2026-09-10 坑：排查「快捷键没反应」先判**按键是否已被捕获**——命令桥处理过就会 `preventDefault`，
  故「`defaultPrevented=true` 但 DOM 无浮层」= 命令已派发、无人渲染（宿主认领/挂载问题），
  与「按键根本没被处理」是两类故障，别混为一起查。第三个判据：**`defaultPrevented=false` 且命令
  的 `available()` 返回 false** = 可用性探测误判（桥按设计「不可用则不吞键」）→ 见下条。
- 2026-09-10 坑：**禁止用 `textarea.inputarea` 探测「编辑器是否打开文件」**——Monaco 在支持
  **EditContext API** 的浏览器（Chrome/Edge）里默认用它取代 textarea（源码
  `editContext: se(44,"editContext",!0)`），只建 `div.native-edit-context`，于是 `.monaco-editor
  textarea.inputarea` 恒为 0、`hasEditorModel()` 永假 → 13 条 `needsModel` 命令被静默隐藏且按键被
  放行（v0.3.0 的 `Ctrl+U`「完全没效果」即此因，v0.3.1 修）。正确判据：插件编辑器行内的 Monaco 实例
  ——`.edrv-editor-row .monaco-editor`（与输入实现无关；用 `.edrv-editor-row` 限定可避免误命中官方
  预览的 Monaco，否则无编辑器时快捷键会吞键）。凡是探测第三方库内部 DOM 结构的代码都要按此警惕：
  升级/换浏览器即可让选择器静默失效，且**不报错**（法一线索是「DOM 有编辑器但探测恒假」）。
- 2026-09-10 事实：判断「编辑器是否打开文件」的可靠信号是 **Monaco API**
  （`window.monaco.editor.getEditors().some(e => !!e.getModel())`）或插件自有类名，
  不要去猜 Monaco 的输入层 DOM（textarea / EditContext / 未来的实现都可能变）。

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
  三门在用户真实终端或 CI 执行，会话内只跑 typecheck（tsc 无子进程）与 build（rolldown 原生）；
  2026-09-22 补：策略 danger-full-access 时 vitest 直接可跑；workspace-write（审批 ask）下对同一
  `npm run test` 命令一次性升 danger-full-access 重跑即可（v0.1.57 三门实测 597 passed）。

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
- 2026-09-22 坑：沙箱内 `git push` 挂在凭据辅助器（Git sh.exe `couldn't create signal pipe`，Win32 error 5
  → could not read Username），commit 正常 → push 对同一命令一次性升 danger-full-access 重试即可。
- 2026-09-22 坑：沙箱内出站 HTTPS 受限——后台任务报 `The SSL connection could not be established`，
  前台 Invoke-WebRequest 报 `Authentication failed`（TLS 认证失败）→ 会话内查 CI/registry/公开 API
  用 web_fetch 工具（api.github.com、registry.npmjs.org 直达），不起后台轮询任务。
- 2026-09-08 事实：gh CLI v2.94 已登录 Lenonss（keyring token，credential.helper=`!gh auth git-credential`，
  gh git 协议默认 ssh）→ `gh repo edit/fork/pr`、git clone/ls-remote/推 fork 一次性升权后可用；
  外部仓库克隆用显式 https URL 走 gh 凭据助手，别用 gh 的 ssh URL。
- 2026-09-08 坑：git 身份只配在主检出仓库级（.git/config）无全局 → 新克隆 commit 报
  `Author identity unknown` → 克隆内补 `git config user.name/user.email`
  （Lenonss / lenonss@users.noreply.github.com）。

## Unity 外部编辑器（com.dsh.editor）

- `EditorPrefs` 等 Unity API **仅主线程**：后台线程只做网络 IO + 纯计算；baseUrl 等必须在
  主线程读好后闭包捕获；回退 UI 操作经 `EditorApplication.delayCall` 切回主线程。
- `CodeEditor.Register` 的安装条目路径可能被下拉按存在性过滤 → 用真实存在路径
  （`EditorApplication.applicationPath`），`TryGetInstallationForPath` 同时认虚拟路径与真实路径。
- "Open C# Project" 传入**空路径** → 视为打开 Unity 项目根。
- Unity 内置 `CodeEditor.OnOpenAsset` 对双击的**任何**资产（含 prefab/scene）回调 `OpenProject`，返回 true
  即视为已处理 → 外部编辑器必须按扩展名白名单过滤、不支持时 return false（对齐
  `DefaultExternalCodeEditor`），否则双击预制体/场景被外部编辑器劫持（v0.1.56 修复）。
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
