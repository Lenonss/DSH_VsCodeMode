/**
 * dsh-vscode-mode client — 编辑器指令目录（纯元数据）。
 * 「一条命令 = 一条注册数据」：命令栏、快捷键设置页、快捷键监听与 Monaco 右键菜单
 * 全部从本表读取；新增一条能力只需在 EDITOR_COMMANDS 追加一项（可选 keybinding）。
 * run 只派发 `edrv.command.*` 窗口事件，不直接触碰 React/Monaco（`edrv.command.` 前缀
 * 与既有 `edrv:` 刷新/主题事件分属不同命名空间，互不干扰）。
 * 作者 ddj 2026年09月10号
 */
import { hasEditorModel, hasOpenTabs } from '../editorModelState.js'

/** 一条编辑器指令（展示 + 执行 + 可用性）。 */
export interface CommandDef {
  /** 稳定命令 id（`edrv.` 前缀；第三方注册请避让该前缀）。 */
  id: string
  /** 命令栏与设置页展示名。 */
  label: string
  /** 命令栏分组名。 */
  category: string
  /** 组内排序（小者优先）。 */
  order?: number
  /** 默认键位弦（可选；可含 `|` 多候选）。声明后由快捷键设置页展示与录制。 */
  keybinding?: string
  /** 运行体：派发窗口事件或直接执行。 */
  run: () => void
  /** 可用性判定（缺省视为始终可用；返回 false 时命令栏隐藏且 run 被拒）。 */
  available?: () => boolean
}

/**
 * 派发编辑器命令事件（`edrv.command.<action>`）。
 * 无 window 的运行环境（纯 Node 单测）静默跳过，命令本身不因此失败。
 * @author ddj 2026年09月10号
 * @param action 动作名（不含前缀）
 */
function emit(action: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('edrv.command.' + action))
}

/** 编辑器命令事件名前缀（EditorView / QuickOpen / 第三方据此监听）。 */
export const COMMAND_EVENT_PREFIX = 'edrv.command.'

/** 需要活动编辑器模型才可用的命令（命令栏隐藏并拒绝执行）。 */
function needsModel(): boolean {
  return hasEditorModel()
}

/** 面板区显隐切换始终可用（未挂载编辑器时 run 为空操作）。 */
function alwaysAvailable(): boolean {
  return true
}

/**
 * 光标整行下移（编辑行导航）。
 * @author ddj 2026年09月10号
 * @returns 命令定义
 */
function nextEditorRowDef(): CommandDef {
  return {
    id: 'edrv.nextEditorRow', label: '下一编辑行（光标整行下移）', category: '导航', order: 50,
    keybinding: 'Ctrl+Alt+ArrowDown', available: needsModel,
    run: () => emit('nextEditorRow'),
  }
}

/**
 * 光标整行上移（编辑行导航）。
 * @author ddj 2026年09月10号
 * @returns 命令定义
 */
function prevEditorRowDef(): CommandDef {
  return {
    id: 'edrv.prevEditorRow', label: '上一编辑行（光标整行上移）', category: '导航', order: 60,
    keybinding: 'Ctrl+Alt+ArrowUp', available: needsModel,
    run: () => emit('prevEditorRow'),
  }
}

/**
 * 添加选中内容为引用（把当前选区追加进对话输入框；无选区则状态栏提示）。
 * 有活动编辑器模型才可用，保证对话框内按 Ctrl+U 不被本命令吞掉。
 * @author ddj 2026年09月10号
 * @returns 命令定义
 */
function addSelectionRefDef(): CommandDef {
  return {
    id: 'edrv.addSelectionRef', label: '添加选中内容为引用', category: '编辑', order: 10,
    keybinding: 'Ctrl+U', available: needsModel,
    run: () => emit('addSelectionRef'),
  }
}

/**
 * 关闭当前页签（参考图 Ctrl+F4）。
 * 可用性按「是否已打开页签」判定而非编辑器模型：图片/PDF 页签无 Monaco 实例但可关闭；
 * 无页签时判定不可用 → 指令桥放行按键，不吞掉浏览器/系统对 Ctrl+F4 的默认行为。
 * @author ddj 2026年09月11号
 * @returns 命令定义
 */
function closeTabDef(): CommandDef {
  return {
    id: 'edrv.closeTab', label: '关闭当前页签', category: '文件', order: 40,
    keybinding: 'Ctrl+F4', available: hasOpenTabs,
    run: () => emit('closeTab'),
  }
}

