---
name: dsh-vscode-mode-dev
description: dsh-vscode-mode 插件开发/发布强制经验集——发布必须打 tag 走 GitHub Actions（禁止本地 npm publish）、CI 测试断言平台陷阱（ubuntu 会踩 Windows 路径）、DSH host 环境约束（subprocess stdio inherit/EditorPrefs 主线程/PATHEXT 污染）、Unity 外部编辑器 API 注意。发布、写测试、改 host 集成/launcher/Unity 包、CI 排错时必须使用。技能本身支持自我更新（见文末协议）。
---

# dsh-vscode-mode 开发/发布经验集（自我更新型技能）

> updated: 2026-09-22 · 维护者：ddj（AI 会话按文末协议追加，保持精炼、去重）
- 2026-09-22 实录（v0.6.0 发布，全绿）：`build` 54s success、`release` **5m29s** success（含
  `Verify published tarball`）；四向闭环一次对齐：registry `0.6.0` 的 `gitHead` == `427b7ec`
  （release commit）、`dist-tags.latest` → `0.6.0`、tag 同 commit、Release 挂 tgz
  （digest sha256:52c2c3…）。改动 99 文件（DAP 断点调试 + SVN 补丁/汇总/导出），逐条核对后单提交不 stash。
- 2026-09-22 坑（v0.6.0 发布前实测，**新测试首次上 CI 前必查**）：伪造扩展清单的 fixture
  **漏抄真实清单字段**会产出本地/CI 双态失败——`dapDiscovery` 的 coreclr fixture 漏写
  `languages`（真实 DotRush 清单有 → 经 `LSP_LANG_EXT` 才映射出 `exts=['.cs','.csx']`），
  且只创建 `clrdbg.exe` 入口（Windows 走 `windows.program` 覆盖本地绿；ubuntu 回落基名
  `clrdbg` 不存在 → `available=false` 第 66 行必挂）。规矩：**fixture 模拟真实扩展时对照本机
  实际 package.json 抄全 `languages`/平台入口文件**；判「该修测试还是修实现」看三方契约
  （实现注释「皆空=不限=[]」、`bpAllowed` 空表不过滤、README「按**声明**语言过滤」）——
  三方一致则 fixture 错，改 fixture 不改实现。
- 2026-09-21 事实 + 坑（暂停态调试 hover 对齐 CodeBuddy，源码级核对 `CodeBuddy CN/resources/app/out/vs/
  workbench/workbench.desktop.main.js`）：CodeBuddy/VS Code 的调试浮窗是**独立 widget**（`debug.hoverWidget`
  → `.debug-hover-widget` / `.debug-hover-tree[role=tree]`，成员全量 + 行内折叠按钮），显示时调
  `preventDefaultEditorHover()`（`editor.updateOptions({hover:{enabled:false}})`）**禁用默认（LSP）hover**；
  **按住 Alt** 反过来隐藏调试浮窗、解除禁用 → 显示 LSP hover。本仓 Monaco hover 只能返回 markdown，
  等价实现落在三处：调试内容单块 HTML（`[data-edrv-dap]`，`src/client/dap/hover.ts`）、hover 层
  （`src/client/dap/hoverTree.ts`：给行打 `data-edrv-row=debug|lsp`、注入贴底提示层、按 Alt 切 display）、
  Alt 跟踪（`src/client/dap/hoverMode.ts`）。四个实测坑：
  **①（切换）别用 `showContentHover` 主动重算**：`getContribution('editor.contrib.hover')
  .showContentHover(光标处折叠 Range, 1 Immediate, 0 Mouse, false)` 看似是官方 `showEditorHover` 同法，
  但 `_startShowingOrUpdateHover` 在「新 anchor 与当前结果 anchor 相等」时**直接 return**
  （`HoverRangeAnchor.equals` 只比 range）⇒ 同一鼠标位置反复按 Alt **只有第一次生效**（且整块重渲染闪烁）。
  正解是**不动 provider 的显示层切换**：Alt 变化只改行的 `display` 与提示文案，瞬时、且不依赖 keydown 送达
  （`mousemove.altKey` 兜底）；`debugHoverOwns()` 让位逻辑随之作废（LSP 行默认隐藏、Alt 时显示）。
  **②（钩子）markdown 会剥掉 `class`**：本仓 vendored Monaco 的 markdown→DOM 管线把我们 hover 内容 HTML 里的
  `class` **全部丢掉**（`supportHtml:true` / `isTrusted` 都不豁免，页内实测三种写法全丢），**只有 `data-*` 存活**
  ⇒ 经 provider 返回的 HTML，交互钩子与 CSS 选择器**一律用 data-***；用 class 会静默失效（折叠按钮点了没反应、
  样式全不生效，且 tsc/单测都抓不到）。**③（提示常显）**贴底提示别用 `position: sticky`（滚动链在
  `.monaco-hover-content` 上，会被滚走）也别用 `:has(class)`（class 已被剥）：注入到 `.monaco-hover`
  （**滚动区之外**）`position:absolute;bottom:0`，并给容器打 `data-edrv-hint-host` + `padding-bottom` 预留同高。
  **④（树状态）**`createTreeState` 同 key 必须**复用**旧状态（按名+ref 判等），否则 hover 一重渲染
  `expanded/cache` 清零，观感是「点开又收起」；绑定要用批次末兜底扫描
  （`[data-edrv-tree]:not([data-edrv-wired])`），因为 markdown 内容是异步插入 DOM 的。
