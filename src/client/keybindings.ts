/**
 * dsh-vscode-mode client — 快捷键配置模块（解析/匹配/状态同步）。
 * 纯逻辑（parseChord/parseChords/formatChord/matchEvent/chordFromEvent/normalizeKey）不依赖 DOM，可单测；
 * 模块状态由 settings 订阅驱动（client/index.ts 调 keybindingsApply）。
 * 键位语义：Ctrl 与 Cmd 互认（延续现有 Ctrl+P/Ctrl+B 捕获行为）。
 * 作者 ddj 2026年08月26号
 */
import React from 'react'
import { KEYBINDING_DEFAULTS, normalizeKeybindings } from '../shared/keybindings.js'

/** 解析后的键位（修饰符 + 规范化主键）。 */
export interface Binding {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  key: string
}

/** 命令目录（设置页展示标签；执行按目录序先匹配先执行，冲突键位确定性）。 */
export const COMMANDS: Array<{ id: string; label: string }> = [
  { id: 'edrv.save', label: '保存文件' },
  { id: 'edrv.quickOpen', label: '快速打开文件' },
  { id: 'edrv.toggleSidebar', label: '切换侧边栏' },
  { id: 'edrv.searchInFiles', label: '在工作区中搜索' },
  { id: 'edrv.navigateBack', label: '后退（导航历史）' },
  { id: 'edrv.navigateForward', label: '前进（导航历史）' },
]

const MODIFIERS: Record<string, 'ctrl' | 'shift' | 'alt' | 'meta'> = {
  ctrl: 'ctrl', cmd: 'meta', meta: 'meta', shift: 'shift', alt: 'alt',
}

let current: Record<string, string> = { ...KEYBINDING_DEFAULTS }
let parsed: Record<string, Binding[]> = {}
const listeners = new Set<() => void>()

/**
 * 应用设置快照（与默认值合并；未知 id 丢弃；空对象 = 全部默认）。
 * 每个命令可含多候选键位（`|` 分隔），任一命中即触发。
 * @author ddj 2026年08月26号
 * @param raw 设置 scope 的 keybindings 字段
 */
export function keybindingsApply(raw: unknown): void {
  current = { ...KEYBINDING_DEFAULTS, ...normalizeKeybindings(raw) }
  parsed = {}
  for (const id of Object.keys(current)) parsed[id] = parseChords(current[id])
  for (const listener of listeners) {
    try { listener() } catch { /* 监听器异常不影响其他订阅 */ }
  }
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

/**
 * 当前键位弦（未绑定/空 → null）。
 * @author ddj 2026年08月26号
 * @param id 命令 id
 * @returns 键位弦或 null
 */
export function chordOf(id: string): string | null {
  const chord = current[id]
  return typeof chord === 'string' && chord.trim() !== '' ? chord : null
}

/**
 * 当前命令的解析键位集合（未绑定/非法 → 空数组；含多候选）。
 * @author ddj 2026年08月26号
 * @param id 命令 id
 * @returns 解析键位数组（可能为空）
 */
export function bindingsOf(id: string): Binding[] {
  return parsed[id] ?? []
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
export function matchEvent(e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; key?: string }, bindings: Binding | Binding[] | null): boolean {
  const list = Array.isArray(bindings) ? bindings : bindings ? [bindings] : []
  for (const binding of list) {
    if ((e.ctrlKey || e.metaKey) !== (binding.ctrl || binding.meta)) continue
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
