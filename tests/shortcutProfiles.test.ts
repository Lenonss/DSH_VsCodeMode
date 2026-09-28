/**
 * tests — SHORTCUT_PROFILES 官方 profile 表与 chord↔binding 映射（纯数据层契约）。
 * 表约束对齐官方 @deepseek-ai/dsh-client-shortcuts 的 register 校验
 * （保留键 / web 白名单 / 组合重叠），错报会在官方注册时抛错，这里提前拦截。
 * 作者 ddj 2026年10月
 */
import { describe, expect, it } from 'vitest'
import {
  bindingToChord,
  chordToBinding,
  KEYBINDING_DEFAULTS,
  SHORTCUT_PROFILES,
  type OfficialBinding,
  type ShortcutProfileKey,
} from '../src/shared/keybindings.js'

const PROFILE_KEYS: ShortcutProfileKey[] = [
  'desktop:macos', 'desktop:windows', 'desktop:linux',
  'web:macos', 'web:windows', 'web:linux',
]

/** 官方 code 白名单（对齐 normalizeBinding：Key/Digit/F 前缀 + 全部具名键）。 */
const NAMED_CODES = new Set(['Slash', 'Comma', 'Period', 'Backslash', 'Backquote', 'Minus', 'Equal',
  'BracketLeft', 'BracketRight', 'Semicolon', 'Quote',
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

function isValidCode(code: string): boolean {
  return /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4]))$/u.test(code) || NAMED_CODES.has(code)
}

function isValidBinding(binding: OfficialBinding): boolean {
  if (!isValidCode(binding.code)) return false
  if (binding.secondCode !== undefined && !isValidCode(binding.secondCode)) return false
  return binding.modifiers.every((m) => ['primary', 'control', 'alt', 'shift', 'meta'].includes(m))
}

describe('SHORTCUT_PROFILES 目录一致性', () => {
  it('KEYBINDING_DEFAULTS 的每个命令都有 profile 条目', () => {
    for (const id of Object.keys(KEYBINDING_DEFAULTS)) expect(SHORTCUT_PROFILES[id], id).toBeDefined()
  })

  it('SHORTCUT_PROFILES 的命令都在 KEYBINDING_DEFAULTS 内', () => {
    for (const id of Object.keys(SHORTCUT_PROFILES)) expect(id in KEYBINDING_DEFAULTS, id).toBe(true)
  })

  it('profile 键合法且绑定形状合法', () => {
    for (const [id, profiles] of Object.entries(SHORTCUT_PROFILES)) {
      for (const [profile, binding] of Object.entries(profiles)) {
        expect(PROFILE_KEYS, `${id} 的 profile ${profile}`).toContain(profile as ShortcutProfileKey)
        expect(isValidBinding(binding as OfficialBinding), `${id}:${profile}`).toBe(true)
      }
    }
  })

  it('同 profile 内无官方语义重叠（修饰符集合相同且主键相交）', () => {
    const byProfile = new Map<ShortcutProfileKey, OfficialBinding[]>()
    for (const profiles of Object.values(SHORTCUT_PROFILES)) {
      for (const [profile, binding] of Object.entries(profiles)) {
        const key = profile as ShortcutProfileKey
        const list = byProfile.get(key) ?? []
        list.push(binding as OfficialBinding)
        byProfile.set(key, list)
      }
    }
    for (const [profile, bindings] of byProfile) {
      for (let i = 0; i < bindings.length; i += 1) {
        for (let j = i + 1; j < bindings.length; j += 1) {
          const a = bindings[i]
          const b = bindings[j]
          const sameModifiers = a.modifiers.join('+') === b.modifiers.join('+')
          const codesOverlap = [a.code, a.secondCode]
            .some((code) => code !== undefined && (code === b.code || code === b.secondCode))
          expect(sameModifiers && codesOverlap, `${profile}: ${a.code} vs ${b.code}`).toBe(false)
        }
      }
    }
  })

  it('QuickOpen 避开官方 workspace.files 已占用的 Ctrl+P 组合', () => {
    const profiles = SHORTCUT_PROFILES['edrv.quickOpen']
    expect(profiles['desktop:windows']).toEqual({ code: 'KeyP', modifiers: ['primary', 'alt'] })
    expect(profiles['desktop:macos']).toEqual(profiles['desktop:windows'])
    expect(profiles['web:windows']).toEqual({ code: 'KeyP', modifiers: ['primary', 'alt', 'shift'] })
    expect(profiles['web:macos']).toEqual(profiles['web:windows'])
    expect(profiles['web:linux']).toBeUndefined()
  })

  it('保留命令：toggleSidebar 无默认键位（Ctrl+B 与官方 Mod+B 冲突）', () => {
    expect(Object.keys(SHORTCUT_PROFILES['edrv.toggleSidebar'])).toEqual([])
  })

  it('linux 列不含保留组合（Arrow/裸 F 键/全 Shift/Ctrl+C 系）', () => {
    const arrows = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
    const primaryReserved = ['KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY', 'KeyQ', 'KeyH']
    for (const [id, profiles] of Object.entries(SHORTCUT_PROFILES)) {
      for (const profile of ['desktop:linux', 'web:linux'] as ShortcutProfileKey[]) {
        const binding = profiles[profile]
        if (!binding) continue
        const isArrow = arrows.has(binding.code)
        const isBareF = /^F\d+$/u.test(binding.code) && binding.modifiers.length === 0
        const isShiftOnly = binding.modifiers.length > 0 && binding.modifiers.every((m) => m === 'shift')
        const isPrimaryReserved = binding.modifiers.includes('primary') && primaryReserved.includes(binding.code)
        expect(isArrow || isBareF || isShiftOnly || isPrimaryReserved, `${id}:${profile}`).toBe(false)
      }
    }
  })
})

