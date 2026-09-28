/**
 * dsh-vscode-mode client — 快捷键配置模块（解析/匹配/官方目录同步）。
 * 纯逻辑（parseChord/parseChords/formatChord/matchEvent/chordFromEvent/normalizeKey）不依赖 DOM，可单测；
 * 弦表（current）由官方 shortcuts 目录驱动：client/index.ts 经 shortcutsOfficial.bindCatalogChords
 * 订阅官方 catalog 后调 applyOfficialChords（键位持久化/冲突校验/派发全部归官方机制，本模块不再自派发）。
 * 键位语义：Ctrl 与 Cmd 互认（延续历史捕获行为）。
 * 命令目录（COMMANDS）派生自指令目录 commandCatalog（指令 = 单一数据源）。
 * 作者 ddj 2026年08月26号 / 2026年09月10号 / 2026年10月
 */
import React from 'react'
import { BRIDGE_COMMANDS, EDITOR_COMMANDS } from './ui/commandCatalog.js'

/** 解析后的键位（修饰符 + 规范化主键）。 */
export interface Binding {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  key: string
}

/** 命令目录（设置页展示标签；命令栏候选与键位提示共用）。 */
export const COMMANDS: Array<{ id: string; label: string }> = [
  ...EDITOR_COMMANDS.map((command) => ({ id: command.id, label: command.label })),
  { id: 'edrv.showCommands', label: '显示所有命令' },
  ...BRIDGE_COMMANDS.map((command) => ({ id: command.id, label: command.label })),
]

const MODIFIERS: Record<string, 'ctrl' | 'shift' | 'alt' | 'meta'> = {
  ctrl: 'ctrl', cmd: 'meta', meta: 'meta', shift: 'shift', alt: 'alt',
}

/** 弦表（官方 catalog 派生：id → 显示键位弦）。官方目录就绪前为空（tooltip 走各自的兜底文案）。 */
let current: Record<string, string> = {}
let currentAria: Record<string, string | undefined> = {}

/**
 * Read official accessibility metadata without deriving it from visual keycaps.
 * @author ddj 2026年09月28号
 * @param id Command identifier.
 * @returns Official single-key ARIA shortcut, absent for two-key chords.
 */
export function ariaOf(id: string): string | undefined { return currentAria[id] }

/**
 * Replace accessibility metadata from the official catalog.
 * @author ddj 2026年09月28号
 * @param aria Complete catalog ARIA map, applied before display notification.
 */
export function applyKeyAria(aria: Record<string, string | undefined>): void { currentAria = { ...aria } }
const listeners = new Set<() => void>()

/**
 * 应用官方目录弦表（id → 显示键位弦；由 shortcutsOfficial.bindCatalogChords 全量推送）。
 * @author ddj 2026年10月
 * @param chords 弦表（官方 catalog 派生，含用户覆盖；issue 行不收录）
 */
export function applyOfficialChords(chords: Readonly<Record<string, string>>): void {
  current = { ...chords }
  notifyKeybindings()
}

/**
 * 订阅键位配置变化。
 * @author ddj 2026年08月26号
 * @param listener 变化回调
 * @returns 取消订阅函数
 */
export function subscribeKeybindings(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 通知键位订阅者（异常隔离）。 */
function notifyKeybindings(): void {
  for (const listener of listeners) {
    try { listener() } catch { /* 监听器异常不影响其他订阅 */ }
  }
}

/**
 * 当前命令的键位弦（官方目录派生；未绑定/空 → null）。
 * @author ddj 2026年08月26号 / 2026年10月
 * @param id 命令 id
 * @returns 键位弦或 null
 */
export function chordOf(id: string): string | null {
  const chord = current[id]
  return typeof chord === 'string' && chord.trim() !== '' ? chord : null
}

/**
 * 当前命令的解析键位集合（未绑定/非法 → 空数组；含多候选）。
 * @author ddj 2026年08月26号 / 2026年10月
 * @param id 命令 id
 * @returns 解析键位数组（可能为空）
 */
export function bindingsOf(id: string): Binding[] {
  const chord = current[id]
  return typeof chord === 'string' ? parseChords(chord) : []
}

/**
 * 主键规范化：小写字母大写、空格归一为 Space，其余原样（与事件 e.key 对照）。
 * @author ddj 2026年08月26号
 * @param key 事件主键
 * @returns 规范化主键
 */
export function normalizeKey(key: string): string {
  const value = String(key ?? '')
  if (value === ' ') return 'Space'
  if (value.length === 1 && value >= 'a' && value <= 'z') return value.toUpperCase()
  return value
}

/**
 * 解析键位弦（如 `Ctrl+Shift+F`；纯修饰键/重复主键/空 → null）。
 * @author ddj 2026年08月26号
 * @param chord 键位弦
 * @returns 解析键位或 null
 */
export function parseChord(chord: string): Binding | null {
  const parts = String(chord ?? '').split('+').map((part) => part.trim()).filter(Boolean)
  if (!parts.length) return null
  const binding: Binding = { ctrl: false, shift: false, alt: false, meta: false, key: '' }
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLocaleLowerCase('en-US')]
    if (modifier) {
      binding[modifier] = true
      continue
    }
    if (binding.key) return null
    binding.key = normalizeKey(part)
  }
  return binding.key ? binding : null
}

