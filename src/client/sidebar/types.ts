/**
 * dsh-vscode-mode client — 侧边栏面板契约（类型 + 上下文）。
 * 面板 = 活动栏一项 + 面板区一处渲染；新增面板只需注册一条 SidebarPanelDef。
 * 作者 ddj 2026-08-26
 */
import type { OutlineSourceRegistry } from '../outline/types.js'

/** 面板可用的共享上下文（由 SidebarView 从 EditorView 注入，面板不直碰其内部）。 */
export interface SidebarCtx {
  sessionId?: string
  openFile: (path: string) => void
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
