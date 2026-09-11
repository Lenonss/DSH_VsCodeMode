# dsh-vscode-mode

> 原 `@dsh-external/dsh-edit-review`（编辑差异审查）重构而来——DSH 上的**类 VSCode 编码体验**。

仿 VSCode 的 **Agent 文件编辑器 + 差异审查** DSH 插件：

- **侧边栏「文件编辑」Tab**（v0.1.60，推荐）：检测到 **DSH 0.1.5+ 官方右侧 Sidebar**（`ctx.sidebarRightTabs` /
  `ctx.sidebarRight` 服务）时，编辑器注册为官方侧边栏 Tab——**AI 对话（中央）与文件编辑（右侧栏）同屏**，
  类主流 Code Agent 布局；支持官方多标签/分栏/浮出/全屏，打开路由即开即展开；官方 Sidebar 引导页提供入口。
  **优先级**：官方侧边栏与 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 同时可用时**官方优先**
  （better-sidebar 桥已归档，仅作旧版 DSH 回退，不再新增能力）。旧版 DSH（< 0.1.5）沿用 better-sidebar 侧栏形态，
  两者皆缺时回退旧「中央文件编辑页签」形态（插件零新依赖仍完整可用），
  编辑器顶部与设置页「兼容性」子 Tab 会给出对应引导。
  **文件链接（DSH 0.1.5+）**：聊天/文件树的文件链接经官方 `ctx.sidebarRight.openResource` 直达右侧栏——
  「文件链接使用工具」为 自动/VSCodeMode 时本插件以 extension 档认领 `dsh-resource://file/**`（链接在本插件
  Monaco 编辑器打开，含行号定位）；为「官方侧边栏」档时走官方文本查看器（不认领）；畸形地址自动回落官方查看器。
  文件页签（脏点/关闭/「+」打开/**右键菜单/固定**）+ `Ctrl+P` 快速打开（QuickOpen）+ **Monaco Editor**
  （语法高亮/行号/`Ctrl+F`/`Ctrl+G`/`Ctrl+S`/700ms 防抖自动保存）+ 顶部工具栏（路径/语言/Ln,Col/保存状态/差异/侧边栏/刷新）
  + **导航历史**（后退/前进：跨文件恢复焦点位置，工具栏 `←`/`→` 按钮、键盘 `Alt+←/→` 与 `Ctrl+Alt+-`/`Ctrl+Shift+-`、
  鼠标侧键 XButton 均可触发；后退后新导航自动清空前进栈）。
  **页签右键菜单**（对齐 VS Code 分组）：添加到对话 / 关闭·关闭其他·关闭右侧标签页·关闭已保存·全部关闭
  （`Ctrl+F4` 关当前页签）/ 复制路径·复制相对路径 / 在文件资源管理器中显示·在资源管理器视图中显示 /
  固定（📌 排到最前、隐藏 ×、随工作区持久化；**固定 = 保护**，批量关闭永不误关固定页签）。
  关闭前对未保存页签静默落盘；浏览器无法实现的条目（向右拆分 / 移动到新窗口）不提供。
  **引用插入**：`Ctrl+U`（选区）/ 页签右键 / 文件树右键 都走同一条 `appendReference`，
  按 **detect 投影**坐标插入 chip，插入点跟随**输入框当前光标**（`caretSpan()`；无光标信息时回落文档末尾，
  选中区域则插在选区右边界而不替换）（修掉「连续添加多个引用时既有 chip 被销毁并重复为纯文本」）；
  通道被拒时降级为就地纯文本（保留既有 chip 与正确分隔空格），两条通道都不可用则**不写任何内容**并提示重试。
- **命令栏 + 指令系统**（v0.2.0）：`Ctrl+Shift+P`（或 `F1`）唤出 VS Code 式命令面板——输入即过滤（中文/分类/命令 id
  均可命中）、`↑↓` 选择、`Enter` 执行、`Esc` 关闭，每行显示命令名/分类/当前键位；候选按**可用性**过滤
  （需要打开文件的命令在空编辑器时自动隐藏）。命令目录即单一数据源（`ui/commandCatalog`）：命令栏、快捷键设置页、
  全局键位派发、Monaco 右键菜单全部从同一张表读取，**新增一条能力只需追加一条命令定义**。
  注册表经 `window.__edrvCommands__` 对外暴露，第三方/控制台可 `register()` 注册命令、
  `addRuntimeKeybinding()` 绑运行时键位（不落设置 schema）。开箱 19 条命令：
  保存 / 快速打开 / 在文件浏览器中打开 / 显示所有命令 / 切换侧边栏 / 工作区搜索 /
  后退·前进 / 上下页签 / **关闭当前页签** / 上下编辑行 / 转到定义 / 查找引用 / 触发 AI 补全 /
  配置代码片段 / 插入代码片段 / 选中内容加为引用。
- **代码片段**（v0.3.0，VS Code 兼容 `.code-snippets`）：`Ctrl+Shift+P` → 「代码片段：配置代码片段」
  打开**居中浮窗**（现有片段文件列表 + 新建入口），选文件后在 Monaco 编辑器中按普通文件编辑
  （JSON 高亮 / 保存即生效 / 支持 `scope` 字段）。片段库分**全局**（`~/.dsh/snippets/`，所有项目生效）
  与**项目**（`<工作区>/.dsh/snippets/`，随仓库共享）两处；文件名即语言
  （`lua.code-snippets` → 仅 lua 文件生效，`global.code-snippets` → 全语言），
  新建时可选生效语言。编辑 `.lua` 等文件时，前缀（`prefix`）经 **IntelliSense 补全**列出
  （片段图标 + `body` 预览，`Tab`/`Enter` 展开，`$1`/`${2:默认值}` 占位符与 `$TM_*` 变量可用）；
  也可 `Ctrl+Shift+P` → 「代码片段：插入代码片段」按语言筛选后插入到光标处。
  文件列表/读取/保存经 RPC `snippets.list/read/save/remove/entries`；保存后自动刷新补全缓存。
- **快捷引用**（v0.3.0，v0.3.1 修复可用性判定）：编辑器中选中内容后 `Ctrl+U` 把选中行范围加为**引用**
  （送入对话上下文，等价 VS Code 的「Add Selection to Chat」）。无编辑器/无选中时该键位**不吞键**，正常输入不受影响。
  ⚠️ v0.3.0 因编辑器可用性探测选择器 `textarea.inputarea` 被 Monaco 的 **EditContext** 输入通道取代
  （有该 API 的浏览器下 Monaco 不再创建 textarea），导致本命令与其它 12 条 `needsModel` 命令被静默隐藏、
  按键被放行；v0.3.1 已改为与输入实现无关的判据（`.edrv-editor-row .monaco-editor`）。
- **LSP 智能（编辑器内）**：`F12`/右键「转到定义」+ `Shift+F12`「查找所有引用」+ `Ctrl+点击` 引用导航
  （0 条→定义兜底、1 条→直接跳转、多条→原生 References Peek）+ `Ctrl+hover` 可导航标识符下划线提示；
  定义查找带降级链（definition → declaration → 引用推导），参数/局部变量（`this`、`pTarget` 这类）
  同样能跳到声明，不再只有方法可用。
- **差异审查**：Host 捕获 agent 的 `edit`/`write`（`tools/result`），客户端统一使用**唯一一个挂在 DSH `conversation.input.dock` 的 DiffBox 实例**：
  编辑器未打开时显示紧凑「差异 N 个文件 · 查看下一个」按钮（点击自动打开侧栏编辑器并聚焦差异）；编辑器打开后 dock 切换为
  完整操作条（Keep / Undo / 跳转 / 回滚 / 归档对比），不会再出现第二个差异栏。header 差异角标 +
  DiffLauncher 全局总览 + 归档/批次回滚；状态持久化到工作区旁车（`.dsh-edit-review.json`，重启不丢）。
- **Monaco 离线分发**：`assets/vendor/monaco` AMD 构建随包发布，经 `/edrv/vendor/*` 前缀路由提供，全离线可用。
- **PDF 浏览与编辑**（v0.1.55，借鉴开源 [pdf.js](https://github.com/mozilla/pdf.js)，Apache-2.0）：
  打开 `.pdf` 文件在编辑区页签内直接浏览（连续滚动/翻页/缩放/文本选择，cmaps 支持中文渲染）；
  工具条进入注释编辑：✎ 文本框 / 🖌 画笔 / 🖍 高亮，`Ctrl+S` 或 💾 保存把批注写回原文件
  （`pdfDocument.saveDocument()` → `edrv.saveBinary` base64 回写，工作区边界 + 32MB 上限约束）。
  引擎离线 vendor 于 `assets/vendor/pdfjs`（build + viewer 组件 + cmaps + standard_fonts，约 5MB），
  与 Monaco 同模式经 `/edrv/vendor/pdfjs/*` 分发；升级版本用 `node scripts/vendor-pdfjs.mjs [版本]`。
  能力边界：注释级编辑（浏览器开源方案不支持无损改写既有正文文字）；加密 PDF 暂不支持。
- **文件管理侧边栏**（类 VSCode 活动栏 + 面板）：编辑器内嵌活动栏 + 可拖拽调宽的面板区；首期「资源管理器」= 懒加载目录树
  （展开目录实时读取、点文件在编辑器打开、差异角标、活动文件高亮、`edrv:refresh`/手动 ⟳ 刷新、`Ctrl+B` 显隐并持久化；
  侧栏形态默认收起以节省面板宽度；拖拽调宽下限 = 最小宽度（默认 300，设置 → VSCodeMode → 通用「编辑器」可调 180–560），
  拖拽低于最小宽度自动收起）。面板通过注册表装配（`ctx.provide('edrvSidebarPanels')`），新增面板只加一条注册，不改编辑器布局。
- **规则管理**（v0.1.49 初版 / v0.1.50 交互优化，参考 Codebuddy）：活动栏「规则」面板，管理 Cursor/Codebuddy 式 `.mdc` 规则文件——
  「用户规则」（`~/.dsh/rules/`，全局生效）与「项目规则」（`<工作区>/.dsh/rules/`，随仓库共享）双 Tab；
  每条规则显示文件名/相对路径，第二行类型徽标（总是=`alwaysApply`、自动=`globs`、手动=仅索引）与描述，
  右侧常驻 编辑/删除 图标与滑动启用开关（行 hover 高亮；开关只改写 frontmatter `enabled` 行，即时生效无需重启）；
  描述随面板宽度自适应截断（保底 8 字），面板宽 < 420px 自动隐藏路径提示。
  新建/编辑提供面包屑头部 + 规则类型下拉（总是/自动/手动）与 描述/globs 控件，与原始 `.mdc` 文本域双向同步
  （控件改写 frontmatter，文本域回读控件；`enabled` 与其余键原样保留）。启用的规则经 host `systemPrompt.section`（order 400）
  注入每次装配：用户规则全局注入，项目规则按会话工作区注入（单条 16KB/单域 64KB 截断预算；旧版 DSH 无 systemPrompt
  服务时自动降级为纯管理 UI）。RPC：`rules.list/read/save/remove/toggle`。
- **MCP 可视化管理**（设置 → VSCodeMode）：子 Tab「我的 MCP」（profile 全局）+「项目 MCP」（各项目根 `.mcp.json`）。
  项目级 MCP 对齐 Claude Code/Cursor：配置存于项目根目录 `.mcp.json`（`mcpServers`），随仓库共享；
  可查看各项目连接状态/工具、添加（stdio / streamable-http）、刷新、启用/禁用、删除。工具全局生效。
- **会话性能管理**（设置 → VSCodeMode →「性能优化」）：DSH 启动会回放 `~/.dsh/sessions` 全部会话
  （V8 展开约 10×，会话越多越吃内存，可能 OOM）。该子页提供
  ① 全工作区会话盘点（体积/活跃度/新旧）；② 巨型/旧会话**移出到归档**（`~/.dsh/sessions-archive`，可逆、
  免重启即从下次启动的回放中剔除）与恢复/清除；③ **DSH 内置压缩调优**：一键把更低的
  `compaction-basic`/`tool-result-pruner` 阈值写入 profile `cordis.patch.yml`（带备份与撤销，重启生效）；
  ④ 侧车摘要接口指引。对话 header 另有**会话体积指示器**（`edrv-perf-size`，≥1MB 显示、超 2MB 琥珀、超 8MB 红），
  引导"一次任务一个短会话"。
- **系统集成**（v0.1.53，设置 → VSCodeMode → 通用「系统集成」卡片）：
  ① **文件管理器右键菜单**——一键把「在 DSH 文件编辑中打开」注册进系统（Windows 资源管理器三类入口 / Linux
  Nautilus+Dolphin / macOS Automator 配方），插件卸载自动清理、更新自动恢复；点击经 launcher 打开默认浏览器深链
  `?edrvOpen=1&edrvPaths=…`，编辑器直接打开所选文件；DSH 未运行时弹提示。
  ② **Unity 外部脚本编辑器**——内置 UPM 包 `com.dsh.editor`（参照 com.unity.ide.traeCN 机制实现
  `IExternalEditor` 虚拟安装，无需本地 exe），设置页**一键安装/更新**为 Unity 内嵌包
  （复制到 `<项目>/Packages/com.dsh.editor`，自动发现，不改 manifest.json），Unity Preferences →
  External Tools 下拉选「DSH 文件编辑」后，双击脚本/Console 报错跳转即在浏览器打开对应文件与行列。

## 界面截图

![侧边栏编辑形态：AI 对话与文件编辑同屏](docs/screenshots/img1.png)

> dsh-vscode-mode 侧边栏编辑形态：右侧栏（DSH 0.1.5+ 官方 Sidebar / 旧版 betterSidebar）内的
> Monaco 文件编辑器与中央 AI 对话同屏，
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
├── rules.ts            Host 规则管理：.mdc 解析/开关改写/注入渲染（纯函数可单测）+ IO + systemPrompt section 装配
├── rpc.ts              Host RPC 分发表（类型化 handler 表替代巨型 switch，含 compat）
├── routes.ts           Host webServer 路由（/edrv/rpc、/edrv/assets/*、/edrv/vendor/*，带冲突护栏）
└── client/
    ├── index.ts        Client 入口：slot 注册（inject=['slots','timer']）；官方/betterSidebar/中央页签三形态互斥分流（官方优先）
    ├── compat.ts       ★ Client 兼容层：设置桥三级降级（webUiSettings→settingsScope）、slot 安全注册、openPath 链式补丁、外部插件常量
    ├── sidebarBridge.ts ★ 侧边栏编辑区桥（归档）：可选探测 ctx.betterSidebar、注册「文件编辑」Tab、打开路由/角标计数（纯函数可单测）
    ├── officialSidebar.ts ★ 官方右侧 Sidebar 桥（DSH 0.1.5+，唯一维护面）：探测 sidebarRightTabs/sidebarRight、
    │                   两段式注册（类型定义 + keyed slot 正文）、openTab 路由（纯函数可单测）
    ├── rpc.ts          Client 类型化 fetch 包装 + 诊断日志
    ├── events.ts       窗口事件助手（edrv:refresh/open-editor/show-launcher；侧栏路由优先、旧页签回退）
    ├── state/          records.ts（摘要/计数/空差异）+ regions.ts（差异区域/行裁剪）纯函数
    ├── monaco/         loader.ts（AMD 加载/语言映射）+ diffRender.ts（差异自绘渲染器）
    ├── pdf/            pdfLoader.ts（pdf.js vendor 产物 module-script 加载）+ pdfPanel.ts（PDF 面板控制器：
    │                   PDFViewer 接线/注释编辑模式/saveDocument 保存回写）
    ├── pdfPreview.ts   PDF 判定与 base64 编解码纯函数（可单测）
    ├── imagePreview.ts 图片判定与 data URL 纯函数（可单测）
    ├── diffDock.ts     差异 dock 轮转/文案/形态纯函数（对话 dock 与 DiffBox 共用）
    ├── sidebar/        ★ 侧边栏面板系统：registry.ts（注册表，镜像 fileOpeners）+ SidebarView.ts（活动栏/面板区/拖拽调宽）
    │                   + types.ts（SidebarPanelDef/SidebarCtx）+ panels/FileExplorer.ts（文件树面板 #1）
    │                   + panels/SearchPanel.ts（搜索面板）+ panels/RulesPanel.ts（规则面板：用户/项目规则 + 开关）
    ├── styles/editor.css  编辑区样式（tsdown CSS-inline 注入；含侧栏形态/引导条）
    └── ui/             EditorView（编排，tab/side 双形态）/ OfficialSideTab（官方 Sidebar Tab 包装）
                        / SideEditorTab（betterSidebar Tab 包装，归档）/ QuickOpen
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
- **Client 挂点**：官方右侧 Sidebar Tab（DSH 0.1.5+：类型定义 id `dsh-vscode-mode`、kind `edrvEditor`，
  正文挂 keyed slot `sidebar.right.pane.tab`；优先级最高）> betterSidebar Tab `edrv-editor`（归档，仅旧版回退）
  > `conversation.view` 页签（id `edrv-editor`）+ `conversation.session.header.utilities`（id `edrv-diff-badge`）+ `conversation.input.dock`
  （id `edrv-diff-dock`，唯一差异栏：编辑器未打开=紧凑按钮，打开后=完整操作条）。内部路由/slot/事件/CSS 前缀沿用 `edrv-*`（防回归），包身份为 `dsh-vscode-mode`。
- **⚠️ Host 改动需重启 DSH 应用**（Node ESM 模块缓存）；Client 经 `dsh-client-hmr` 热重载。

## 会话性能（性能优化）

DSH 每次启动都会回放 `~/.dsh/sessions` 下全部会话（`session-persistence-jsonl` 逐行 parse 并驻留为 JS 对象，
V8 展开约 10×）。会话越多越大，启动内存越高，可能冲爆堆（OOM → bundle 加载失败）。本插件的「性能优化」子页
（设置 → VSCodeMode）治理这个问题：

- **盘点**：`edrv.perf.inventory` —— stat 全部工作区会话（不解压），按体积/工作区聚合，标记活跃会话。
- **移出到归档（可逆）**：`edrv.perf.movePlan`（先规划）+ `edrv.perf.moveOut`（确认后执行，逐项失败回放）把会话目录
  从 `~/.dsh/sessions` 搬到 `~/.dsh/sessions-archive`（同卷 rename，写 `.manifest.json`）；`edrv.perf.restore` 恢复；
  `edrv.perf.purgeArchive` 清除归档区早于 N 天的会话。活跃会话一律拒绝移出。移出即从下次启动回放中剔除——这是
  对存量 95MB 级会话**立刻见效**的手段。
- **压缩调优**：`edrv.perf.configApply` 把 `compaction-basic`（thresholdRatio 0.6 / retainRatio 0.12）与
  `tool-result-pruner`（thresholdChars 4096）写入 profile `cordis.patch.yml`（标记块 + 备份 `.bak-<ts>`，可撤销），
  长循环会话更早压缩、降低模型上下文压力。⚠️ 压缩只追加 `compaction/*` 事件、**不重写**已持久化日志（append-only），
  因此它不缩小会话文件——存量瘦身靠「移出到归档」。
- **会话体积指示器**：对话 header 的 `edrv-perf-size` 每 5s stat 当前会话持久化体积（近零成本），≥1MB 显示、
  ≥2MB 琥珀、≥8MB 红，提示 `/compact` 或新开会话，从使用习惯上引导"一次任务一个短会话"。
- **侧车摘要**：`edrv.perf.sidecarSummary` 返回 `.dsh-edit-review.json` 的关键字段（活跃记录数/每文件 pending/归档体积），
  agent/脚本取摘要即可，**不要**整份 read/write 该大 JSON 进对话。差异列表本身请走 `edrv.list`。

> 治理原则：存量靠「移出到归档」；增量靠「压缩调优 + 短会话习惯 + 体积指示器」；packChunks（chunk 打包存储）为
> DSH 默认开启，无需再配置。

## 系统集成（Windows 右键菜单 + Unity 外部脚本编辑器）

设置 → VSCodeMode → 通用 →「系统集成」卡片。深链契约（launcher / Unity 包 / client 三端共用）：
`http://127.0.0.1:3080/?edrvOpen=1&edrvPaths=<enc1>[,<enc2>…][&edrvLine=N][&edrvColumn=M]`
（每段路径独立 `encodeURIComponent`，逗号连接；client 解析后按下方「打开规则」路由，处理完剥离参数防刷新重开，
跨源 referrer 守卫防外部网页诱导）。

### 打开规则（智能路由）

按首路径类型分派（其余路径：文件进编辑器、文件夹补引用）：

| 场景 | 行为 |
|---|---|
| **文件夹** 且位于某已注册工作区内 | 页面内弹窗二选一（同「添加 MCP」模态）：**使用最近的工作区** = 跳转该工作区 + 新增对话 + 添加文件夹引用 + 打开文件编辑页；**新建工作区** = 以该文件夹注册新工作区 + 新增对话 + 引用 + 编辑页；取消则中止 |
| **文件夹** 不在任何已注册工作区 | 不弹窗，直接以**该文件夹本身**为根注册新工作区 + 新增对话 + 文件夹引用 + 编辑页 |
| **文件** 且位于某已注册工作区内（工作区亲和） | 该工作区**有会话** → 打开其最近一次对话 + 编辑器展开该文件（行列透传）；**无会话** → 在该工作区**新建对话** + 添加文件引用 + 编辑器展开 |
| **文件** 不在任何已注册工作区 | 打开最近一次对话 + 文件编辑器展开该文件 |
| **文件** 且无任何工作区/对话 | 以文件父目录注册工作区 + 新增对话 + 添加文件引用到对话 + 编辑器打开该文件 |

**页面复用**：launcher 先向 host 投递待打开请求（`edrv.external.handoff`）——已打开的 DSH 页面
（3s 移交轮询）就地执行打开规则，**不重复开新页**；2s 未领取（页面刚关/后台节流）或无活跃页面时
回退打开新页（URL 深链）。

时序：等待会话/工作区列表就绪（≤15s）；`sessions.create/workspaces.create` 为 DSH 官方服务方法
（与 New Session 同路径）；引用插入轮询输入门面就绪（忙态自动降级纯文本）。

### 文件管理器右键菜单（Windows / Linux / macOS）

- **Windows**：launcher 源 `assets/shell/dsh-open.cs` 复制到 `~/.dsh/dsh-vscode-mode/shell/` 并用 .NET Framework 4.x
  `csc.exe` 编译为 `dsh-open.exe`（WinExe 无闪窗；csc 缺失自动降级 `dsh-open.ps1`）；随后写三类 HKCU 键
  `HKCU\Software\Classes\{\*,Directory,Directory\Background}\shell\DSHEditor`（显示名 + Icon（DSH 小鲸鱼
  `dsh-whale.ico`）+ command，首次注册前 `reg export` 备份到安装目录）。全部 reg/csc 调用走 host
  `subprocess.spawn` argv 数组（stdio `inherit`，受管环境禁管道），无 shell 插值。
- **Linux**（纯文件写入，无需管理员）：GNOME Files（Nautilus）右键脚本
  `~/.local/share/nautilus/scripts/在 DSH 文件编辑中打开`（`NAUTILUS_SCRIPT_SELECTED_FILE_PATHS` 多选）+
  KDE Dolphin 服务菜单 `~/.local/share/kio/servicemenus/dsh-editor.desktop`（兼容旧 `kservices5/ServiceMenus/`，
  `%F` 多选）；其他文件管理器暂未支持。
- **macOS**：Finder 菜单不做自动生成——设置页「复制 Automator 配方」按步骤创建快速操作（约 1 分钟，脚本指向
  `~/.dsh/dsh-vscode-mode/shell/dsh-open.sh`），创建后面板自动检测显示 ✓；「移除注册」仅删除引用本插件
  launcher 的 workflow。
- **行为**：launcher 读同目录 `dsh-open.ini`（`base=<深链基址>`，注册时按设置写入）→ 探测端口（Windows TcpClient /
  POSIX curl，1s）→ 未运行弹提示（MessageBox / osascript / notify-send / zenity）→ 把路径编码合并为一个 URL
  交给默认浏览器（POSIX 侧 `LC_ALL=C` 逐字节 percent-encode，中文/空格/任意字符安全）。改「DSH 服务地址」后点「注册」刷新 ini。
- **生命周期**：注册成功写 marker（`shell/registered.json`）→ 插件卸载/reload 自动清理注册痕迹，重启/更新后自动恢复
  （开发态反复 reload 不丢注册）；点「移除注册」删除 marker，此后不再自动恢复；强杀进程跳过清理时残留键会被
  下一次启动的幂等重写与「移除注册」兜底。
- RPC：`edrv.integration.status / register / unregister`。

### Unity 一键安装 / 更新（内嵌包）

- 包源随插件分发于 `unity/com.dsh.editor/`（UPM 包：`package.json` + `Editor/DshCodeEditor.cs` +
  `Editor/com.dsh.editor.asmdef`，`"unity": "2019.4"` 基线；机制参照 com.unity.ide.traeCN 的
  `IExternalCodeEditor`：虚拟安装 `dsh-editor://vscode-mode`，`OpenProject` → `Application.OpenURL(深链)`，
  不需要本地可执行文件，不生成 csproj）。
- **打开过滤**：Unity 对双击的任何资产（含 prefab/scene）都会回调 `OpenProject`；仅文本/代码类扩展名
  （白名单 + Project Settings 用户自定义扩展 `EditorSettings.projectGenerationUserExtensions`）交 DSH
  打开，其余返回 `false` 交还 Unity 原生处理（双击预制体进预制体模式、双击场景开场景），对齐官方
  `DefaultExternalCodeEditor` 行为。
- **一键安装/更新**：设置页登记 Unity 项目根（校验 `Assets` + `ProjectSettings` 特征）后，点「安装/更新」把包源
  整目录复制为 `<项目>/Packages/com.dsh.editor`（Unity **内嵌包**自动发现，无需改 manifest.json）；更新 = 整目录
  替换，列表显示已装版本与「可更新」徽标；目标已存在且 `package.json` name 不是 `com.dsh.editor` 时拒绝覆盖。
  Unity 已打开时切回窗口自动刷新生效。卸载 = 删除该目录。
- 手动兜底：Package Manager → Add package from disk 选 `unity/com.dsh.editor`（面板「复制包源路径」）。
- RPC：`edrv.unity.list / add / remove / install`；登记清单存 `~/.dsh/dsh-vscode-mode/unity-projects.json`。
- 安全说明：深链可在编辑器中查看任意绝对路径文件（与用户手动打开等价）；保存仍受会话沙箱 `policyOf` 约束，
  工作区外保存被拒是预期行为。

## 开发 / 卸载（超级模组注入器，开发期可选）

- 热装配：`dev_install_package {dir: packages/dsh-edit-review}`；更新：`dev_reload_package {packageName: "dsh-vscode-mode"}`
- 卸载：`dev_uninject_plugin {match: "dsh-vscode-mode"}`（生产环境用 `dsh plugin remove`）
