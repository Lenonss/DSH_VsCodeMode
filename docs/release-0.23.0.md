# v0.23.0：快捷菜单（分层动作面板 + 技能/规则绑定）

作者：ddj，2026-10-30。

## 变更

- 新增快捷菜单：编辑器里一个可拖动的悬浮按钮，点开是一棵自定义菜单树（组 / 按钮两种节点，最多 5 层），按钮可携带提示词并「直接发送给 AI」或「只填入输入框」。
- 配置存放于 `<DSH_HOME>/dsh-vscode-mode/data/quick-menu.json`（跨工作区共享一份），带 `revision` 乐观锁：并发保存冲突时重新拉取而不是覆盖磁盘；文件损坏时给出告警并按默认配置继续可用。
- 节点可限定生效工作区：默认全部工作区，也可只对当前或若干个已注册工作区可见，子节点默认继承父节点的限定范围。
- 按钮可绑定技能与规则：绑定在发送时按当前会话可见性校验（技能未加载、规则文件缺失/停用/跨工作区都会给出可读原因），只拼装通过校验的绑定；规则支持「引用路径」与「内联正文」两种注入方式。
- 新增 `skills.list` 只读 RPC：枚举「全局技能（`$DSH_HOME/skills`）」与「当前工作区技能（`<projectRoot>/.dsh/skills`）」，供配置界面做候选。技能目录约定同官方 `dsh-skill-filesystem`（目录式 `<名>/SKILL.md` 或扁平式 `<名>.md`，深度 1 层），frontmatter 解析复用既有 `parseSkillMd`，非法技能不进候选。
- 配置界面改版：限定工作区由一排工作区小标签换成下拉弹层（「全部工作区」/「当前工作区」两个快捷项 + 「更多工作区」展开完整多选）；绑定技能、绑定规则改为分组多选下拉（全局技能 / 当前工作区技能、用户规则 / 当前工作区规则），移除手输技能名的入口；已绑定但不在候选内的项单独成组保留，仍可解绑。
- 菜单设置弹窗重排为「外观 / 交互 / 配置备份与迁移 / 绑定状态」四段，开关改滑动开关、最大嵌套层数改 1–5 分段按钮；统一按钮盒模型（固定高度、`inline-flex` 居中、`--sm` 尺寸档位），修掉「导入 JSON」因 `<label>` 命中宿主弹窗样式而下移、文字不居中的问题，导入改用真按钮触发隐藏 `file input`。
- 路径比较口径统一到 `src/shared/pathKey.ts` 的 `pathKeyFor(path, foldCase)`：宿主侧按平台折叠大小写，浏览器侧不折叠（无平台信息，避免把两个不同文件当成同一个）。
- 内部重构（行为不变）：待审采集器 `installPendingCapture` → `installPending`，采信状态收进 `CaptureState`、判定逻辑抽成 `planOf` / `CapturePlan`；待审 RPC 处理器的闭包提升为模块级 `workspaceOf` / `writeWorkspaceOf` / `failureOf` / `shellOf`；`pending` 侧若干局部变量改名并补注释。
- `swap-vscode-mode.ps1` 不再按易变的 bundle 字节数判断是否构建过，改为检查 `lib/client.js` 含 `edrv-qm-launcher`、`lib/index.js` 含 `quickMenu` 标记。

## 验证与已知边界

- `npm run typecheck` 0 error；`npm run test` 通过（含新增 `tests/quickMenu.test.ts`、`tests/quickMenuHost.test.ts`、`tests/quickPick.test.ts`、`tests/skillCatalog.test.ts`）；`npm run build` 双产物（host / client）成功。
- 新增用例覆盖：菜单文档归一化与校验、提示词拼装、悬浮按钮定位、工作区摘要文案、技能目录枚举（临时 `DSH_HOME` + `mkdtemp`）。
- 已知缺口：**GUI 未做真机验收**。本机 `pnpm` store 损坏（`[ERR_SQLITE_ERROR] unable to open database file`），插件未部署到运行中的 DSH 实例，快捷菜单的弹层定位、下拉交互与视觉只在构建产物与静态检查层面确认；用户在本批次明确接受该缺口。
- 未进行 Unity 全量验证（本包不涉及 Unity 工程）。

## 升级

待 npm 精确版本或 GitHub Release 资产可查询后，按 README 三选一安装示例选择实际目标 profile。升级操作由用户自行安排；若需要重新加载 Host，应由用户确认并执行，不由发布流程自动重启。

数据迁移：本版不改动 `pending_*` 表结构与既有归档，升级无需迁移。快捷菜单配置为新增文件，首次打开配置界面即按默认值生成；回退到 0.22.0 时该文件残留但不被读取，不影响旧版本行为。
