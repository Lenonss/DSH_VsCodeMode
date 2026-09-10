/**
 * dsh-vscode-mode client — 命令栏开关状态与单实例宿主认领。
 * 命令栏浮层走 createPortal 渲染到 body，但组件必须挂在插件自己的 React 树里：
 * 编辑区有三种形态（官方右侧 Sidebar / better-sidebar / 中央页签），会话切换时旧树先卸载、
 * 新树后挂载，可能出现两个宿主——claimPaletteHost 保证任一时刻只有一个宿主真正渲染浮层。
 * 运行体由 commandBridge 经 setPaletteRunner 注入（避免 store ↔ 注册表循环依赖）；
 * 注册表本体经 setRegistryRef 存入模块引用，命令栏据此读取候选——不依赖任何 window 全局
 * （旧实现写 window.dsh.edrvCommands，而 DSH 从不创建 window.dsh，导致命令栏恒为空表）。
 * 作者 ddj 2026年09月10号
 */
import type { CommandRegistry } from './commandRegistry.js'

/** 命令栏上次的唤起来源（诊断用）。 */
let openReason = ''

/** 装配期存入的指令注册表（命令栏读取候选的唯一真源）。 */
let registryTable: CommandRegistry | null = null

/** 命令栏是否展开。 */
let opened = false

/** 当前真正渲染浮层的宿主令牌（null = 无宿主）。 */
let hostToken: object | null = null

/** 注入的命令执行器（commandBridge 装配时写入）。 */
let runner: ((id: string) => boolean) | null = null

/** 打开命令栏前的焦点元素（关闭后归还焦点，键盘操作不中断）。 */
let focusBack: HTMLElement | null = null

const listeners = new Set<() => void>()

/** 通知全部订阅者（回调异常不影响其他订阅）。 */
function notifyPalette(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      /* 订阅回调异常忽略 */
    }
  }
}

/**
 * 注入命令执行器（命令栏执行选中命令时调用）。
 * @author ddj 2026年09月10号
 * @param next 执行器（返回是否执行成功）
 */
export function setPaletteRunner(next: ((id: string) => boolean) | null): void {
  runner = next
}

/**
 * 执行命令栏选中的命令。
 * @author ddj 2026年09月10号
 * @param id 命令 id
 * @returns 是否执行成功（执行器未注入/命令不可用/抛异常均为 false）
 */
export function runPaletteCommand(id: string): boolean {
  if (!runner) return false
  return runner(id) === true
}

/**
 * 存入指令注册表（commandBridge 装配期调用；命令栏据此读取候选）。
 * @author ddj 2026年09月10号
 * @param next 指令注册表（null = 卸载）
 */
export function setRegistryRef(next: CommandRegistry | null): void {
  registryTable = next
}

/**
 * 读取指令注册表（未装配返回 null；浮层据此回退全局/空表）。
 * @author ddj 2026年09月10号
 * @returns 指令注册表或 null
 */
export function registryRef(): CommandRegistry | null {
  return registryTable
}

/**
 * 订阅命令栏开关变化。
 * @author ddj 2026年09月10号
 * @param listener 变化回调
 * @returns 取消订阅函数
 */
export function subscribePalette(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 命令栏是否展开（useSyncExternalStore 快照）。
 * @author ddj 2026年09月10号
 * @returns 是否展开
 */
export function isPaletteOpen(): boolean {
  return opened
}

/** 记录打开前的焦点元素（只在真正需要归还时记录）。 */
function rememberFocus(): void {
  if (typeof document === 'undefined') return
  const active = document.activeElement
  focusBack = active instanceof HTMLElement ? active : null
}

/**
 * 打开命令栏（已打开时为空操作；记录当前焦点供关闭后归还）。
 * @author ddj 2026年09月10号
 * @param reason 唤起来源（键盘/命令/外部 API）
 */
export function openCommandPalette(reason = 'keybinding'): void {
  if (opened) return
  rememberFocus()
  openReason = reason
  opened = true
  notifyPalette()
}

/**
 * 关闭命令栏并归还焦点。
 * @author ddj 2026年09月10号
 */
export function closeCommandPalette(): void {
  if (!opened) return
  opened = false
  openReason = ''
  notifyPalette()
  const target = focusBack
  focusBack = null
  if (!target || typeof target.focus !== 'function') return
  try {
    target.focus()
  } catch {
    /* 目标已卸载时忽略 */
  }
}

/** 上次唤起来源（诊断/测试读取）。 */
export function paletteReason(): string {
  return openReason
}

/**
 * 认领命令栏宿主（返回 true 表示由本宿主渲染浮层）。
 * @author ddj 2026年09月10号
 * @returns 是否为当前宿主
 */
export function claimPaletteHost(): boolean {
  if (hostToken !== null) return false
  hostToken = {}
  return true
}

/**
 * 释放宿主认领（仅持有者可释放，卸载顺序错乱不会顶掉新宿主）。
 * @author ddj 2026年09月10号
 * @param token 认领令牌（null 表示本宿主未认领）
 */
export function releasePaletteHost(token: object | null): void {
  if (token === null || hostToken !== token) return
  hostToken = null
}
