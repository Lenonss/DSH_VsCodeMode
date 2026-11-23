# 0.33.0 — DSH 0.2.3 适配、官方 MCP 托管与审阅注解、非 UTF-8 文本兼容

日期：2026-11-23　基线：`@deepseek-ai/dsh@0.2.3-alpha.2`（`cordis` 4.2.0-alpha.1）
上一版：v0.31.0（`2ef6f44`）

## 背景

这一版把工作区里攒下的几批改动一起发。其中 0.32.0 只写了草案（`docs/release-0.32.0.md`），
没有单独发版，内容随本版一起上线。

1. **升级 0.2.3 后插件整体不可用**：`/edrv/rpc`、`/edrv/vendor/*` 全部 503，响应体是插件自己写的
   「Host authentication service unavailable」。实测根因：0.2.3 移除了 `connection.requestRejection`，
   路由授权改由框架执行，插件的自建闸门把所有请求判成拒绝。
2. **两处静默失效**：`openPath` 从客户端 `workspaces` 移到 host 侧 `remote.session`；新版 cordis 把根上下文
   从 `ctx.root` 改存 `Symbol.for('cordis.root')`，继续读普通属性会直接让入口激活失败。
3. 顺带把官方新开的两个扩展面用起来（`ctx.mcpManager` 托管、变更视图行级注解），并处理一类老问题：
   打开非 UTF-8 文件只看到乱码。

## 改动

### 一、DSH 0.2.3 兼容

| 文件 | 改动 |
| --- | --- |
| `src/httpGuard.ts` | `admitRoute` 只做方法校验；旧宿主有 `requestRejection` 时沿用原闸门；新增 `routeAuthMode()` |
| `src/routes.ts` | 路由注册显式 `auth: 'required'`，由框架授权后才进 handler |
| `src/dshVersion.ts` | 新增 `detectVersionLive()` / `versionSourceOf()`：优先运行时版本，失败回落包版本嗅探；`familyLabel` 增 0.2.2 / 0.2.3 线 |
| `src/compat.ts` | 兼容报告新增「版本来源」「路由授权归属」两行 |
| `src/hostRoot.ts`（新） | 根上下文按 `Symbol.for('cordis.root')` 取，兼容旧 `ctx.root`；供 MCP 运行时、编辑串行锁、项目状态做宿主级键 |
| `src/client/openPathRouter.ts` | 新增 `resolveOpenPathOwner()`：按 `remote.session` → `workspaces` 探测真实宿主，探测不到就不装补丁，不新建死属性 |
| `src/client/filesCssCompat.ts` | 目标样式表改 `data-plugin` + `data-path`（旧 `data-plugin-css` 保留回落），规则改挂 `[data-files-navigator-row]` |
| `src/client/compat.ts` | `patchAccessor` 沿原型链找描述符并在实例上装自有属性；新增 `memberDescriptor()` |
| `src/client/remoteOpenRouter.ts` | 打开路径补丁支持原型链上的方法形态 |

### 二、项目 MCP 交给官方托管

| 文件 | 改动 |
| --- | --- |
| `src/mcpManagerBridge.ts`（新） | 官方 `ctx.mcpManager` 端口：条目/视图映射、OAuth 凭据键 `mcp-client/vsm-<8 位>`、无服务时空转 |
| `src/mcpManaged.ts`（新） | 托管层：注册名派生（工作区哈希前缀）、按工作区需求计的注册生命周期、状态缓存 |
| `src/mcpRuntime.ts` | 装配期探一次后端（`manager` \| `pool`）；托管后端把 attach/connect/catalogue/views 接到托管层 |
| `src/mcpProject.ts` | 项目刷新在 reconcile 之后按后端重新连接（托管走 `restart`） |
| `src/mcp.ts` | 全局列表剔除插件自己托管的注册名，避免与项目分区重复 |
| `src/shared/mcp.ts` | `MpcConfig` 增 `toolLoading` / `oauth`；`MpcServer` 增 `managed` / `managerState` / `registrationName` / `phase` |
| `src/rpc.ts`、`src/shared/rpc.ts` | 新增 `mcp.manager.views/restart/probe/authorize/cancel/signout` |
| `src/client/mcpForm.ts`、`src/client/ui/McpSettings.ts` | 表单新增「工具加载（DSH 0.2.3+）」开关；**默认值不落盘**，只有选了才写进配置 |

### 三、官方审阅与侧栏