- 2026-09-18 实录（v0.5.3 发布，全绿）：`build` 41s success、`release` **5m34s** success
  （`Verify published tarball` 同轮内取到，非 staged）。三向闭环一次对齐：registry
  `dsh-vscode-mode/0.5.3` 的 `gitHead` == `7f71d8e`（release commit SHA）、`dist-tags.latest`
  → `0.5.3`、git tag `v0.5.3` → 同 commit、GitHub Release 挂 tgz asset（digest sha256:5027…）。
  本次改动全为本会话产物（mtime 全在 17:15–17:52 一簇），沿用「逐条核对后单提交、不 stash」口径；
  发布前三门实测：typecheck 0 err、**全量 1447 passed / 7 skipped（104 文件）**、build 双面绿。
- 2026-09-18 坑（v0.5.3 实测，**GUI 验证才能抓到的一类缺陷**）：**用 `typeof x === 'function'`
  判「React 组件是否可用」是错的**——官方 `MarkdownText` 是 `React.memo(...)` 产物
  （`MemoExoticComponent`），`typeof` 为 **'object'** 而非 'function'，函数判据恒 false →
  「兼容降级」分支在**所有新版 DSH 上永久生效**（预览只显示降级纯文本）。该缺陷**同时绕过
  tsc 与全部单测**：手写 ambient 垫片把导出声明得很宽松、纯函数测试不碰该守卫，
  唯一捕获途径是真实浏览器端到端。修法 = 抽纯函数 `isComponentType(value)`，按 React 自身
  口径判（`typeof === 'function'` **或** 带 `$$typeof` 的非 null 对象），并补单测固化
  「memo 替身的 typeof 必须是 object」这一前提（本仓 `src/client/md/componentType.ts`）。
  **教训：凡与 React 组件类型打交道的判据，必须有独立可单测的纯函数**，否则垫片 + `@ts-nocheck`
  会让类型系统完全失明；且**客户端 UI 新功能发版前必须真浏览器冒烟**（对齐既有「发布前仅跑三门
  不抓渲染期错误」条目）。
- 2026-09-18 坑（v0.5.3 实测，**新建数据损坏，已留证未修**）：**700ms 防抖自动保存会把
  「当前活动文件的内容」写进「先前文件的路径」**——症状是旧文件被静默覆盖成新文件内容。
  根因在 `EditorView.ts` 三处叠加：① `doSave` 用 `const path = active` 取路径、`ed.getValue()`
  取内容（**不同源**）；② `onEdit` 的 `arm(schedule, 700, () => doSave(true))` 闭包**触发时**才读
  `active`/`editorRef`；③ `edrv:open-editor` → `addTab` 入口**只 setActive、不 flushSave**
  （页签点击 / 关闭路径都调了 flushSave，唯独这个入口没有）。复现：编辑 A → 700ms 内开 B。
  判别「是不是本次改动引入」的归因实验：把触发概率的条件（如页签上限）设为 0 禁用掉，
  **仍复现即与本次无关**。修法方向（留待立项）：`doSave` 改为按 model uri 反解路径
  （已有 `modelPathOf`，保证 path 与 content 同源）**且**所有改 active 的入口统一先 `flushSave()`。
  同族教训：**任何会替换 Monaco host / 改变 active 的新入口，都必须先 `flushSave()`**，
  否则防抖到点时 `editorRef` 已空 → `doSave` 静默 return → 改动永不落盘（v0.5.3 的 Markdown
  预览切换已按此处理）。
- 2026-09-18 坑（v0.5.3 实测）：**改 `README.md` 必须顺手更新「安装」段的固定 tag 与
  「更新日志」**——该段常年停在旧版本号（v0.5.0 时发现还写着 v0.1.23；v0.5.3 时安装示例
  仍钉 v0.5.2）。发版清单里把它当固定动作：安装示例 3 处 tag（git/Release tgz 的文件名）
  + 顶部「近期关键版本」追加本条。