/**
 * 解析多候选键位弦（`|` 分隔）：逐段解析，丢弃非法段，去重。
 * @author ddj 2026年08月26号
 * @param chord 键位弦（如 `Alt+ArrowLeft|Ctrl+Alt+-`）
 * @returns 解析键位数组（纯 `|`/空/非法 → 空数组）
 */
export function parseChords(chord: string): Binding[] {
  const out: Binding[] = []
  const seen = new Set<string>()
  for (const part of String(chord ?? '').split('|')) {
    const binding = parseChord(part)
    if (!binding) continue
    const key = formatChord(binding)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(binding)
  }
  return out
}

/**
 * 格式化键位（Ctrl/Cmd/Shift/Alt + 主键；meta 显示 Cmd）。
 * @author ddj 2026年08月26号
 * @param binding 解析键位
 * @returns 键位弦
 */
export function formatChord(binding: Binding): string {
  const parts: string[] = []
  if (binding.ctrl) parts.push('Ctrl')
  if (binding.meta) parts.push('Cmd')
  if (binding.shift) parts.push('Shift')
  if (binding.alt) parts.push('Alt')
  parts.push(binding.key)
  return parts.join('+')
}

/**
 * 事件是否命中键位（Ctrl 与 Cmd 互认；多候选任一命中即 true）。
 * @author ddj 2026年08月26号
 * @param e 键盘事件（鸭子类型，便于单测）
 * @param bindings 解析键位或键位数组（null/空 = 未绑定，永不命中）
 * @returns 是否命中
 */
export function matchEvent(e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; key?: string; isComposing?: boolean; keyCode?: number; defaultPrevented?: boolean; getModifierState?: (key: string) => boolean }, bindings: Binding | Binding[] | null): boolean {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.key === 'Dead' || e.getModifierState?.('AltGraph')) return false
  const list = Array.isArray(bindings) ? bindings : bindings ? [bindings] : []
  for (const binding of list) {
    if (Boolean(e.ctrlKey || e.metaKey) !== (binding.ctrl || binding.meta)) continue
    if (Boolean(e.shiftKey) !== binding.shift) continue
    if (Boolean(e.altKey) !== binding.alt) continue
    if (normalizeKey(e.key ?? '') === binding.key) return true
  }
  return false
}

/**
 * 从键盘事件构造键位弦（纯修饰键 → null，供设置页录制）。
 * @author ddj 2026年08月26号
 * @param e 键盘事件
 * @returns 键位弦或 null
 */
export function chordFromEvent(e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; key?: string }): string | null {
  const key = normalizeKey(e.key ?? '')
  if (!key || key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return null
  return formatChord({ ctrl: Boolean(e.ctrlKey), shift: Boolean(e.shiftKey), alt: Boolean(e.altKey), meta: Boolean(e.metaKey), key })
}

/**
 * 键位版本 hook：配置变化时返回新版本（tooltip/占位文案随键位刷新）。
 * @author ddj 2026年08月26号
 * @returns 当前版本号
 */
export function useKeybindingsVersion(): number {
  const [version, setVersion] = React.useState(0)
  React.useEffect(() => subscribeKeybindings(() => setVersion((v) => v + 1)), [])
  return version
}
