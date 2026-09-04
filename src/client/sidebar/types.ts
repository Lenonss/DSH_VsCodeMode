/**
 * dsh-vscode-mode client — 侧边栏面板契约（类型 + 上下文）。
 * 面板 = 活动栏一项 + 面板区一处渲染；新增面板只需注册一条 SidebarPanelDef。
 * 作者 ddj 2026-08-26
 */
import type { OutlineSourceRegistry } from '../outline/types.js'
import type { AddToConversation } from '../addToConversation.js'
import type { TreeMenuRegistry } from './contextMenu.js'

/** 面板可用的共享上下文（由 SidebarView 从 EditorView 注入，面板不直碰其内部）。 */
export interface SidebarCtx {
  sessionId?: string
  /** 当前会话工作区 cwd（来自 sessions 快照；规则面板项目 Tab 自动匹配用）。 */
  cwd?: string | null
  openFile: (path: string) => void
  /** 打开文件并跳转到指定行/列（搜索面板命中跳转；缺省仅打开）。 */
  openFileAt?: (path: string, line?: number, column?: number) => void
  activePath: string | null
  /** 文件路径 → 待处理差异数（>0 才收录）。 */
  pendingByPath: Record<string, number>
  /** 按文件分组的差异摘要（records 状态派生）。 */
  sum: { totalFiles: number; files: Array<{ path: string; pending: number }> }
  /** 触发差异记录刷新（保存/决策后由 EditorView 统一 emitRefresh）。 */
  refreshRecords: () => void
  /** 取当前 Monaco 编辑器实例（可能为 null；大纲面板读 model/跳转用）。 */
  editor?: () => unknown | null
  /** 大纲源注册表（公开 provide 为 edrvOutlineSources；大纲面板解析符号用）。 */
  outlineSources?: OutlineSourceRegistry
  /** 文件右键菜单项注册表（公开 provide 为 edrvFileContextMenuItems；文件管理面板构建菜单用）。 */
  fileMenuItems?: TreeMenuRegistry
  /** 「添加到对话」动作集（文件/文件夹引用注入对话输入框；缺省时菜单项降级提示）。 */
  addToConversation?: AddToConversation
  /** 面板动作反馈（如右键菜单操作结果 → 编辑区路径栏状态）。 */
  notify?: (message: string) => void
}

/** 单个侧边栏面板定义。 */
export interface SidebarPanelDef {
  id: string
  title: string
  /** 活动栏图标（文本/SVG 均可，横向居中显示）。 */
  icon: string
  order?: number
  /** 活动栏徽标：返回数字/null；缺省不显示。 */
  badge?: (ctx: SidebarCtx) => number | null
  /** 面板区渲染（ctx 每次渲染注入最新快照）。 */
  render: (ctx: SidebarCtx) => unknown
}