- 2026-09-18 实录（v0.5.2 发布，全绿）：`build` job 41s success、`release` job 4m32s success
  （含 `Verify published tarball`，**无需等满重试窗口**，CDN 本次很快）。三向闭环一次性对齐：
  registry `dsh-vscode-mode/0.5.2` 的 `gitHead` == `980b7b2`（release commit SHA）、
  `dist-tags.latest` → `0.5.2`、git tag `v0.5.2` → 同 commit、GitHub Release 挂 tgz asset。
  事实：本次 **未** stash——改动全部 mtime 集中在同一 5 分钟内（16:30–16:34）且逐条核对确属本次内容，
  直接 `git add -A` 单提交（沿用 2026-09-11 条目口径）；打 tag 前先确认远端无该 tag 且 npm 该版本 404。
- 2026-09-18 坑（v0.5.2 实测，**用户端 vs 开发形态差异**）：**开发形态（`link:` + junction）会掩盖
  npm 安装缺陷**——本仓 `node_modules` 有 devDependency 副本，`import('schemastery')` 能命中
  `.pnpm/schemastery@3.18.0`，而**用户 npm 安装（profile `nodeLinker: hoisted` + `autoInstallPeers: false`）
  下插件包只有 `dependencies`，解析不到**。判据：改依赖解析/包名相关代码后，别只在本机（dev-link）
  验证——用 `createRequire(anchor).resolve(spec)` 对**安装树入口**（`process.argv[1]` 锚点）与
  **插件自身路径**两个锚点分别探测，二者结果不一致即“只在用户端坏”的缺陷。
  （本轮实例：`fileOpenSettings` 用 `Promise.all([...hostImport('schemastery')])`，安装树里官方已把
  vendored 包改名为 `@deepseek-ai/schemastery` → 整体 reject → 设置 section 静默不装配，面板显示
  「设置 section 尚未装配」；修法 = 候选链解析 + 各依赖独立加载 + 命中库名进报告。）
- 2026-09-18 坑（v0.5.2 实测）：**VSIX 解包必须补 Unix 执行位**——`src/lsp/zip.ts` 的 `zipEntries`
  原先不读中央目录 `offset+38` 的 external attributes（Unix mode 在**高 16 位**，低 16 位仅 DOS 属性），
  `writeFileSync` 落盘默认 0o666 → macOS/Linux 上语言服务器 `spawn EACCES`（Windows 不检查执行位故
  开发机不复现；VS Code 自身解 VSIX 会按该 mode 调 `fs.chmod`）。修法 = 读 mode + 按 `bin/` 等入口名
  兜底 0o755（`src/lsp/extmgr.ts` 的 `execModeOf/applyExecBit`，best-effort 不阻塞安装）。
  测试注意：Windows 宿主 `chmod` 改不了执行位 → 真实落盘断言要 `it.skipIf(process.platform === 'win32')`。
- 2026-09-18 坑（v0.5.2 实测）：**平台专属命令不要“先试错的再回落”**——`revert.deleteCreated` 原先无条件
  先发 `powershell Remove-Item`，macOS/Linux 每次删除都先失败一次再走 `/bin/rm`（功能可用但有失败噪声与
  无谓 spawn）。规矩：按 `process.platform` 一次分派（抽纯函数 `removeFileArgv` 便于单测）。
- 2026-09-18 坑（v0.5.1 实测，**发布前必查**）：**改 `package.json` 的依赖/peer 后必须同步重生成
  `pnpm-lock.yaml`**，否则 CI 的 `Install deps`（`pnpm install --frozen-lockfile`）直接失败 ——
  症状极具迷惑性：CI 两个 job 都在 **~15 秒**内 failure，`Typecheck`/`Test`/`Build` 全部 **skipped**，
  annotations 只有一句「Process completed with exit code 1.」指向 workflow 文件行号（不是源码），
  看代码怎么都找不到问题。修法：`pnpm install --lockfile-only` 后提交 lockfile；本地自检 =
  `pnpm install --frozen-lockfile --lockfile-only` 返回 0。
  （判据：失败时间远小于跑测试所需时间 ⇒ 问题在安装/构建前置步骤，别去翻测试。）
- 2026-09-18 事实（v0.5.1 实测）：重发同版本前确认**失败的那次没产出 Release**（
  `GET /releases/tags/v<ver>` 应 404）→ 才可删远端 tag 重推；本轮 13 步全 success，
  `Verify published tarball` 约 **4.5 分钟**属正常 CDN 延迟（非 staged），闭环三向对齐即可：
  registry `<pkg>/<ver>` 的 `gitHead` == release commit SHA、`dist-tags.latest` 已切换、
  git tag 指向同一 commit。
- 2026-09-18 事实（v0.5.1）：本仓 `tests/outline.test.ts`（自 v0.1.21 起未改）存在**既有顺序依赖**
  ——`npx vitest run --sequence.shuffle` 会偶发失败，而 CI 用默认顺序（不 shuffle）恒绿；
  排查「偶发失败」时先用 shuffle 复现并区分是否本次引入，别把它当自己的回归去改别人的测试。
