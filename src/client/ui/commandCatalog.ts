/**
 * dsh-vscode-mode client — 编辑器指令目录（纯元数据）。
 * 「一条命令 = 一条注册数据」：命令栏、快捷键设置页、快捷键监听与 Monaco 右键菜单
 * 全部从本表读取；新增一条能力只需在 EDITOR_COMMANDS 追加一项（可选 keybinding）。
 * run 只派发 `edrv.command.*` 窗口事件，不直接触碰 React/Monaco（`edrv.command.` 前缀
 * 与既有 `edrv:` 刷新/主题事件分属不同命名空间，互不干扰）。
 * 作者 ddj 2026年09月10号
 */
import { hasEditorModel, hasOpenTabs } from '../editorModelState.js'
import { svnCurrentStatus } from '../svnStatus.js'
import { dapStore } from '../dap/store.js'
import { svnActionOn, svnActionsFor } from '../../shared/svnActions.js'
import type { SvnActionDef } from '../../shared/svnActions.js'

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
 * 命令栏专用 SVN 动作（从 shared 动作目录生成；F1 收敛后命令栏不再手写动作清单）。
 *
 * 为什么这样：P3/P4 每加一个 SVN 动作，命令栏/树菜单/页签菜单三处都要改，
 * 且显隐条件会在三处各自漂移。现在动作元数据只有一份（shared/svnActions.ts），
 * 这里只负责「映射成命令定义」，新增动作无需改本文件。
 *
 * @author ddj 2026年09月16号
 * @returns 命令定义数组
 */
function svnPaletteDefs(): CommandDef[] {
  return svnActionsFor('palette').map((action) => ({
    id: action.commandId ?? ('edrv.svn' + action.id),
    label: 'SVN ' + action.label,
    category: 'SVN',
    order: action.order,
    available: () => {
      const status = svnCurrentStatus()
      const ready = Boolean(status?.managed)
      const cli = Boolean(status?.svnCli)
      const tortoise = Boolean(status?.tortoise)
      // 命令栏作用于「活动文件」：有编辑器模型时按 file 求值（与 svnEditorActions 同口径）。
      // 若恒用 'editor'，file/directory 类动作（查看日志/加入/还原）会因 targets 不含 editor
      // 被整体过滤——svnStatus.ts 注释警告过的同款坑（2026-09-18 实测命令栏缺「查看日志」）。
      const hasModel = hasEditorModel()
      if (!svnActionOn(action, {
        managed: ready, svnCli: cli, tortoise, target: hasModel ? 'file' : 'editor',
        versioned: true, diffable: true,
      })) return false
      // 需要活动文件的动作（命令栏语义）额外要求编辑器模型
      if (action.needsEditorModel && !hasModel) return false
      return true
    },
    run: () => emit(svnEventOf(action)),
  }))
}

/**
 * 动作 → 命令事件后缀（`edrv.command.<后缀>`）。
 * 与既有事件名保持兼容：update/diff-base/add/revert 沿用历史后缀，新动作按驼峰拼接。
 * @author ddj 2026年09月16号
 * @param action 动作定义
 * @returns 事件后缀
 */
function svnEventOf(action: SvnActionDef): string {
  const legacy: Record<string, string> = {
    update: 'svnUpdate',
    'refresh-changes': 'svnRefreshChanges',
    'diff-base': 'svnDiffBase',
    add: 'svnAdd',
    revert: 'svnRevertCli',
    log: 'svnLog',
    'create-patch': 'svnCreatePatch',
    'diff-summarize': 'svnDiffSum',
    cleanup: 'svnCleanup',
    'tortoise-commit': 'svnTortoiseCommit',
    'tortoise-log': 'svnTortoiseLog',
    'tortoise-diff': 'svnTortoiseDiff',
    'tortoise-blame': 'svnTortoiseBlame',
    'tortoise-revert': 'svnTortoiseRevert',
  }
  return legacy[action.id] ?? ('svn' + action.id)
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
    id: 'edrv.toggleMarkdownPreview', label: '切换 Markdown 预览', category: '视图', order: 25,
    keybinding: 'Ctrl+Shift+V', available: alwaysAvailable,
    run: () => emit('toggleMarkdownPreview'),
  },
  {
    id: 'edrv.showLogs', label: '查看诊断日志', category: '视图', order: 30,
    available: alwaysAvailable,
    run: () => emit('showLogs'),
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
  // SVN（动作清单来自 shared/svnActions.ts：三入口共用一份显隐规则）
  ...svnPaletteDefs(),
]

/**
 * 调试（DAP）命令组：全部桥接派发，EditorView 统一接线调 dapStore。
 * 可用性：步进类仅在暂停态可用（无编辑器时不吞键）；F5 需有配置或已暂停。
 * @author ddj 2026年09月29号
 * @returns 命令定义数组
 */
function debugPaletteDefs(): CommandDef[] {
  const phase = () => dapStore.getSnapshot().phase
  const paused = () => phase() === 'paused'
  const canStart = () => paused() || dapStore.getSnapshot().configs.length > 0
  const canStop = () => phase() !== 'idle' && phase() !== 'terminated'
  return [
    {
      id: 'edrv.debugToggleBreakpoint', label: '调试：切换断点（光标行）', category: '调试', order: 10,
      keybinding: 'F9', available: needsModel,
      run: () => emit('debugToggleBreakpoint'),
    },
    {
      id: 'edrv.debugStartContinue', label: '调试：启动 / 继续', category: '调试', order: 20,
      keybinding: 'F5', available: canStart,
      run: () => emit('debugStartContinue'),
    },
    {
      id: 'edrv.debugStepOver', label: '调试：单步跳过', category: '调试', order: 30,
      keybinding: 'F10', available: paused,
      run: () => emit('debugStepOver'),
    },
    {
      id: 'edrv.debugStepInto', label: '调试：单步步入', category: '调试', order: 40,
      keybinding: 'F11', available: paused,
      run: () => emit('debugStepInto'),
    },
    {
      id: 'edrv.debugStepOut', label: '调试：单步步出', category: '调试', order: 50,
      keybinding: 'Shift+F11', available: paused,
      run: () => emit('debugStepOut'),
    },
    {
      id: 'edrv.debugStop', label: '调试：停止', category: '调试', order: 60,
      keybinding: 'Shift+F5', available: canStop,
      run: () => emit('debugStop'),
    },
  ]
}

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
  ...debugPaletteDefs(),
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
