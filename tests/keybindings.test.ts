/**
 * 快捷键模块与设置页草稿逻辑测试。
 * 作者 ddj 2026-08-26
 */
import { describe, expect, it } from 'vitest'
import {
  COMMANDS, bindingsOf, chordFromEvent, chordOf, formatChord, keybindingsApply,
  matchEvent, normalizeKey, parseChord, parseChords,
} from '../src/client/keybindings.js'
import { draftOf, storeOf, conflictsOf } from '../src/client/ui/KeybindingsPanel.js'
import { defaultKeybindings, KEYBINDING_DEFAULTS, normalizeKeybindings } from '../src/shared/keybindings.js'

describe('keybindings shared defaults', () => {
  it('declares every editor command with defaults', () => {
    expect(KEYBINDING_DEFAULTS).toEqual({
      'edrv.save': 'Ctrl+S',
      'edrv.quickOpen': 'Ctrl+P',
      'edrv.toggleSidebar': 'Ctrl+B',
      'edrv.searchInFiles': 'Ctrl+Shift+F',
      'edrv.navigateBack': 'Alt+ArrowLeft|Ctrl+Alt+-',
      'edrv.navigateForward': 'Alt+ArrowRight|Ctrl+Shift+-',
      'edrv.nextTab': 'Ctrl+Alt+ArrowRight|Ctrl+PageDown',
      'edrv.prevTab': 'Ctrl+Alt+ArrowLeft|Ctrl+PageUp',
      'edrv.showCommands': 'Ctrl+Shift+P|F1',
      'edrv.nextEditorRow': 'Ctrl+Alt+ArrowDown',
      'edrv.prevEditorRow': 'Ctrl+Alt+ArrowUp',
      'edrv.addSelectionRef': 'Ctrl+U',
    })
  })

  it('添加选中内容为引用（Ctrl+U）可解析命中，Ctrl+Shift+U 不误命中', () => {
    keybindingsApply({})
    expect(chordOf('edrv.addSelectionRef')).toBe('Ctrl+U')
    expect(matchEvent({ ctrlKey: true, key: 'u' }, bindingsOf('edrv.addSelectionRef'))).toBe(true)
    expect(matchEvent({ ctrlKey: true, shiftKey: true, key: 'U' }, bindingsOf('edrv.addSelectionRef'))).toBe(false)
    expect(matchEvent({ ctrlKey: true, key: 'S' }, bindingsOf('edrv.addSelectionRef'))).toBe(false)
  })

  it('命令栏键位（Ctrl+Shift+P / F1）可解析并命中，且不与既有键位冲突', () => {
    keybindingsApply({})
    expect(chordOf('edrv.showCommands')).toBe('Ctrl+Shift+P|F1')
    expect(matchEvent({ ctrlKey: true, shiftKey: true, key: 'P' }, bindingsOf('edrv.showCommands'))).toBe(true)
    expect(matchEvent({ key: 'F1' }, bindingsOf('edrv.showCommands'))).toBe(true)
    // 缺 Shift 的 Ctrl+P 仍是快速打开，不得命中命令栏
    expect(matchEvent({ ctrlKey: true, key: 'P' }, bindingsOf('edrv.showCommands'))).toBe(false)
  })

  it('returns independent copies', () => {
    const a = defaultKeybindings()
    a['edrv.save'] = 'X'
    expect(KEYBINDING_DEFAULTS['edrv.save']).toBe('Ctrl+S')
  })

  it('drops unknown ids and non-strings when normalizing', () => {
    expect(normalizeKeybindings({ 'edrv.save': 'Ctrl+Alt+S', ghost: 'Ctrl+Z', 'edrv.searchInFiles': 42 }))
      .toEqual({ 'edrv.save': 'Ctrl+Alt+S' })
  })
})