describe('chordToBinding / bindingToChord', () => {
  it('修饰符与主键映射', () => {
    expect(chordToBinding('Ctrl+S')).toEqual({ code: 'KeyS', modifiers: ['primary'] })
    expect(chordToBinding('Ctrl+Alt+-')).toEqual({ code: 'Minus', modifiers: ['primary', 'alt'] })
    expect(chordToBinding('Alt+ArrowLeft')).toEqual({ code: 'ArrowLeft', modifiers: ['alt'] })
    expect(chordToBinding('F9')).toEqual({ code: 'F9', modifiers: [] })
    expect(chordToBinding('Shift+F11')).toEqual({ code: 'F11', modifiers: ['shift'] })
    expect(chordToBinding('Cmd+S')).toEqual({ code: 'KeyS', modifiers: ['primary'] })
    expect(chordToBinding('Ctrl+Space')).toEqual({ code: 'Space', modifiers: ['primary'] })
  })

  it('不可表示主键/非法弦返回 null', () => {
    expect(chordToBinding('Ctrl+PageDown')).toBeNull()
    expect(chordToBinding('Ctrl+Home')).toBeNull()
    expect(chordToBinding('')).toBeNull()
    expect(chordToBinding('Ctrl+')).toBeNull()
    expect(chordToBinding('Ctrl+A+B')).toBeNull()
  })

  it('primary 显示为 Ctrl；bindingToChord 不可表示返回 null', () => {
    expect(bindingToChord({ code: 'KeyS', modifiers: ['primary'] })).toBe('Ctrl+S')
    expect(bindingToChord({ code: 'Minus', modifiers: ['primary', 'alt'] })).toBe('Ctrl+Alt+-')
    expect(bindingToChord({ code: 'PageUp', modifiers: ['primary'] })).toBeNull()
    expect(bindingToChord({ code: 'KeyS', modifiers: ['primary'], secondCode: 'KeyD' })).toBe('Ctrl+S+D')
  })

  it('全部默认主候选弦 ↔ 官方绑定往返一致', () => {
    for (const chord of Object.values(KEYBINDING_DEFAULTS)) {
      const first = chord.split('|')[0]
      const binding = chordToBinding(first)
      expect(binding, first).not.toBeNull()
      expect(bindingToChord(binding as OfficialBinding), first).toBe(first)
    }
  })
})