- 2026-09-18 坑（v0.5.1 实测）：**官方 alpha 线会移除 client 快照字段，取「当前会话」必须走多级链**——
  DSH 0.1.6-alpha.2 起 `sessions.list` 快照不再有 `current`（改为 `uiSession.current`，其绑定源
  `getSnapshot().key` = sessionId），仍直读 `list.getSnapshot().current` 的代码**静默失效**（不报错，
  只是预热/LSP 同步/编辑 Tab 恢复/文件链接上下文全不工作）。取值顺序：`uiSession.current.key` →
  `list.current`（旧版）→ `byId` 中 `retainedBy.mainView > 0` 的首行 → 槽位 `props.sessionId`；
  `uiSession` 用 `ctx.get` 探测**别进 inject**（旧版无此服务会停等）。本仓实现在 `src/client/sessionScope.ts`。
- 2026-09-18 坑（v0.5.1 实测）：**`window.monaco` 跨插件重载存活，模块级 `registered` 守卫会失效**——
  插件重载后 bundle 重新求值使模块状态复位，但 Monaco 实例还在 → 每次重载**重复注册整套 provider**
  （补全/跳转/hover 翻倍）。规矩：provider 注册标记与注销器一律落 `window.__edrv*__`（跨代认领 + 可清理），
  并在 client `apply` 的 `ctx.effect` 卸载回调统一 dispose。改动前先 grep「`disposeXxx` 是否有调用方」——
  本仓曾出现 `disposeSnippets()` 定义完整却**零调用**（死代码），AI/LSP 两处更是完全没有复位路径。
- 2026-09-18 坑（v0.5.1 实测）：**peer 区间写 `>=0.1.0-rc.1 <0.2.0-0` 对 alpha 版本恒不匹配**——
  semver 要求比较器的元组自带预发布标识，否则该区间对**任何**预发布返回 false（实测
  `satisfies('0.1.6-alpha.2','>=0.1.0-rc.1 <0.2.0-0')===false`，而 `'0.1.0-rc.8'===true` 只因恰好落
  在下界元组内）。每条 alpha 线要显式写 `>=0.1.6-0 <0.2.0-0`。本仓守卫见 `tests/peerDeps.test.ts`。
- 2026-09-18 事实（v0.5.1 实测）：**host 半改动不随 client 热更新生效**——client 走 combo 端点按 rev 读盘
  可即时生效（新增 window 标记浏览器里能立刻读到），但 host 半在进程内**不重载**：`compat` RPC 仍报旧
  `TESTED_DSH_MAX` 而磁盘 bundle 已是新值。判别「跑的是不是新 host」= 调一个只有新代码才有的行为/RPC；
  **改 host 后必须重启 DSH 才能验收 host 侧效果**，别把「磁盘已改」当「已生效」。
- 2026-09-18 事实（v0.5.1）：`plans/` 在 `.gitignore:19` 被忽略 → 计划文件不会进发布提交（本轮 22 个
  文件全为 `src/`、`tests/`、`docs/`、`package.json`、`README.md` 改动，可直接 `git add -A`）。
- 2026-09-18 事实（v0.5.0 实测，四条全绿一次过）：① **真实仓库数据样本不入库**——测试若依赖真实仓库导出（如 `svn log -g` 的 XML），把样本放 `tests/fixtures/*.xml` 并加进 `.gitignore`（已加），用例写成
  `const f = fileURLToPath(new URL('./fixtures/x.xml', import.meta.url)); it.skipIf(!existsSync(f))('…', () => …)`：本地有文件即真跑，CI 无文件自动 skip（v0.5.0 实测 43→42 passed + 1 skipped，两面都绿）；
  别指望 `git rm --cached` 之后 CI 还能找到它。② 发布前**本地跑全量**（本仓 1337 用例≈8s）= CI 的 Test 步骤，别把 ubuntu 未知项留给 CI。
  ③ 本次 `release` 工作流 13 步全 success，含 `Verify published tarball`（**5 分 34 秒**才拿到 tarball，属正常 CDN 延迟，不是 staged）；判别仍按既有条目：registry `latest` 的
  `gitHead` == release commit SHA 即闭环。④ 顺手更新 README 的**安装示例固定 tag** 与「更新日志」段——它常年停在旧版本号（v0.5.0 时发现还写着 v0.1.23）。
## 何时使用

- 发布新版本（commit/push/tag/npm 相关操作）。
- 编写或修改测试（尤其涉及路径、文件 URL、平台差异）。
- 修改 host 集成（subprocess/reg/csc）、launcher（C#/PS）、Unity 包（DshCodeEditor）。
- 新增/修改插件自带技能（`skills/` 随包 SKILL.md、`src/skills.ts` provider）。
- CI（GitHub Actions）失败排查。