| 文件 | 改动 |
| --- | --- |
| `src/client/officialReview.ts`（新） | 官方变更视图扩展位：工具条 + 文件菜单两条动作；改 React 组件 |
| `src/client/officialAnnotations.ts`（新） | 行级注解源：会话待审页 → 条目详情 → 未决差异块 → 行级注解（新增/修改落 R 侧、纯删除落 L 侧）；一轮 ≤40 条、每批并发 4、按修订号缓存、单文件 ≤8 条 |
| `src/client/ui/SideTabBoundary.ts`（新） | 侧栏正文错误边界：一处渲染异常不再把整片右侧栏刷白，给可重试提示 |

### 四、非 UTF-8 文本兼容（GB18030）

| 文件 | 改动 |
| --- | --- |
| `src/textEncoding.ts`（新） | 纯函数判定：`utf-8` / `gb18030`（整体严格可解）/ `mixed`（局部坏字节）/ `binary`（含 NUL）；只标注坏字节位置，不猜字节含义 |
| `src/client/textCompat.ts`（新） | 探测、只读预览、按推荐方式修复、撤销；写盘只发生在用户点「执行」之后 |
| `src/client/ui/TextCompatPanel.ts`（新） | 诊断面板：类别、坏字节位置、推荐动作与拒绝理由 |
| `src/client/ui/CompatTextView.ts`（新） | 可编辑查看器：按检测编码解码后用 Monaco 打开，坏字节显示为 U+FFFD，保存前必须处理掉占位，否则拒绝写盘 |
| `src/rpc.ts`、`src/shared/rpc.ts`、`src/client/ui/EditorView.ts` | 接线探测/预览/修复/撤销 RPC 与面板入口 |

### 五、SVN 提交对话框

| 文件 | 改动 |
| --- | --- |
| `src/client/ui/SvnCommitDialog.ts` | 文件行右键菜单（核对/日志/打开/勾选/加入版本控制/还原/复制）、Ctrl 切换与 Shift 范围多选、批量勾选与复制、Shift+F10 键盘菜单；提交信息框右键五项编辑（撤销/重做/剪切/复制/粘贴/全选）；空分区留说明行；菜单装配异常就地兜底 |
| `src/client/ui/svnCommitModel.ts` | 行选中与批量动作的纯逻辑（`nextRowPick` 等）可单测 |
| `src/svn.ts` | 提交动作目录与增量清单配套调整 |

### 六、HTML 计划页

| 文件 | 改动 |
| --- | --- |
| `skills/dsh-vscodemode-html-plan/runtime/plan.mjs`（新） | 一条命令完成「复制运行时 → 打包 → 校验」；`--check` 只验产物在位 |
| `src/htmlPlanCommand.ts` | `/html-plan` 指令改写：明说计划模式允许写 `plans/` 计划文件，页面没生成成功就不许声称已交付 |
| `src/client/htmlPlan/planActions.ts` | 计划页未生成时，面板直接让 agent 现场生成（每 2 秒读一次，最多 90 秒）；可选服务读取全部兜住，不让异常冲掉侧栏 |
| `src/client/htmlPlan/HtmlPlanPanel.ts` | 未打包残留检测（相对 `link`/`script` 引用）与「重新打包」按钮 |
| `src/client/htmlPlan/planPage.ts`、`src/client/styles/editor.css` | 计划页状态读取与样式 |

### 七、构建产物与样式

| 文件 | 改动 |
| --- | --- |
| `tsdown.config.ts` | 样式改 `meta.stylesheets`；路径按包内相对路径，第三方走 `vendor/`；相对 `url()` 构建失败 |
| `scripts/check-client-artifacts.mjs` | 断言每次注册带 `meta`、路径合法、`text` 可调用；断言产物无 `dataset.pluginCss` |

## 语义变化（需要知道）

1. `sharing: 'agent'` 在托管路径上不再生效：官方一条注册就只有一条实例。
2. `startup: 'on-demand'` 的「首个工具调用才连接」退化为「工作区出现首个会话即连接」，因为注册之前
   根本不存在可调用的工具名。等价替代是 `toolLoading: 'on-demand'`（工具不进会话工具表，显式加载后才进作用域）。
3. 项目 MCP 的工具命名空间变成 `<8 位工作区哈希>-<服务器名>`，公开工具名为 `mcp__<哈希>-<名>__<工具>`；
   名字由工作区路径决定，跨重启稳定。
