/**
 * dsh-vscode-mode client — 断点 gutter 右键菜单条目（纯函数，可单测）。
 * 逐条对齐 CodeBuddy（VS Code 内核）breakpointEditorContribution.getContextMenuActions
 * 与其官方中文语言包译文：
 * - 无断点：添加断点 / 添加条件断点... / 添加记录点... / 添加触发的断点...
 * - 有断点：删除 {noun}（右侧 Delete）/ 编辑 {noun}… / 禁用{noun} 或 启用 {noun}
 *   noun 随类型切换：普通断点 =「断点」，记录点（带日志消息）=「记录点」
 * - 暂停且支持时：前置分隔线 + 运行到行
 *
 * 文案逐字取自语言包（**空格与省略号形态不可改**）：
 *   removeBreakpoint「删除 {0}」/ editBreakpoint「编辑 {0}…」/
 *   disableBreakpoint「禁用{0}」/ enableBreakpoint「启用 {0}」/ runToLine「运行到行」
 * 本模块只产出条目数据，onClick 由 EditorView 装配（无副作用）。
 * 作者 ddj 2026年09月29号
 */

/** 菜单动作 id。 */
export type BpMenuAction =
  | 'add'
  | 'add-conditional'
  | 'add-logpoint'
  | 'add-triggered'
  | 'delete'
  | 'edit'
  | 'disable'
  | 'enable'
  | 'run-to-line'

/** 一条菜单条目。 */
export interface BpMenuEntry {
  id: BpMenuAction
  label: string
  /** 前置分隔线（运行到行与断点条目之间，对齐 CodeBuddy）。 */
  separator?: boolean
  /** 右侧键位提示（CodeBuddy 仅删除项带 Delete）。 */
  hint?: string
  /** 显示但当前调试器不支持：点击给出明确提示而非静默失败。 */
  unsupported?: boolean
}

/** 菜单构造输入。 */
export interface BpMenuState {
  /** 命中行是否已有断点。 */
  hasBreakpoint: boolean
  /** 已有断点是否启用（无断点时忽略）。 */
  enabled?: boolean
  /** 已有断点是否为记录点（带日志消息）→ 名词用「记录点」。 */
  isLogpoint?: boolean
  /** 调试器是否暂停中（运行到行仅在暂停时出现）。 */
  paused?: boolean
  /** 调试器是否支持运行到行。 */
  canRunTo?: boolean
  /** 调试器是否支持触发的断点。 */
  canTriggered?: boolean
}

/**
 * 构造断点右键菜单条目。
 * @author ddj 2026年09月29号
 * @param state 命中行与调试器状态
 * @returns 菜单条目列表（顺序即展示顺序）
 */
export function buildBpMenu(state: BpMenuState): BpMenuEntry[] {
  const entries = state.hasBreakpoint ? ownedEntries(state) : addEntries(state.canTriggered === true)
  // CodeBuddy 在 if/else 链之后无条件追加：空行同样支持运行到行（仅在暂停时）
  if (state.paused === true && state.canRunTo === true) {
    entries.push({ id: 'run-to-line', label: '运行到行', separator: true })
  }
  return entries
}

/** 无断点：四个添加类条目（对齐 CodeBuddy 无条件四项）。 */
function addEntries(canTriggered: boolean): BpMenuEntry[] {
  return [
    { id: 'add', label: '添加断点' },
    { id: 'add-conditional', label: '添加条件断点...' },
    { id: 'add-logpoint', label: '添加记录点...' },
    { id: 'add-triggered', label: '添加触发的断点...', unsupported: !canTriggered },
  ]
}

/** 已有断点：删除 / 编辑 / 启停（名词随记录点切换）。 */
function ownedEntries(state: BpMenuState): BpMenuEntry[] {
  const noun = state.isLogpoint === true ? '记录点' : '断点'
  const enabled = state.enabled !== false
  return [
    { id: 'delete', label: '删除 ' + noun, hint: 'Delete' },
    { id: 'edit', label: '编辑 ' + noun + '…' },
    enabled ? { id: 'disable', label: '禁用' + noun } : { id: 'enable', label: '启用 ' + noun },
  ]
}