## 仓库布局与 issue 修复

- 2026-09-22 事实：**本仓库真实开发 checkout 就是 `DeepSeekHarnessPlugin/packages/dsh-edit-review`**（remote 指向 Lenonss/DSH_VsCodeMode.git）；
  `packages/dsh-vscode-mode` 是停更的 v0.1.28 旧副本，缺官方侧栏文件（OfficialSideTab.ts/officialSidebar.ts），别在那里改。
- 2026-09-22 坑：edrv URI 拼绝对路径必崩——`'edrv:///' + encodeURI(path)` 遇 `/home/x` 拼出 `edrv:////`（4 斜杠），
  Monaco Uri.parse 抛 UriError 白屏（issue #5/#6，Linux/macOS 必现）；修法 = 先 `String(path ?? '').replace(/^\/+/, '')` 再拼，
  Windows 盘符形态不变；同源隐患在 lspClient.toEdrvUri（root 不匹配时 relativeLspPath 返回绝对路径）要一并修。
- 2026-09-22 坑：`@ts-nocheck` 文件里「调用未导入的标识符」typecheck 抓不到（OfficialSideTab 漏 import markEditorActive →
  卸载 ReferenceError）；排查运行时 ReferenceError 时优先核对 import 列表与调用点，别只看类型检查。
- 2026-09-22 坑：Monaco loader 失败永久卡死 = fail() 不清 `<script data-edrv-monaco-loader>` + 残留分支同步 boot()；
  且其他插件注入全局 `module`（loader.js 用 `typeof module < 'u' && !!module.exports` 判环境）会让 loader 误判 Node
  不挂 window.require → 注入前临时删全局 module/exports（onload/onerror 后还原）+ boot 前校验 require + 失败清标签
  + 残留分支「require 就绪才 boot，否则移除重注入」；boot 内 require 缺失直接 fail 报真实原因（别再重注入，防死循环）。
- 2026-09-22 坑（测试）：mock window.require 就绪时，loader 残留分支会走「require 就绪直接 boot」而非「移除重注入」——
  测「残留+require 缺失」场景必须初始 stub `{ require: undefined }`，注入后（onload 前）再换成就绪 require。
- 2026-09-22 坑（v0.4.4 引入，v0.4.6 修）：渲染期裸赋值 `ref.current = 后置const` 是 TDZ 必炸——FileExplorer 组件体
  134 行 `dirsMapRef.current = loadDir` 写在 157 行 `const loadDir` 之前 → 「文件编辑」Tab 挂载即 `Cannot access
  'loadDir' before initialization`，slot 错误边界清空正文全空白（无堆栈指向源码行，全平台）；且该 ref 无消费者（监听实际
  走 reloadDirRef）= 死代码。规矩：**渲染期 ref 镜像赋值必须放在被引用 const 定义之后**；删 ref 前先 grep 消费方。
- 2026-09-22 坑：发布前仅跑三门不抓组件渲染期错误（tests 全是纯逻辑，无 DOM 渲染测试）——v0.4.5 带着上述回归过全量
  1082 用例照发。**客户端 UI 改动发版前必须真实浏览器冒烟核心入口**（官方侧栏「文件编辑」Tab 打开 + 资源管理器挂载）；
  复现用 chrome-devtools：点侧栏入口卡片 → 看 console 是否 slot entry crashed。
- 2026-09-17 坑：Ctrl+点击「只打开文件不跳转行」的真因在 **EditorView 而非 opener**——跳转/model 同步 effect 用
  `content === null` 当就绪判据，跨文件切换那一帧 content 仍是**上一个文件**的内容（非 null），于是先建 model(A 内容)
  → reveal/setPosition(目标行) 生效 → B 真实内容到达触发 `setValue` → Monaco 重置光标到 1:1，而 pendingFocus 已消费
  → 落点永久丢失（同文件跳转不换内容故不复现，看起来「时好时坏」）。修法：门控一律用 `contentReady`（contentPath === active）。
  诊断法：hook ed 的 onDidChangeModelContent/setValue/setPosition 打时序日志，一条 trace 就能看出顺序错位。