describe('页签循环键位（编辑器自带分页）', () => {
  it('命令目录含下一/上一页签，默认键位可解析并命中', () => {
    const ids = COMMANDS.map((c) => c.id)
    expect(ids).toContain('edrv.nextTab')
    expect(ids).toContain('edrv.prevTab')
    keybindingsApply({})
    expect(chordOf('edrv.nextTab')).toBe('Ctrl+Alt+ArrowRight|Ctrl+PageDown')
    expect(chordOf('edrv.prevTab')).toBe('Ctrl+Alt+ArrowLeft|Ctrl+PageUp')
    expect(matchEvent({ ctrlKey: true, altKey: true, key: 'ArrowRight' }, bindingsOf('edrv.nextTab'))).toBe(true)
    expect(matchEvent({ ctrlKey: true, key: 'PageDown' }, bindingsOf('edrv.nextTab'))).toBe(true)
    expect(matchEvent({ ctrlKey: true, key: 'PageUp' }, bindingsOf('edrv.prevTab'))).toBe(true)
    // 缺 Alt 的 Ctrl+→ 不应命中（避免与普通光标操作冲突）
    expect(matchEvent({ ctrlKey: true, key: 'ArrowRight' }, bindingsOf('edrv.nextTab'))).toBe(false)
  })
})

describe('parseChord / formatChord', () => {
  it('parses modifier chords', () => {
    expect(parseChord('Ctrl+Shift+F')).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: 'F' })
    expect(parseChord('Ctrl+S')).toEqual({ ctrl: true, shift: false, alt: false, meta: false, key: 'S' })
  })

  it('parses multi-candidate chords (| separator)', () => {
    expect(parseChords('Alt+ArrowLeft|Ctrl+Alt+-')).toEqual([
      { ctrl: false, shift: false, alt: true, meta: false, key: 'ArrowLeft' },
      { ctrl: true, shift: false, alt: true, meta: false, key: '-' },
    ])
  })

  it('drops invalid segments and dedupes multi-candidates', () => {
    // 注意：单 token 是合法单键键位（F5 风格），非法段须是「双主键」或纯修饰符
    expect(parseChords('Alt+X|Ctrl+P+Q|Alt+X||Ctrl')).toEqual([
      { ctrl: false, shift: false, alt: true, meta: false, key: 'X' },
    ])
    expect(parseChords('')).toEqual([])
    expect(parseChords(null as unknown as string)).toEqual([])
    expect(parseChords('|||')).toEqual([])
  })

  it('accepts lowercase modifiers and letters', () => {
    expect(parseChord('ctrl+shift+f')).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: 'F' })
  })

  it('keeps plain single keys (F5 style)', () => {
    expect(parseChord('F5')).toEqual({ ctrl: false, shift: false, alt: false, meta: false, key: 'F5' })
  })

  it('rejects empty, modifier-only and double-key chords', () => {
    expect(parseChord('')).toBeNull()
    expect(parseChord('Ctrl')).toBeNull()
    expect(parseChord('Ctrl+Shift')).toBeNull()
    expect(parseChord('Ctrl+P+Q')).toBeNull()
    expect(parseChord(null as unknown as string)).toBeNull()
  })

  it('formats back to canonical chord', () => {
    expect(formatChord({ ctrl: true, shift: true, alt: false, meta: false, key: 'F' })).toBe('Ctrl+Shift+F')
    expect(formatChord({ ctrl: false, shift: false, alt: false, meta: true, key: 'P' })).toBe('Cmd+P')
    expect(formatChord({ ctrl: false, shift: false, alt: true, meta: false, key: 'X' })).toBe('Alt+X')
  })
})

