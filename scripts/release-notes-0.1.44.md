# v0.1.44 发布说明

## 新增：LSP Ctrl+点击「引用导航」（Monaco 原生 References Peek）

背景：原 Ctrl+点击仅跳转**定义**，且自绘引用浮窗（Shift+F12 面板）在侧边栏布局下
点击列表项不跳转（edrv:// 目标无 openCodeEditor 接管，Monaco 原生无法加载）。

- Ctrl+点击语义重做为引用导航：`textDocument/references`（不含声明）查询「其它内容」对该项的引用：
  - **0 条** → 无特殊效果（不跳转、不弹窗）
  - **1 条** → 直接跳转到对应文件对应引用行
  - **多条** → 打开 Monaco 原生 **References Peek**（左侧代码预览 + 右侧引用列表），点击引用项跳转
- 列表点击修复：新增 `monaco.editor.registerEditorOpener` 接管 `edrv://` 路径的原生跳转
  （Peek 引用列表点击、原生 go-to-definition 等），经 `edrv:open-editor` → `openFileAt` 打开并定位
- Shift+F12 / 右键「查找所有引用」统一改走原生 References Peek；自绘引用浮窗及样式彻底移除
- 引用过滤：剔除点击处自身（同文件 + 位置落入 range，兼容零宽 range）后计数/去重，保证「其它内容」语义

## 测试
- 实机验证（EmmyLua，69 条引用）：0/1/多 三分支、浮窗定位（含 IMouseEvent.clientX 缺失的
  browserEvent 兼容）、单条直接跳转、原生 Peek 列表点击跳转全部通过
- 全量 vitest 未受影响（本次改动集中在 client 交互层，无共享契约变化）

## 已知
- 原生 Peek 左侧代码预览依赖已打开的模型（本构建无 registerModelContentProvider API）；
  未打开过的目标文件预览区可能为空，但不影响右侧列表点击跳转
- 原生 Peek 的引用列表按 Monaco 原生行为渲染（含声明项与点击处自身）
