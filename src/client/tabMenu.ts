/**
 * dsh-vscode-mode client — 文件页签右键菜单模型（纯函数，可单测）。
 * 菜单是「数据」而非 JSX：条目顺序、分组分隔线、禁用规则与键位提示全部在此收敛，
 * EditorView 只把结果映射成 ContextMenu 的 entries 并派发动作。
 *
 * 与参考图（VS Code / CodeBuddy 页签右键菜单）的对齐口径：
 * 保留其分组顺序（对话 / 关闭族 / 路径 / 定位 / 固定），**省略**本架构无法实现的
 * 「向右拆分 / Split & Move / 移动到新窗口 / 复制到新窗口」（浏览器内单编辑器实例）。
 * 只显示**真实已绑定**的键位；参考图里的两步弦（Ctrl+K W 等）引擎不支持，故不伪造。
 *
 * 「固定 = 保护」：关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭 一律不关固定页签，
 * 故这些条目在「固定页签是唯一可关对象」时判定为禁用（与 tabActions 语义同源）。
 * 作者 ddj 2026年09月11号
 */
import { closeAll, closeOthers, closeRight, closeSaved, isTreeRevealable, type TabLike } from './tabActions.js'

/** 菜单构建输入（EditorView 每次打开菜单时按最新状态快照传入）。 */
export interface TabMenuState {
  /** 右键目标页签路径。 */
  path: string
  /** 当前全部页签。 */
  tabs: TabLike[]
  /** 当前活动页签路径。 */
  active: string | null
  /** 路径 → 是否有未保存修改。 */
  dirty: Record<string, boolean>
  /** 会话工作区目录（相对路径复制与「资源管理器视图中显示」用）。 */
  cwd?: string | null
  /** 是否有活动会话（复制/定位类动作依赖）。 */
  hasSession: boolean
  /** 「添加到对话」动作集是否可用。 */
  canAddToConversation: boolean
  /** 「关闭」项的键位提示（缺省无提示；由调用方读 chordOf 注入）。 */
  closeChord?: string | null
}

/** 一条页签菜单项（ContextMenu 的展示形状 + 动作 id）。 */
export interface TabMenuEntry {
  id: string
  label: string
  /** 右侧键位提示（仅在真实绑定键位时出现）。 */
  hint?: string
  disabled?: boolean
  danger?: boolean
  /** 前置分隔线（分组的首条）。 */
  separator?: boolean
}

/** 关闭族 id（EditorView 的动作表按 id 分派；导出便于测试与静态校验）。 */
export const CLOSE_MENU_IDS = ['close', 'close-others', 'close-right', 'close-saved', 'close-all'] as const

/** 本架构不支持的条目 id（参考图有、浏览器单编辑器实例无法实现）——显式登记以防误加。 */
export const UNSUPPORTED_MENU_IDS = ['split-right', 'split-move', 'move-new-window', 'copy-new-window'] as const

/**
 * 构建页签右键菜单条目。
 * @author ddj 2026年09月11号
 * @param state 菜单状态快照
 * @returns 菜单条目（已按参考图分组排序）
 */
export function buildTabMenu(state: TabMenuState): TabMenuEntry[] {
  const { path, tabs, active, dirty, cwd, hasSession, canAddToConversation, closeChord } = state
  const current = tabs.find((tab) => tab.path === path)
  const pinned = current?.pinned === true
  return [
    {
      id: 'add-to-conversation',
      label: '添加到对话',
      disabled: !(hasSession && canAddToConversation),
    },
    { id: 'close', label: '关闭', separator: true, ...(closeChord ? { hint: closeChord } : {}) },
    { id: 'close-others', label: '关闭其他', disabled: nothingToClose(closeOthers(tabs, path, active), tabs) },
    { id: 'close-right', label: '关闭右侧标签页', disabled: nothingToClose(closeRight(tabs, path, active), tabs) },
    { id: 'close-saved', label: '关闭已保存', disabled: nothingToClose(closeSaved(tabs, dirty, active), tabs) },
    { id: 'close-all', label: '全部关闭', disabled: nothingToClose(closeAll(tabs, active), tabs) },
    { id: 'copy-path', label: '复制路径', separator: true },
    { id: 'copy-relative-path', label: '复制相对路径', disabled: !hasCwd(cwd) },
    { id: 'reveal-in-os', label: '在文件资源管理器中显示', separator: true, disabled: !hasSession },
    { id: 'reveal-in-view', label: '在资源管理器视图中显示', disabled: !isTreeRevealable(path) },
    {
      id: 'toggle-pinned',
      label: pinned ? '取消固定' : '固定',
      separator: true,
    },
  ]
}

/**
 * 关闭族是否无可关对象（结果页签数与关闭前一致 = 一个也没关掉）。
 * @author ddj 2026年09月11号
 * @param result 关闭结果
 * @param tabs 关闭前的页签
 * @returns 是否无可关对象
 */
function nothingToClose(result: { tabs: TabLike[] }, tabs: TabLike[]): boolean {
  return result.tabs.length >= tabs.length
}

/**
 * 是否有可用工作区目录（复制相对路径需要）。
 * @author ddj 2026年09月11号
 * @param cwd 会话工作区目录
 * @returns 是否可用
 */
function hasCwd(cwd: string | null | undefined): boolean {
  return typeof cwd === 'string' && cwd.trim() !== ''
}