describe('normalizeKey / matchEvent', () => {
  it('normalizes letters and space', () => {
    expect(normalizeKey('f')).toBe('F')
    expect(normalizeKey(' ')).toBe('Space')
    expect(normalizeKey('ArrowUp')).toBe('ArrowUp')
  })

  it('matches modifier combinations and interchanges Ctrl/Meta', () => {
    const binding = parseChord('Ctrl+Shift+F')
    expect(matchEvent({ ctrlKey: true, shiftKey: true, key: 'F' }, binding)).toBe(true)
    expect(matchEvent({ metaKey: true, shiftKey: true, key: 'f' }, binding)).toBe(true)
    expect(matchEvent({ ctrlKey: true, shiftKey: false, key: 'F' }, binding)).toBe(false)
    expect(matchEvent({ ctrlKey: true, shiftKey: true, altKey: true, key: 'F' }, binding)).toBe(false)
    expect(matchEvent({ ctrlKey: true, shiftKey: true, key: 'G' }, binding)).toBe(false)
  })

  it('never matches unbound or null bindings', () => {
    expect(matchEvent({ ctrlKey: true, key: 'S' }, null)).toBe(false)
    expect(matchEvent({ ctrlKey: true, key: 'S' }, parseChord(''))).toBe(false)
    expect(matchEvent({ ctrlKey: true, key: 'S' }, [])).toBe(false)
  })

  it('matches any candidate of a multi-chord binding', () => {
    const bindings = parseChords('Alt+ArrowLeft|Ctrl+Alt+-')
    expect(matchEvent({ altKey: true, key: 'ArrowLeft' }, bindings)).toBe(true)
    expect(matchEvent({ ctrlKey: true, altKey: true, key: '-' }, bindings)).toBe(true)
    expect(matchEvent({ altKey: true, key: 'ArrowRight' }, bindings)).toBe(false)
  })
})

describe('chordFromEvent (recording)', () => {
  it('builds chords from events and ignores modifier-only keys', () => {
    expect(chordFromEvent({ ctrlKey: true, key: 's' })).toBe('Ctrl+S')
    expect(chordFromEvent({ ctrlKey: true, altKey: true, key: 'x' })).toBe('Ctrl+Alt+X')
    expect(chordFromEvent({ key: 'Shift' })).toBeNull()
    expect(chordFromEvent({ key: 'Control' })).toBeNull()
  })
})

describe('keybindingsApply module state', () => {
  it('merges overrides with defaults and drops unknown ids', () => {
    keybindingsApply({ 'edrv.save': 'Ctrl+Alt+S', ghost: 'Ctrl+Z' })
    expect(chordOf('edrv.save')).toBe('Ctrl+Alt+S')
    expect(chordOf('edrv.quickOpen')).toBe('Ctrl+P')
    expect(bindingsOf('edrv.save')).toEqual([{ ctrl: true, alt: true, shift: false, meta: false, key: 'S' }])
    expect(bindingsOf('edrv.navigateBack')).toEqual([
      { ctrl: false, shift: false, alt: true, meta: false, key: 'ArrowLeft' },
      { ctrl: true, shift: false, alt: true, meta: false, key: '-' },
    ])
    keybindingsApply(undefined)
    expect(chordOf('edrv.save')).toBe('Ctrl+S')
  })

  it('treats empty chord as unbound', () => {
    keybindingsApply({ 'edrv.toggleSidebar': '' })
    expect(chordOf('edrv.toggleSidebar')).toBeNull()
    expect(bindingsOf('edrv.toggleSidebar')).toEqual([])
    keybindingsApply(undefined)
  })
})

describe('KeybindingsPanel draft helpers', () => {
  it('merges defaults, normalizes empty to null', () => {
    const draft = draftOf({ 'edrv.save': '', 'edrv.quickOpen': 'Ctrl+Shift+P' })
    expect(draft['edrv.save']).toBeNull()
    expect(draft['edrv.quickOpen']).toBe('Ctrl+Shift+P')
    expect(draft['edrv.searchInFiles']).toBe('Ctrl+Shift+F')
  })

  it('stores null as empty string and keeps overrides', () => {
    expect(storeOf({ 'edrv.save': null, 'edrv.quickOpen': 'Ctrl+Shift+P' }))
      .toEqual({ 'edrv.save': '', 'edrv.quickOpen': 'Ctrl+Shift+P' })
  })

  it('flags commands sharing one chord', () => {
    const draft = { 'edrv.save': 'Ctrl+S', 'edrv.quickOpen': 'Ctrl+P', 'edrv.toggleSidebar': 'Ctrl+S', 'edrv.searchInFiles': 'Ctrl+Shift+F' }
    const conflicts = conflictsOf(draft)
    expect(conflicts.has('edrv.save')).toBe(true)
    expect(conflicts.has('edrv.toggleSidebar')).toBe(true)
    expect(conflicts.has('edrv.quickOpen')).toBe(false)
  })
})