4. 审阅注解是**行级**的，行号取自插件自己的待审差异，不是官方 forge 视图那份 diff；上下文行数不同就会整体偏移，
   因此注解不带 `digest`，也不进「较早改动」区。
5. 「工具加载」默认仍是不写字段（等价 eager）；只有用户明确选过才写进配置，避免每次保存都往配置里加键。

## 验证

- `npm run typecheck`：0 error。
- `npm run test`：**335 个文件通过 + 2 跳过（337）**；**4194 passed + 22 skipped（4216）**，31.61s。
  `node --test tests/nativeOpen.test.mjs`：`fail 0`。
- `npm run build`：`lib/index.js` 1,265,238 B、`lib/client.js` 1,055,081 B、`client.rules.js` 14,162 B、
  `client.debug.js` 18,279 B、`client.excel.js` 11,384,075 B、`client.excelcodec.js` 1,003,048 B；
  `check-client-artifacts` 通过（root 声明 `src/client/styles/editor.css`，excel 分包声明 panel.css 与 Univer 样式）。
- 本版修掉两处被新行为打破的陈旧断言：`tests/fileOpeners.test.ts` 改用 `installOpenPathRouter` 的新契约
  （传探测到的宿主，另补 `resolveOpenPathOwner` 与「无宿主不装补丁」的用例）；
  `tests/mcpSettings.test.ts` 因「工具加载默认值不落盘」而恢复为原样通过。

## 验收（需 DSH 重启后执行）

运行中的 host 仍持有旧模块，重启后新产物才生效：

1. `POST /edrv/rpc {"method":"compat"}` → **200**；`{"method":"mcp.manager.views"}` → **200**。
2. 兼容报告显示当前版本，并有「版本来源」「路由授权归属」两行。
3. 对话里点文件链接 → 在插件编辑器打开（走 `remote.session` 或旧 `workspaces`，两者都没有时不接管、不报错）。
4. MCP 面板的项目分区显示 `managed: true` 与托管注册名；关掉某工作区最后一个会话后注册消失；
   「重启」走官方 `restart`。
5. 官方变更视图的待审差异块上出现「待审」注解条，点击在插件编辑器打开该文件。
6. 用 GB18030 编码的 `.txt`/`.lua` 打开：出现兼容面板，只读预览可读，执行修复后文件变 UTF-8 且可撤销。
7. SVN 提交对话框：文件行右键出菜单、Ctrl/Shift 多选后批量勾选、提交信息框右键有编辑五项。
8. 热替换插件（重装同版本）后，页面 head 里不再堆积重复的 `dsh-vscode-mode` 样式标签。

## 发布记录

- 提交 `c7d719e`（69 文件：48 改 / 21 新增）→ tag `v0.33.0` → Release run `45132096583`，15m35s 全绿；
  同 commit 的 CI run `45132060696` 绿。
- registry `dsh-vscode-mode@0.33.0`：200，`gitHead=c7d719e`，`dist-tags.latest=0.33.0`，
  SRI 与 shasum 与实包字节一致（764 条，`lib/index.js` / `lib/client.js` / `cordis.patch.yml` / 技能组齐全）。
- GitHub Release asset：`dsh-vscode-mode-0.33.0.tgz`，17,190,024 B，`sha256:843ba38b…`，与 API digest 一致。
- npm 实包（17,190,031 B）与 Release asset 差 7 B：逐条比对 764 个文件，只有 `lib/client.js` 不同，
  差异是 `meta.stylesheets` 的**键序**（同一批样式、文件长度一致），来自两次 `npm pack` 之间样式表按目录遍历顺序生成。
  功能无差异；要对齐两端摘要需让样式表派发走固定顺序。
- 未做：DSH 部署与 GUI 验收（重启属部署动作，留给维护者按上面 8 条复验）。

## 未完成 / 下一批

- `forge.review.conversation`（single 槽）被官方占用；要接管需先让官方让位，跨插件边界，暂不做。
- 行级注解的行号来自自有待审差异，与官方 forge 视图的 diff 不同源；根治要官方提供「改动 digest ↔ 行号」映射。
- `ctx.connection.rpc` / `ctx.connection.fetch` 通道仍未迁移（理由见 `version-adaptation.md` §12）。
- 其他插件在 0.2.3 的兼容问题（`dsh-claude-style` 的 `uiSession.sessionStatus` 缺 inject、
  `conversation.composer.bar` 的 `removeChild` 崩溃）不属于本包。
