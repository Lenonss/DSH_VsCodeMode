# 任务：给 dsh-vscode-mode 加「测试验收」侧栏页签，并把验收规则改由面板管理

仓库：`D:\Work\ToolsDev\DeepSeekHarnessPlugin\packages\dsh-edit-review`（插件 `dsh-vscode-mode`，web profile 已 `link:` 到本仓库，改完 `npm run build` + 插件管理器关/开 `include:dsh-vscode-mode` 即生效）

## 背景

`/test-check` 测试验收模式上一轮已经做完：命令进模式、底部 chip 显示 `验收 x/y`、文件编辑里有验收单页签、AI 用 `test_check_report` 上报、`test_check_finish` 导出 `docs/acceptance-<id>.html`。现在补一个左侧栏页签「测试验收」（和「文件管理 / 搜索 / 规则 / SVN 变更 / 调试」并列），把说明、专属技能、项目测试规范三块内容放进去，并**删掉上一轮演示用的 `.dsh/test-check/policy.md`**——规则改由面板维护。

## 先读这些（照已有做法，不要另起炉灶）

- `src/client/sidebar/types.ts`：`SidebarPanelDef { id, title, icon, order, badge?, visible?, render(ctx) }` 与 `SidebarCtx`
- `src/client/sidebar/panels/index.ts`：`createFilePanel` / `createRulesPanel` / `createSvnPanel` / `createDebugPanel` 的写法（图标、order、徽标、visible 守卫）
- `src/client/index.ts` 约 521–530 行：`ctx.provide('edrvSidebarPanels', …)` 与 `sidebarPanels.register(createXxxPanel())` 注册位
- `src/client/ui/icons.ts`：官方图标跨版本出口；图标集里没有的，自己写内联 SVG（不要硬编码某个官方图标名）
- `src/client/ui/ModalShell.ts` + `PromptDialog.ts`：浮窗统一外壳（`createPortal` + 根节点 `data-edrv-view` + `.vsm-mcp-dialog` + Esc/遮罩关闭 + z-index 阶梯 190/195/197/200）
- `src/client/sidebar/panels/RulesPanel.ts`：面板的加载/保存/错误/空态/按钮写法参考
- `src/testCheckStore.ts`（`projectRootOf`、导出、事件目录）、`src/testCheckPolicy.ts`（`policyPathOf` / `policyOverlayOf` / `resetPolicyCache`，同步读 + mtime 缓存）、`src/testCheckGuidance.ts`（规则段拼装）、`src/testCheckMode.ts`（规则段注入位）
- `skills/dsh-vscodemode-test-check/SKILL.md`：专属技能正文（随插件走）
- `tests/testCheck*.test.ts`：既有 100+ 用例，别破坏

## 要实现的东西

### 1. 侧栏页签

- `id: 'testcheck'`，`title: '测试验收'`，`order: 21`（规则 20 与调试 22 之间），无徽标、无 visible 守卫（始终可见；没工作区时面板内提示）。
- **专门图标**：新写一个内联 SVG 组件 `IconTestCheck16`（16×16、`stroke="currentColor"`、`fill="none"`、`strokeWidth 1.2`、`aria-hidden`），形状体现「清单 + 勾」；放在新面板文件顶部导出，不依赖官方图标命名差异。
- 面板不 lazy 加载（体积小），在 `src/client/index.ts` 的注册序列加一行：`ctx.effect(() => sidebarPanels.register(createTestCheckPanel()), 'vscode-mode: sidebar panel testcheck')`。
- 面板文件：`src/client/sidebar/panels/TestCheckPanel.ts`。

### 2. 面板三块内容（自上而下）

**(a) 使用说明（二级入口）**：标题行右侧一个「!」图标按钮，点开 `ModalShell` 浮窗讲清：`/test-check 任务` 进模式、底部 `验收 x/y` chip、验收单页签、`test_check_report` 必填 `item/status/summary`、状态口径（无证据的 pass 不算通过、改过文件变需复验）、`test_check_finish` 导出并退出、`stay: true` 保留。文案写成常量，便于以后改。

**(b) 专属技能（只读，二级入口）**：一行「专属技能 `dsh-vscodemode-test-check`（只读，随插件版本更新）」+「查看」按钮 → `ModalShell` 浮窗里用 `<pre>` 展示 skill 正文，提供「复制」。内容来自下面的新 RPC，**不在客户端写死**。

**(c) 项目测试规范（最重要）**：
- 默认内容来自新文件 `src/shared/testCheckPolicyDefault.ts` 导出的 `DEFAULT_TEST_POLICY`：6~10 条**通用**规则（跑什么测试、证据写什么、不许口头通过、真机行为怎么算），不含本仓库私有路径。
- 等宽 textarea 编辑 + 「保存」+「重置」；状态行显示「当前使用默认规则」或「已保存到 `<项目根>/.dsh/test-check/policy.md`」。
- **保存空文本 = 删除 policy.md，回到默认**（不要写一个空文件）；「重置」也是删文件并回填默认内容。
- 保存成功后提示「下一条消息起生效」。
- 没有工作区（`ctx.cwd` 为空）时禁用编辑并提示原因，不报错。

### 3. 新增 RPC（host）

| 方法 | 入参 | 出参 |
| --- | --- | --- |
| `edrv.testCheck.policy.get` | `{ sessionId? }` | `{ ok, path, text, isDefault }` |
| `edrv.testCheck.policy.save` | `{ sessionId?, text }` | `{ ok, path, text, isDefault }` |
| `edrv.testCheck.policy.reset` | `{ sessionId? }` | `{ ok, path, text, isDefault }` |
| `edrv.testCheck.skill` | `{}` | `{ ok, name, path, content }` |