- 2026-09-17 坑：**Monaco `model.getWordAtPosition()` 只返回 `{ word, startColumn, endColumn }`，不含行号**——
  直接把它当 range 透传会产出 `startLineNumber: undefined` 的非法装饰：`deltaDecorations` 正常返回 id、装饰也「挂上了」，
  但 DOM 里查不到该 class（零可见高亮，极易误判为「装饰没生效」）。必须用当前行补齐行号。另：零宽 range
  （start === end，Monaco 原生跳转 `collapseToStart` 后的常态）同样渲染不出任何高亮，需识别为「无区间」并回落到单词/整行。

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
- 2026-09-11 事实：CI 失败时 GitHub API 可能同时 504 不稳定——先等几分钟再取 check-runs；
  实在拿不到就用 `GET /commits/<sha>/check-runs` 的 `/annotations`（无需凭据）直接读失败用例名与断言差异，
  别靠猜。v0.3.3 实测：首 tag 的 build/release 双双 failure，annotations 一次就给出 `tests/skills.test.ts:158`
  的 `'/D:/pkg/skills' !== 'D:/pkg/skills'`。
- 2026-09-14 坑（**新机制，发版前必读**）：npm 已上线 **staged publishing（暂存发布）**——`npm publish`
  可能不再直接上架，而是进入 stage 队列，**需维护者在 npmjs.com 或 `npm stage approve <id>` 用 2FA 人工批准**
  才对外可装（[docs](https://docs.npmjs.com/staged-publishing/)、[changelog](https://github.blog/changelog/2026-05-22-staged-publishing-and-new-install-time-controls-for-npm/)）。
  症状链（v0.4.2 实测）：CI 里 `npm publish` 打印 `+ dsh-vscode-mode@X` **看似成功**，但
  `Verify published tarball` 步骤 15×30s 全部拿不到 → `::error::published tarball ... not retrievable after retries` → job failure；
  重跑则报决定性线索 `409 Conflict - Cannot publish over previously staged version "X"`。
  判别：`npm view <pkg> time` 有该版本时间戳，但 `npm view <pkg>@<ver>` 404、`dist-tags.latest` 未变
  （staged 与已发布共享同一 semver 唯一索引，故不能重复 publish）。
  处置：**这一步只能人工做**——到 npmjs.com 包页面的 stage 队列，或用 npm CLI ≥11.15.0
  （本机 11.6.1 无 `stage` 命令、亦无凭据，`npm whoami` 401）执行 `npm stage approve`。
  **CI 判断成功不能只看 `npm publish` 那一步**：要看最后一个 `Verify published tarball` 步骤；
  该步骤失败 = 版本未真正上线（此时 GitHub Release 与 tgz 通常已正常产出，可先用 Release 分发）。
- 2026-09-15 对照（v0.4.3）：**staged 与 CDN 传播延迟症状相同，别提前判 staged**——`npm publish` 成功后注册表 404、
  `dist-tags.latest` 未变，可能只是传播慢：先等 `Verify published tarball` 走完重试窗口（v0.4.3 实测 **4 分 34 秒**后
  该步骤 success、job 全绿、`dist-tags.latest` 同步 0.4.3）；只有该步骤最终 failure（重跑报 `409 Conflict`）才是真 staged。
- 2026-09-15 第三结局（v0.4.4 实测）：`Verify published tarball` 最终 failure 但版本**已实际发布**——CDN 传播比
  15×30s 重试窗口还慢（本次 ~8.5 分钟仍未可拉、随后可达）；判别：`registry.npmjs.org/<pkg>/<ver>` 返回 **200** 且
  `dist-tags.latest` 已切换 = 已上线，CI 红叉是误报，**勿重跑**（会 `409 Conflict`），用 gitHead 三向对齐闭环即可。
- 2026-09-08 事实：awesome 收录条目（PR #2532，category git）的 `tarball:` 钉在 v0.1.36，发版即过期；
  npm 映射自动、该字段冗余 → 改自己条目时删 tarball 行，勿再钉版本号。
- 2026-09-11 事实：本环境**不必** stash 隔离——当场核对 `git status --porcelain` 全部改动确属本次
  待发布内容后再 `git add -A` 即可（v0.3.2 实测：26 文件全为本会话产物，直接单提交发布）。
  关键前置动作是**逐条核对清单**，而不是无脑 stash。
- 2026-09-11 事实：发布后可用 registry 元数据的 `gitHead` 反证「线上 tarball == 本地提交」
  （`GET registry.npmjs.org/<pkg>/<ver>` → `gitHead` 应等于 release commit SHA）；
  配合 `git ls-remote --tags origin` 与 GitHub Release 的 `assets[].digest` 三向对齐即可闭环。
- 2026-09-11 坑：同一仓库可能被**多个会话并行开发**，`git status` 里混着别人的完整特性（v0.3.3 实测：
  QuickOpen 键盘导航 + 技能组 provider 两份改动同树，且 package.json 的 0.3.3 号码由后者所改）
  → 判据是 **mtime 分簇 + 谁改了版本号 + 该特性自带测试是否全绿**（都满足=可发，而非 WIP）；
  但**发不发别人的特性必须当场问用户**，不能默认 `git add -A` 扫进去一起发布。
- 2026-09-11 事实：发布前确认「线上最新版本」用 registry `dist-tags.latest` + `git ls-remote --tags`
  对照 HEAD，别只看本地 tag（本地 tag 可能落后或超前）。
- 2026-09-09 事实：pnpm 在本环境跑 run 脚本会先做 deps-status check 触发 store SQLite 报错
  （`unable to open database file`）→ 三门直接调 node_modules/.bin（tsc.cmd/vitest.cmd/tsdown.cmd）绕过。

## 差异审查（DiffBox / 旁车）设计口径

- 2026-09-15 坑：`recordIsStale` 对「pending hunk 的 newText 已不在文件中」的记录**不归档**（只置 `conflict=true` 留在待处理列表供复核），
  而单文件 Keep/Undo 原先只认 `pendingRegions`（可定位差异）→ 这类文件恒留在差异栏、按钮置灰，全局 Keep All/Undo All 却是亮的（幽灵条目）。
  规矩：**给某类差异「可见性」时必须同时给「可操作性」**——`canDecideFile(pending, stale)` 决定按钮可用性、单文件决策作用域 = `pendingRegions + staleRegions`、
  host `revertHunk` 定位失败返回 `stale:true` 并由 `applyDecisions` 按「已回滚」记账（不写文件、状态栏提示「N 处已不存在于文件」）。
- 2026-09-15 事实：同一文件被连续/并发 edit 后，先前的 pending 记录会整批变成 conflict（before/after 链断裂、当前内容不等于任一快照）——这是正常现象而非 bug；
  判别某条记录是否真过时：逐条比对 hunk `newText` 在当前内容里的 `indexOf`（原始 + 归一化两种口径），全为 -1 即确属「已被后续修改覆盖」。

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

## DSH 对话输入框（composer）——写内容前必读

- 2026-09-11 坑：composer 有**两套坐标系**且混用会毁数据。`detect` 投影里 chip 只占 **1 个 U+FFFC**，
  `clipboard` 投影里占 `clipboardText` 全文（源码 `$composerLayout`：`pushLeaf('chip', kid, '￼', kid.getTextContent())`）。
  `insertReference/insertText/caretSpan` 全要 **detect 坐标**，而 `state.getSnapshot().draft` 是 **clipboard 投影**。
  拿 `draft.length` 当 detect 偏移 → 有 chip 时越界 → `selectSpan` 返回 null → 插入被拒。
- 2026-09-11 坑：`setDraft(text)` 是**整篇重建**且剔除 U+FFFC（`text.replace(REFERENCE_PLACEHOLDER_RE,'')` + `root.clear()`）
  → 一旦把它当「降级兜底」，就会**销毁用户已插入的全部 chip**并把引用退化成重复纯文本
  （v0.3.2 修的「连续添加多个引用显示异常」即此因）。规矩：降级用 `insertText`（就地替换、保留 chip）；
  两条通道都失败就**一个字节都不写**并回报失败，绝不用 setDraft 兜底。
- 2026-09-11 事实：插入位置用 `caretSpan()`——契约即 detect 坐标、无选区时回落文档末尾的塌缩 span
  （与插入 API 同坐标系，无需换算）；选区非塌缩取 `end` = 插入而非替换，不删用户选中内容。
  缺失/抛异常/非法值一律回落末尾。换算 detect↔clipboard：每个位于该点之前的 chip 多占 `length−1`。
- 2026-09-11 坑：验证 composer 时 **Lexical 不理会合成键盘事件**（`dispatchEvent(new KeyboardEvent(...))`），
  Ctrl+A/Ctrl+End 等都不会生效；移光标/清草稿要用 Selection + Range API，或 Chrome DevTools MCP 的真实按键。

## CI/测试平台陷阱（写测试前必读）

- CI 跑 ubuntu：新测试断言**禁止写死 Windows 反斜杠路径**。`path.join` 结果在 Linux 是 `/`
  分隔，断言前先 `.replace(/\\/g, '/')` 归一再比较（或两侧都用同一构造方式）。
- 2026-09-11 坑（**第二次踩，务必内化**）：`norm()` 归一化只解决反斜杠，**解决了不盘符**。
  `skillsDirOf('file:///D:/pkg/lib/index.js')` 断言 `'D:/pkg/skills'` 在 ubuntu 上得到
  `/D:/pkg/skills`（盘符被当成普通路径段）→ 恒失败，而**本地 Windows 是绿的**。
  规矩：路径类断言**不写死盘符/绝对 URL**——用 `fileURLToPath(new URL('..', import.meta.url))`
  取真实包根，两侧都由同一平台语义构造（`pathToFileURL` 造 URL、`join` 造期望值），
  两平台同时成立且更贴近真实调用。
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
- 2026-09-20 坑（**GUI 拉起绝不能走 `ctx.subprocess.spawn`**）：DSH 在 Win32 走 Windows Job runner，
  其 `launchWindowsJob` 与 runner 内部 spawn **硬编码 `windowsHide: true`**——连 `explorer.exe` 的窗口
  一起隐藏，症状是 `edrv.revealInExplorer` 回 `{"ok":true}` 但**资源管理器窗口根本不出现**（用户报
  「在文件浏览器打开不生效」）。同目录交替 `windowsHide` 实测 4/4 出窗 vs 0/4 不出，`cmd /c start` 与
  `powershell Start-Process` 均无效。修法 = 该路径改 node `child_process.spawn` + `{ stdio:'ignore',
  windowsHide:false, detached:true }`，只等 `spawn` 事件（GUI 进程退出码无意义）后 `child.unref()`；
  契约抽成纯函数 `revealSpawnOpts` 以便单测断言 `windowsHide === false`。
  凡「让 OS 弹窗/拉起外部 GUI」的新功能都要按此自检。
- 2026-09-20 坑：**验证 GUI 是否真弹出**别只看 RPC 返回或进程存在——`windowsHide` 只隐窗口、
  进程照起。判据用 `Get-Process explorer | Where MainWindowTitle`，且 Explorer 对**已打开**的
  同一目录只复用窗口不一定新建，必须挑没开过的目录或先关窗，否则误判「没生效」。
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

## 插件技能组（随包 skills/）

- 2026-09-11 坑：**技能名必须 kebab-case**——`@deepseek-ai/dsh-skill` 的
  `SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/` 是硬校验，**下划线非法**；写 `dsh_vscodemode_mcp`
  会被 `skill-filesystem` 记 `ignored: invalid skill name` 直接丢弃，`ctx.skills.register()`
  则**抛错**。本插件技能组因此用连字符前缀 `dsh-vscodemode-`（注意与 MCP 的 `serverName`
  规则相反：那个 `/^[A-Za-z0-9_-]{1,32}$/` **允许**下划线）。
- 2026-09-11 事实：本插件的技能分发走**自研 provider**（`src/skills.ts` 注册进 `ctx.skills`），
  不用官方 `@deepseek-ai/dsh-skill-filesystem`。原因：profile 以 **junction** 安装本插件，
  Node ESM 按 **realpath** 解析 import，从工作区真实路径出发 walk 不到 profile 的
  `node_modules` —— `node --input-type=module -e "await import('@deepseek-ai/dsh-skill-filesystem')"`
  在包目录下恒 `ERR_MODULE_NOT_FOUND`；官方的 `customSkillDirs` 路子（`@openviking/dsh-memory-plugin`
  那种）需要 dev + peer 依赖 + registry `pnpm install`，且多拉一个 chokidar watcher。
  自研 provider 零依赖、开发/正式形态一致、可直接单测。
- 2026-09-11 事实：技能名冲突（registry 抛错）、`skills` 服务缺失、provider 注册失败都必须
  **降级不致命**——用 `ctx.inject(['skills'], cb)` 惰性获取（**别写进插件 `inject` 数组**，
  否则 skills 缺失时整个插件装载失败），`cb` 内 `sctx.get('skills') ?? sctx.skills` 双读
  （同 `fileOpenSettings.runSettingsInstall` 的写法）。
- 2026-09-11 事实：registry 有**收集缓存**（`collectCache`），provider 自己 parse 不缓存也没用——
  改 SKILL.md 要即时可见必须 `control.invalidate()`；`fs.watch` 的 watcher 挂 `'error'` 处理器
  （EventEmitter 无监听者时抛未捕获异常），并按 `control.signal` 关闭。
- 2026-09-11 事实：`package.json` 的 `files` 必须含 `"skills"`，否则 tarball 漏发 → 技能组恒为空；
  用「读真实 `skills/` 目录自检」的用例兜底。`skills/` 根目录**别放裸 `.md`**（会被当单文件技能解析，
  缺 frontmatter 就刷 `缺少合法 frontmatter` 告警）——约定文档放 README。

## 自我更新协议（技能如何更新自己）

1. **何时更新**：本次会话踩到本文件未记录的新坑（环境/流程/平台/接口），或既有条目已失效
   （API 变更、流程变更）。
2. **如何更新**：直接编辑本文件对应小节，追加一行 `- YYYY-MM-DD 坑：<现象> → <解法>`（一行
   讲完，超过两行说明就压缩）；失效条目改写而非堆叠。更新后把顶部 `> updated:` 改为当天。
3. **边界**：只沉淀会复发的事实与解法，不记录一次性调试过程与猜测；与既有条目重复时不加。
4. **同步**：本文件位于仓库内（`<项目根>/.dsh/skills/`），更新后随常规 commit/push 提交，
   技能内容即随仓库版本化。
