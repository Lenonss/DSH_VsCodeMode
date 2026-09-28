/**
 * dsh-vscode-mode client — 指令执行桥（装配层）。
 * 职责两件：① 把内置指令目录注册进注册表（命令栏候选源）；② 注入命令栏执行器。
 * 键位派发全部归官方 shortcuts 机制（shortcutsOfficial.registerOfficialShortcuts 注册官方命令，
 * resolve 走注册表 run）——本桥不再挂窗口键位监听，避免与官方派发双执行。
 * 编辑器动作本身由 EditorView / QuickOpen 监听 `edrv.command.<action>` 窗口事件完成——桥不持有
 * React 状态，因此指令系统可在编辑器挂载前装配、卸载后仍安全。
 * 作者 ddj 2026年09月10号 / 2026年10月
 */
import { BRIDGE_COMMANDS, EDITOR_COMMANDS, showCommandsDef } from './ui/commandCatalog.js'
import { createCommandRegistry } from './commandRegistry.js'
import type { CommandRegistry } from './commandRegistry.js'
import { log } from './log.js'
import { openCommandPalette, setPaletteRunner, setRegistryRef } from './commandPaletteStore.js'

const bridgeLog = log.child('commands')

/** 指令执行桥句柄。 */
export interface CommandBridge {
  /** 指令注册表（第三方可继续 register）。 */
  registry: CommandRegistry
  /** 卸载全部内置指令（幂等）。 */
  dispose(): void
}

/**
 * 创建指令执行桥：注册内置指令 + 命令栏自身，注入命令栏执行器。
 * @author ddj 2026年09月10号
 * @returns 指令执行桥句柄
 */
export function createCommandBridge(): CommandBridge {
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

  const dispose = (): void => {
    while (disposers.length) {
      const release = disposers.pop()
      if (release) release()
    }
    setPaletteRunner(null)
    setRegistryRef(null)
  }
  bridgeLog.info('指令注册表已装配（' + registry.list().length + ' 条指令；键位派发已归官方 shortcuts 机制）')
  return { registry, dispose }
}
