# v0.1.50 发布说明

> v0.1.49 已发布规则管理面板初版（用户/项目 `.mdc` 规则 + systemPrompt 注入）。
> 本版针对真实使用中暴露的交互与布局问题做整体重构：操作按钮被裁、描述过长、窄面板拥挤。

## 列表态重构

- 右侧常驻 编辑/删除 线性 SVG 图标 + 滑动启用开关（flex 流式垂直居中，替代原绝对定位
  顶对齐 + 100px 右留白）；行 hover 高亮；第二行改为「类型: 徽标 + 描述」
- **描述自适应截断**：上限 `min(24, (面板宽 − 210px) ÷ 10px/字)`、保底 8 字，
  ResizeObserver 随拖拽实时重算，超出省略号（按码位切分，emoji 不切半）；
  完整信息走悬停 title 与编辑界面
- **窄面板信息分级**：面板宽 < 420px 自动隐藏路径提示 `[rules/…]`（行 1 只留文件名），
  完整路径在悬停 title 与编辑态面包屑中

## 编辑态重构

- 顶部面包屑（作用域 > 目录 > 文件名）
- 规则生效类型下拉（总是/自动/手动）+ 描述输入框 + （自动时）globs 输入框，
  与原始 `.mdc` 文本域双向同步——控件变更重写 frontmatter（正文与其余键不动），
  文本域直接编辑则回读控件
- 保存校验：自动规则必须至少一个 glob；文件名非空
- 新增 client 纯函数模块 `rulesMdc.ts`（`parseRuleFm` / `applyRuleMeta`，与 host
  `parseRuleMdc` 语义对齐：BOM/CRLF/fmExtra 额外键保留；无 frontmatter 的手动规则
  仅在填写描述时补建 frontmatter）

## 布局收缩链修复（操作按钮被裁的根因）

- `.edrv-sidebar`：`flex-shrink: 0` → `1`，并加 `max-width: 100%`——容器比持久化
  面板宽度窄时（拖外层分隔线 / 缩窗口），侧边栏随可用空间收敛，不再把操作按钮
  裁出可视区；空间充足时仍保持持久化宽度，行为不变
- `.edrv-rules-panel`：补 `min-width: 0`——消除 flex 子项内容最小宽度兜底造成的
  面板溢出（实测面板宽 454 > 侧边栏内宽 414，操作按钮整段落入被裁区）

## 兼容性

- 纯 client 改动 + 新增 client 模块，不改 host/RPC 契约；旧规则文件（updatedAt 等
  额外键、YAML globs、BOM、CRLF）解析与开关改写不受影响

## 测试

- 全量 vitest：506 通过 / 6 既有跳过（新增 `tests/rulesMdc.test.ts` 19 例：解析 9 + 改写 10）
- typecheck 零错误；host + client tsdown 构建通过；web profile（Junction）实机验收：
  宽/窄面板与外层分隔线全程拖拽，操作按钮始终可见，字数上限随宽度实时变化

## 已知

- 面板下拉/输入为原生控件（与面板 `edrv-*` 自成体系一致），未引入 DSH UI primitives
- 极窄容器下编辑区让位给面板区（面板优先保宽）；编辑区过窄时建议拖回或收起面板区
