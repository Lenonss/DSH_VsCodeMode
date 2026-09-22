/**
 * dsh-vscode-mode client — 调试面板断点行右键菜单条目（纯函数，可单测）。
 * 对齐 CodeBuddy（VS Code 内核）断点视图行上下文菜单：
 * 编辑断点… / 编辑条件… / 编辑命中次数… / 编辑记录点… / 启用|禁用断点 / 删除断点。
 * 四个编辑条目都打开面板行内编辑器，仅初始模式不同
 * （0 表达式 / 1 命中次数 / 2 日志消息；"编辑断点…"按现有字段自动判定）。
 * 本模块只产出条目数据，onClick 由 DebugPanel 装配（无副作用）。
 * 作者 ddj 2026年09月21号
 */

/** 菜单动作 id。 */
export type BpRowMenuAction =
  | 'edit'
  | 'edit-condition'
  | 'edit-hit-count'
  | 'edit-logpoint'
  | 'enable'
  | 'disable'
  | 'remove'

/** 一条菜单条目。 */
export interface BpRowMenuEntry {
  id: BpRowMenuAction
  label: string
  /** 前置分隔线（编辑组与启停/删除组之间，对齐 CodeBuddy）。 */
  separator?: boolean
}

/** 菜单构造输入。 */
export interface BpRowMenuState {
  /** 当前断点是否启用（禁用态显示「启用断点」）。 */
  enabled?: boolean
}

/**
 * 构造调试面板断点行右键菜单条目。
 * @author ddj 2026年09月21号
 * @param state 行内断点状态
 * @returns 菜单条目列表（顺序即展示顺序）
 */
export function buildBpRowMenu(state: BpRowMenuState): BpRowMenuEntry[] {
  const enabled = state.enabled !== false
  return [
    { id: 'edit', label: '编辑断点…' },
    { id: 'edit-condition', label: '编辑条件…' },
    { id: 'edit-hit-count', label: '编辑命中次数…' },
    { id: 'edit-logpoint', label: '编辑记录点…' },
    enabled
      ? { id: 'disable', label: '禁用断点', separator: true }
      : { id: 'enable', label: '启用断点', separator: true },
    { id: 'remove', label: '删除断点' },
  ]
}