- 都走 `resolveScope` 取会话工作区；写盘目标只能是 `<项目根>/.dsh/test-check/policy.md`，不允许任意路径。
- `text.trim()` 为空 → 删除文件（`isDefault: true`）；否则写 UTF-8（LF）+ `isDefault: false`。
- **保存/重置后必须让 `policyOverlayOf` 的 mtime 缓存失效**（调 `resetPolicyCache()` 或按路径失效），否则同一条消息里看不到新规则。
- skill 正文用 `skillsDirOf(import.meta.url)` 定位 `skills/dsh-vscodemode-test-check/SKILL.md`；文件缺失时返回 `ok:false` 可读原因（面板显示提示，不要白屏）。
- 在 `src/shared/rpc.ts` 加方法与 `RpcOkMap` 载荷，`src/rpc.ts` 的 `checkHandlers` 里补 handler。

### 4. 规则段拼装调整

`policyOverlayOf(root)` 现在的语义是「文件存在就用文件」；改成：

- 文件存在且非空白 → 用文件内容；
- 文件缺失 / 空白 → 用 `DEFAULT_TEST_POLICY`。

规则段仍是「内建操作规则 + `### 项目测试规范` + 内容」，首句 `The following instructions apply only while test-check mode is active.` 不动。

### 5. 技能改写（只讲工具用法）

改写 `skills/dsh-vscodemode-test-check/SKILL.md`：

- 只保留工具/命令用法：进模式与退出、chip、页签、`test_check_report` 的参数与必填、状态取值、`test_check_finish` 与 `stay`、目录约定（`items.json`、`events/`、导出路径）、状态口径（无证据 / 需复验）。
- **删掉「怎么改规则」那一节**（已由面板负责），不写任何本仓库私有路径的示例。
- 保持 frontmatter（`name` 必须 `dsh-vscodemode-test-check`）与「随插件版本更新」的定位：用户私有要求一律进面板，不进技能。

### 6. 清理

删除 `.dsh/test-check/policy.md`（上一轮演示文件）。删后默认规则仍生效，面板状态显示「默认」。

## 约束

- 码风按 `~/.dsh/rules/personal-code-style.mdc`：方法署名 `ddj 2026年11月26号`、自定义方法名 ≤17 字符、region 分区、类型标注完整、集合选型说明。
- 不改官方 `dsh-plan-mode` / `dsh-client-ui-plan`；`/plan`、`/html-plan`、`/test-check` 现有行为不变。
- 测试只跑受影响范围：新增 `tests/testCheckPolicyRpc.test.ts`、`tests/testCheckPanel.test.ts`（纯逻辑），既有 `tests/testCheck*.test.ts`、`tests/htmlPlanMode.test.ts`、`tests/planBridge.test.ts` 必须继续绿。
- 本机命令（沙箱下 npm 的管道会被拒，直接跑二进制）：
  - 类型检查：`node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
  - 测试：`node node_modules/vitest/vitest.mjs run tests/<文件…>`
  - 构建：`npm run build`
- 源码用 write/edit 工具，不用 shell 重定向；行尾 LF，不要引入 CRLF。
- 浮窗必须走 `ModalShell`，不要自造遮罩；样式加到 `src/client/styles/editor.css`，选择器以 `[data-edrv-view]` 作用域；`.edrv-testcheck-chip` 那组 composer 样式不要动。

## 测试点清单

- policy：无文件→默认；保存→落盘且 `isDefault:false`；保存空白→删文件回默认；重置→删文件；无工作区→`ok:false` 可读原因；路径固定不可注入。
- skill：读到正文（含 frontmatter 之后的章节标题）；文件缺失→可读错误。
- 规则段：默认规则出现；自定义覆盖；拼装顺序（内建在前、项目规范在后）。
- 面板纯逻辑：`isDefault` 的状态文案、空文本禁用保存。

## 验收标准

1. 左侧栏出现「测试验收」图标（专属 SVG），点击展开面板，样式跟随主题。
2. 「!」浮窗说明；Esc 与点遮罩都能关。
3. 「查看技能」浮窗内容与 `skills/dsh-vscodemode-test-check/SKILL.md` 一致，可复制，不可编辑。
4. 面板默认显示通用规则；改成自定义保存后，`.dsh/test-check/policy.md` 出现，**下一条消息**规则段末尾就是保存的内容（可让 AI 复述一行验证）。
5. 清空保存 → 显示默认；「重置」→ 默认；手动删除文件 → 默认。
6. 无工作区会话打开面板：禁用编辑并说明原因，不报错。
7. `typecheck` 0 error、`build` 通过、受影响测试全绿；`/plan`、`/html-plan` 行为不变。

## 容易踩的坑

- host 读 policy 是**同步 + mtime 缓存**：保存/重置后不失效缓存，同一会话看不到新规则。
- `.dsh/test-check/.gitignore` 内容是 `*`，`policy.md` 默认不进库；面板里可以加一行说明（团队要共享就加 `!policy.md`）。
- 规则段文本回调是**同步**的，读盘别改成 async。
- `panels/index.ts` 是 `// @ts-nocheck` 的历史文件，新面板文件不要跟着关类型检查。
- 侧栏在旧宿主没有 slots/provider 时静默不出现是既有行为，不要为此加兼容分支或兜底 UI。
