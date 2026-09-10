/**
 * dsh-vscode-mode client — 指令执行桥（装配层）。
 * 职责三件：① 把内置指令目录注册进注册表；② 为「桥接派发」类指令挂窗口 capture 键位监听
 * （EditorView 原生监听的 8 条不进这里，避免双执行）；③ 注入命令栏执行器。
 * 编辑器动作本身由 EditorView / QuickOpen 监听 `edrv.command.<action>` 窗口事件完成——桥不持有
 * React 状态，因此指令系统可在编辑器挂载前装配、卸载后仍安全。
 * 作者 ddj 2026年09月10号
 */
import { BRIDGE_COMMANDS, EDITOR_COMMANDS, dispatchedCommands, showCommandsDef } from './ui/commandCatalog.js'
import { createCommandRegistry } from './commandRegistry.js'
import type { CommandRegistry } from './commandRegistry.js'
import { bindingsOf, matchEvent } from './keybindings.js'
import { log } from './log.js'
import { openCommandPalette, setPaletteRunner, setRegistryRef } from './commandPaletteStore.js'

const bridgeLog = log.child('commands')

/** 桥接装配选项（事件目标可注入，便于单测）。 */
export interface CommandBridgeOptions {
  /** 键盘事件目标（缺省 window；无 window 的纯 Node 环境自动跳过监听）。 */
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
}

/** 指令执行桥句柄。 */
export interface CommandBridge {
  /** 指令注册表（第三方可继续 register）。 */
  registry: CommandRegistry
  /** 卸载全部内置指令并解除键位监听（幂等）。 */
  dispose(): void
}

/** 解析事件目标（缺省 window；无 window 返回 null）。 */
function resolveTarget(options: CommandBridgeOptions): CommandBridgeOptions['target'] | null {
  if (options.target) return options.target
  if (typeof window === 'undefined') return null
  return window
}

/**
 * 创建指令执行桥：注册内置指令 + 桥接类指令的全局键位监听。
 * @author ddj 2026年09月10号
 * @param options 装配选项（事件目标注入）
 * @returns 指令执行桥句柄
 */
export function createCommandBridge(options: CommandBridgeOptions = {}): CommandBridge {
  const registry = createCommandRegistry()
  const disposers: Array<() => void> = []
  const palette = showCommandsDef(() => openCommandPalette('command'))
  for (const command of [...EDITOR_COMMANDS, ...BRIDGE_COMMANDS]) {
    disposers.push(registry.register(command))
  }
  disposers.push(registry.register(palette))
  setPaletteRunner((id) => registry.run(id))
  // 命令栏候选来源：模块引用直传（旧实现依赖 window.dsh，DSH 无该命名空间 → 恒空表）
  setRegistryRef(registry)

  // 全局键位派发集合：桥接类指令 + 命令栏自身（EditorView/QuickOpen 原生监听的 8 条不在内，避免双执行）
  const dispatched = dispatchedCommands(palette)
  const onKey = (event: KeyboardEvent): void => {
    for (const command of dispatched) {
      if (!matchEvent(event, bindingsOf(command.id))) continue
      // 可用性前置：命令不可用时既不执行也不吞键（否则无编辑器时 Ctrl+U 会被吃掉）
      if (!registry.isAvailable(command.id)) continue
      event.preventDefault()
      event.stopPropagation()
      registry.run(command.id)
      return
    }
  }
  const target = resolveTarget(options)
  if (target) target.addEventListener('keydown', onKey as EventListener, true)

  const dispose = (): void => {
    if (target) target.removeEventListener('keydown', onKey as EventListener, true)
    while (disposers.length) {
      const release = disposers.pop()
      if (release) release()
    }
    setPaletteRunner(null)
    setRegistryRef(null)
  }
  bridgeLog.info('指令注册表已装配（' + registry.list().length + ' 条指令，桥接键位 '
    + dispatched.length + ' 条）')
  return { registry, dispose }
}
