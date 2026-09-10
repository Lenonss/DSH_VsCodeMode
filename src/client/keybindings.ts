/**
 * dsh-vscode-mode client — 快捷键配置模块（解析/匹配/状态同步）。
 * 纯逻辑（parseChord/parseChords/formatChord/matchEvent/chordFromEvent/normalizeKey）不依赖 DOM，可单测；
 * 模块状态由 settings 订阅驱动（client/index.ts 调 keybindingsApply）。
 * 键位语义：Ctrl 与 Cmd 互认（延续 Ctrl+P/Ctrl+B 捕获行为）。
 * 命令目录（COMMANDS）派生自指令目录 commandCatalog（指令 = 单一数据源，设置页自动跟随）；
 * 另支持运行时键位表（第三方命令 register 时声明，不落设置 schema，注销即失效）。
 * 作者 ddj 2026年08月26号 / 2026年09月10号
 */
import React from 'react'
import { KEYBINDING_DEFAULTS, normalizeKeybindings } from '../shared/keybindings.js'
import { BRIDGE_COMMANDS, EDITOR_COMMANDS, showCommandsDef } from './ui/commandCatalog.js'
import { log } from './log.js'

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
  ...EDITOR_COMMANDS.map((command) => ({ id: command.id, label: command.label })),
  { id: 'edrv.showCommands', label: '显示所有命令' },
  ...BRIDGE_COMMANDS.map((command) => ({ id: command.id, label: command.label })),
]

/** 命令栏命令定义（键位自检与目录展示共用；run 不参与键位逻辑）。 */
function paletteCommand(): { id: string; label: string; keybinding?: string } {
  return showCommandsDef(() => {})
}

/**
 * 目录与默认键位表一致性自检（仅告警不中断）：新指令漏写共享表时第一时间可见。
 * @author ddj 2026年09月10号
 */
function checkDefaultsDrift(): void {
  for (const command of [...EDITOR_COMMANDS, paletteCommand()]) {
    if (!command.keybinding) continue
    if (KEYBINDING_DEFAULTS[command.id] === command.keybinding) continue
    log.warn('指令默认键位与共享表不一致：' + command.id
      + ' 目录=' + command.keybinding + ' 共享表=' + String(KEYBINDING_DEFAULTS[command.id]))
  }
}

const MODIFIERS: Record<string, 'ctrl' | 'shift' | 'alt' | 'meta'> = {
  ctrl: 'ctrl', cmd: 'meta', meta: 'meta', shift: 'shift', alt: 'alt',
}

let current: Record<string, string> = { ...KEYBINDING_DEFAULTS }
const runtime = new Map<string, Binding[]>()
const listeners = new Set<() => void>()

checkDefaultsDrift()

/**
 * 应用设置快照（与默认值合并；未知 id 丢弃；空对象 = 全部默认）。
 * 每个命令可含多候选键位（`|` 分隔），任一命中即触发。
 * @author ddj 2026年08月26号
 * @param raw 设置 scope 的 keybindings 字段
 */
export function keybindingsApply(raw: unknown): void {
  current = { ...KEYBINDING_DEFAULTS, ...normalizeKeybindings(raw) }
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
 * 注册运行时键位（第三方命令；优先于设置值，注销即失效）。
 * @author ddj 2026年09月10号
 * @param id 命令 id
 * @param chord 键位弦（空/非法按未绑定处理）
 * @returns 注销函数（幂等）
 */
export function addRuntimeKeybinding(id: string, chord: string): () => void {
  runtime.set(id, parseChords(chord))
  notifyKeybindings()
  return () => removeRuntimeKeybinding(id)
}

/**
 * 移除运行时键位。
 * @author ddj 2026年09月10号
 * @param id 命令 id
 */
export function removeRuntimeKeybinding(id: string): void {
  if (!runtime.delete(id)) return
  notifyKeybindings()
}

/** 通知键位订阅者（异常隔离）。 */
function notifyKeybindings(): void {
  for (const listener of listeners) {
    try { listener() } catch { /* 监听器异常不影响其他订阅 */ }
  }
}

/**
 * 当前命令的键位弦（运行时键位优先；未绑定/空 → null）。
 * @author ddj 2026年08月26号 / 2026年09月10号
 * @param id 命令 id
 * @returns 键位弦或 null
 */
export function chordOf(id: string): string | null {
  if (runtime.has(id)) {
    const chords = runtime.get(id) ?? []
    return chords.length ? chords.map(formatChord).join('|') : null
  }
  const chord = current[id]
  return typeof chord === 'string' && chord.trim() !== '' ? chord : null
}

/**
 * 当前命令的解析键位集合（未绑定/非法 → 空数组；含多候选）。
 * @author ddj 2026年08月26号 / 2026年09月10号
 * @param id 命令 id
 * @returns 解析键位数组（可能为空）
 */
export function bindingsOf(id: string): Binding[] {
  const override = runtime.get(id)
  if (override) return override
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
export function matchEvent(e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; key?: string }, bindings: Binding | Binding[] | null): boolean {
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
