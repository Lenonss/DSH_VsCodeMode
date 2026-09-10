/**
 * dsh-vscode-mode client — 指令注册表（命令栏与快捷键系统的唯一数据源）。
 * 镜像 sidebar/registry.ts 的注册表模式：register 返回注销器、list/subscribe 可订阅；
 * 额外提供 run(id)：先做可用性判定再执行，运行体异常一律捕获上报，绝不让命令抛出到事件循环。
 * 重复 id 按「后注册者生效」覆盖，旧注销器带身份校验（不会误删新实例，见 releaseRegistry）。
 * 作者 ddj 2026年09月10号
 */
import { filterCommands } from './commandSearch.js'
import { log } from './log.js'
import type { CommandDef } from './ui/commandCatalog.js'

/** 指令注册表（对插件内与第三方一致）。 */
export interface CommandRegistry {
  /** 注册命令；返回注销函数（幂等，重复调用无效）。 */
  register(command: CommandDef): () => void
  /** 命令是否存在。 */
  has(id: string): boolean
  /** 读取命令定义。 */
  get(id: string): CommandDef | undefined
  /** 全部命令（按目录序稳定排序）。 */
  list(): CommandDef[]
  /** 可用命令（available 缺省视为可用）。 */
  available(): CommandDef[]
  /** 命令是否已注册且当前可用（未注册返回 false；判定异常按不可用处理）。 */
  isAvailable(id: string): boolean
  /** 命令栏过滤（先按可用性过滤，再按相关度排序）。 */
  match(query: string): CommandDef[]
  /** 执行命令；不可用/未注册/抛异常统一返回 false（不抛出）。 */
  run(id: string): boolean
  /** 订阅注册表变化。 */
  subscribe(listener: () => void): () => void
}

const registryLog = log.child('commands')

/** 校验命令定义（缺 id/label/run 抛 TypeError，早失败优于静默无效）。 */
function assertCommand(command: CommandDef): void {
  if (!command || typeof command.id !== 'string' || !command.id) throw new TypeError('命令必须提供 id')
  if (typeof command.label !== 'string' || !command.label) throw new TypeError('命令必须提供 label：' + command.id)
  if (typeof command.run !== 'function') throw new TypeError('命令必须提供 run：' + command.id)
}

/** 目录序（order 缺省 100；非有限值同样按 100）。 */
function orderOf(command: CommandDef): number {
  return typeof command.order === 'number' && Number.isFinite(command.order) ? command.order : 100
}

/** 命令是否可用（available 缺省视为可用；判定异常按不可用处理）。 */
function isAvailable(command: CommandDef): boolean {
  if (typeof command.available !== 'function') return true
  try {
    return command.available() === true
  } catch (error) {
    registryLog.warn('可用性判定异常（按不可用处理）：' + command.id + ' · ' + String(error))
    return false
  }
}

/**
 * 注销命令（仅当表中仍是本次注册的定义时移除，避免旧实例误删新实例）。
 * @author ddj 2026年09月10号
 * @param entries 命令表
 * @param notify 变化通知
 * @param command 注册时的定义
 * @returns 注销函数
 */
function releaseRegistry(entries: Map<string, CommandDef>, notify: () => void, command: CommandDef): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    if (entries.get(command.id) !== command) return
    entries.delete(command.id)
    notify()
  }
}

/**
 * 执行已注册命令（可用性判定 → 运行体 → 异常上报）。
 * @author ddj 2026年09月10号
 * @param command 命令定义
 * @returns 是否真正执行
 */
function runCommand(command: CommandDef): boolean {
  if (!isAvailable(command)) {
    registryLog.debug('命令不可用，已跳过：' + command.id)
    return false
  }
  try {
    command.run()
    registryLog.debug('命令已执行：' + command.id)
    return true
  } catch (error) {
    registryLog.error('命令执行失败：' + command.id + ' · ' + String(error))
    return false
  }
}

/**
 * 创建指令注册表。
 * @author ddj 2026年09月10号
 * @returns 指令注册表
 */
export function createCommandRegistry(): CommandRegistry {
  const entries = new Map<string, CommandDef>()
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        registryLog.warn('注册表订阅回调异常：' + String(error))
      }
    }
  }
  const list = (): CommandDef[] =>
    [...entries.values()].sort((a, b) => orderOf(a) - orderOf(b))
  const available = (): CommandDef[] => list().filter(isAvailable)
  return {
    register(command: CommandDef): () => void {
      assertCommand(command)
      const replaced = entries.get(command.id)
      if (replaced !== undefined) registryLog.warn('命令 id 重复注册（后者生效）：' + command.id)
      entries.set(command.id, command)
      notify()
      return releaseRegistry(entries, notify, command)
    },
    has: (id) => entries.has(id),
    get: (id) => entries.get(id),
    list,
    available,
    isAvailable: (id) => {
      const command = entries.get(id)
      return command !== undefined && isAvailable(command)
    },
    match: (query) => filterCommands(available(), query),
    run(id: string): boolean {
      const command = entries.get(id)
      if (!command) {
        registryLog.warn('命令未注册：' + id)
        return false
      }
      return runCommand(command)
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