/**
 * 编辑器内置指令目录（顺序 = 快捷键设置页展示顺序）。
 * 前置 8 条的键位由 EditorView / QuickOpen 自行 capture 监听（历史实现），
 * 故不进 BRIDGE_COMMANDS，避免同一按键双执行。
 * @author ddj 2026年09月10号
 */
export const EDITOR_COMMANDS: readonly CommandDef[] = [
  {
    id: 'edrv.save', label: '保存文件', category: '文件', order: 10,
    keybinding: 'Ctrl+S', available: needsModel,
    run: () => emit('save'),
  },
  {
    id: 'edrv.quickOpen', label: '快速打开文件', category: '文件', order: 20,
    keybinding: 'Ctrl+P', available: alwaysAvailable,
    run: () => emit('quickOpen'),
  },
  {
    id: 'edrv.toggleSidebar', label: '切换侧边栏', category: '视图', order: 10,
    keybinding: 'Ctrl+B', available: alwaysAvailable,
    run: () => emit('toggleSidebar'),
  },
  {
    id: 'edrv.searchInFiles', label: '在工作区中搜索', category: '视图', order: 20,
    keybinding: 'Ctrl+Shift+F', available: alwaysAvailable,
    run: () => emit('searchInFiles'),
  },
  {
    id: 'edrv.navigateBack', label: '后退（导航历史）', category: '导航', order: 10,
    keybinding: 'Alt+ArrowLeft|Ctrl+Alt+-', available: needsModel,
    run: () => emit('navigateBack'),
  },
  {
    id: 'edrv.navigateForward', label: '前进（导航历史）', category: '导航', order: 20,
    keybinding: 'Alt+ArrowRight|Ctrl+Shift+-', available: needsModel,
    run: () => emit('navigateForward'),
  },
  {
    id: 'edrv.nextTab', label: '下一个页签', category: '导航', order: 30,
    keybinding: 'Ctrl+Alt+ArrowRight|Ctrl+PageDown', available: needsModel,
    run: () => emit('nextTab'),
  },
  {
    id: 'edrv.prevTab', label: '上一个页签', category: '导航', order: 40,
    keybinding: 'Ctrl+Alt+ArrowLeft|Ctrl+PageUp', available: needsModel,
    run: () => emit('prevTab'),
  },
  {
    id: 'edrv.goToDefinition', label: '转到定义', category: '语言智能', order: 10,
    available: needsModel,
    run: () => emit('goToDefinition'),
  },
  {
    id: 'edrv.findReferences', label: '查找所有引用', category: '语言智能', order: 20,
    available: needsModel,
    run: () => emit('findReferences'),
  },
  {
    id: 'edrv.triggerAi', label: '触发 AI 内联补全', category: '语言智能', order: 30,
    available: needsModel,
    run: () => emit('triggerAi'),
  },
  {
    id: 'edrv.openInExplorer', label: '在文件浏览器中打开', category: '文件', order: 30,
    available: needsModel,
    run: () => emit('openInExplorer'),
  },
  {
    id: 'edrv.configureSnippets', label: '代码片段：配置代码片段', category: '代码片段', order: 10,
    available: alwaysAvailable,
    run: () => emit('configureSnippets'),
  },
  {
    id: 'edrv.insertSnippet', label: '插入代码片段', category: '代码片段', order: 20,
    available: needsModel,
    run: () => emit('insertSnippet'),
  },
]

/**
 * 桥接派发指令（无原生监听，键位由 commandBridge 统一 capture 处理）。
 * 新增「只填目录、不写监听」的编辑器指令一律放这里：键位、命令栏、设置页自动可用。
 * @author ddj 2026年09月10号
 */
export const BRIDGE_COMMANDS: readonly CommandDef[] = [
  nextEditorRowDef(),
  prevEditorRowDef(),
  addSelectionRefDef(),
  closeTabDef(),
]

/**
 * 命令栏自身的命令（避免循环依赖，由 commandBridge 注入 run 后注册）。
 * @author ddj 2026年09月10号
 * @param run 打开命令栏
 * @returns 命令定义
 */
export function showCommandsDef(run: () => void): CommandDef {
  return {
    id: 'edrv.showCommands', label: '显示所有命令', category: '视图', order: 1,
    keybinding: 'Ctrl+Shift+P|F1', available: alwaysAvailable, run,
  }
}

/**
 * 需要全局键位派发的指令（桥接类 + 命令栏自身；不含 EditorView/QuickOpen 原生监听的那些）。
 * @author ddj 2026年09月10号
 * @param showCommands 命令栏命令定义
 * @returns 派发集合
 */
export function dispatchedCommands(showCommands: CommandDef): readonly CommandDef[] {
  return [...BRIDGE_COMMANDS, showCommands]
}
