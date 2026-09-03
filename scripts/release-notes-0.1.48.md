# v0.1.48 发布说明

## 新增：文件管理右键菜单「添加引用到对话」

背景：文件管理（资源管理器）面板的右键菜单此前只有「在文件浏览器中打开」。
本次新增「添加引用到对话」，把目标**文件或文件夹**作为 DSH 引用（chip / `@path`）
直接注入当前会话对话输入框（composer draft），复用官方输入门面
`ctx.conversation.input.for(sessions.scope(sessionId))`。

### 实现

- 内置菜单项 `add-to-conversation`（`menuItems.ts`，排序在「在文件浏览器中打开」之后）：
  文件目标以 `file` 外观、文件夹目标以 `folder` 外观追加引用（DSH reference 载荷
  本就支持 `folder` 外观）；`visible` 守卫排除根目录空白区/无会话/动作集缺失
- `SidebarCtx` 新增可选 `addToConversation` 动作集（EditorView 接线，第三方菜单项也可用）
- `addToConversation.ts`：`buildFileRef` / `appendReference` 新增可选 `appearance`
  参数（默认 `file`，既有调用零影响）；提取共享状态文案 `statusOfAdd`
  （EditorView 与菜单项复用，去重）
- 忙态（输入框 adjudicating/submitting 或 CAS 失败）自动降级纯文本追加，保证动作有落点

### 修复：右键菜单位置对齐鼠标点击点

- 文件树行内右键菜单此前锚定到目标行右缘（`rect.right + 4`），离点击点有 X 轴偏移；
  改为菜单左上角直接对齐 `ev.clientX/clientY`（视口坐标），与面板空白区、编辑区 Tab 菜单一致；
  移除 `rowMenuPosition` 及其 `MenuAnchorRect`（viewport clamp 仍由 ContextMenu 兜底）

### 调整：移除对话输入框内联提示

- 去掉 `appendReference` 成功后/忙态降级后写入对话输入框的「已添加文件引用 xxx」条形栏
  （`input.notify`）；编辑区路径栏状态反馈保留

### 兼容性

- 纯客户端改动，host 面零变化；`appendReference` 签名仅追加可选参数，旧调用不破坏
- `SidebarCtx.addToConversation` 可选，未接线时菜单项隐藏、动作降级提示

## 测试

- 全量 vitest：455 通过（新增 `tests/menuItems.test.ts` 7 例：菜单结构/文件/文件夹分派/
  忙态/不可用/visible 守卫；`tests/addToConversation.test.ts` 补 folder 外观与 `statusOfAdd`；
  `tests/menuPosition.test.ts` 收敛为 clamp）
- typecheck 零错误；host + client tsdown 构建通过；已本地装入 web profile 冒烟

## 已知

- 无
