/**
 * 快捷键模块与官方目录弦表同步测试。
 * 弦表（chordOf/bindingsOf）由官方 shortcuts 目录驱动：测试用
 * SHORTCUT_PROFILES → bindingToChord 派生弦表，等价线上 bindCatalogChords 的产物。
 * 作者 ddj 2026-08-26 / 2026年10月
 */
import { describe, expect, it } from 'vitest'
import {
  COMMANDS, applyOfficialChords, bindingsOf, chordFromEvent, chordOf, formatChord,
  matchEvent, normalizeKey, parseChord, parseChords,
} from '../src/client/keybindings.js'
import {
  bindingToChord, defaultKeybindings, KEYBINDING_DEFAULTS, normalizeKeybindings,
  SHORTCUT_PROFILES, type ShortcutProfiles,
} from '../src/shared/keybindings.js'

/** 按 SHORTCUT_PROFILES 派生官方目录弦表（等价 shortcutsOfficial.bindCatalogChords 的产物）。 */
function officialChordsOf(profiles: Record<string, ShortcutProfiles>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, profile] of Object.entries(profiles)) {
    for (const binding of Object.values(profile)) {
      if (!binding) continue
      const chord = bindingToChord(binding)
      if (chord !== null) {
        out[id] = chord
        break
      }
    }
  }
  return out
}

/** 模拟官方目录首次同步（默认键位）。 */
function applyOfficialDefaults(): void {
  applyOfficialChords(officialChordsOf(SHORTCUT_PROFILES))
}

describe('keybindings shared defaults', () => {
  it('declares every editor command with defaults', () => {
    expect(KEYBINDING_DEFAULTS).toEqual({
      'edrv.save': 'Ctrl+S',
      'edrv.quickOpen': 'Ctrl+P',
      'edrv.toggleSidebar': 'Ctrl+B',
      'edrv.searchInFiles': 'Ctrl+Shift+F',
      'edrv.toggleMarkdownPreview': 'Ctrl+Shift+V',
      'edrv.navigateBack': 'Alt+ArrowLeft|Ctrl+Alt+-',
      'edrv.navigateForward': 'Alt+ArrowRight|Ctrl+Shift+-',
      'edrv.nextTab': 'Ctrl+Alt+ArrowRight|Ctrl+PageDown',
      'edrv.prevTab': 'Ctrl+Alt+ArrowLeft|Ctrl+PageUp',
      'edrv.goToLine': 'Ctrl+G',
      'edrv.showCommands': 'Ctrl+Shift+P|F1',
      'edrv.nextEditorRow': 'Ctrl+Alt+ArrowDown',
      'edrv.prevEditorRow': 'Ctrl+Alt+ArrowUp',
      'edrv.addSelectionRef': 'Ctrl+U',
      'edrv.closeTab': 'Ctrl+F4',
      // 调试（VS Code 同款；F5 空闲时可用性为假自动放行浏览器刷新）
      'edrv.debugToggleBreakpoint': 'F9',
      'edrv.debugStartContinue': 'F5',
      'edrv.debugStepOver': 'F10',
      'edrv.debugStepInto': 'F11',
      'edrv.debugStepOut': 'Shift+F11',
      'edrv.debugStop': 'Shift+F5',
    })
  })

  it('关闭当前页签键位（Ctrl+F4）可解析命中；不绑 Ctrl+W（浏览器会截获）', () => {
    applyOfficialDefaults()
    expect(chordOf('edrv.closeTab')).toBe('Ctrl+F4')
    expect(matchEvent({ ctrlKey: true, key: 'F4' }, bindingsOf('edrv.closeTab'))).toBe(true)
    // Ctrl+F4 缺 Ctrl（裸 F4）不命中；Ctrl+W 不在目录里
    expect(matchEvent({ key: 'F4' }, bindingsOf('edrv.closeTab'))).toBe(false)
    expect(Object.values(KEYBINDING_DEFAULTS)).not.toContain('Ctrl+W')
  })

  it('转到行（Ctrl+G）可解析命中，裸 G / Ctrl+Shift+G 不误命中', () => {
    applyOfficialDefaults()
    expect(chordOf('edrv.goToLine')).toBe('Ctrl+G')
    expect(matchEvent({ ctrlKey: true, key: 'g' }, bindingsOf('edrv.goToLine'))).toBe(true)
    expect(matchEvent({ key: 'g' }, bindingsOf('edrv.goToLine'))).toBe(false)
    expect(matchEvent({ ctrlKey: true, shiftKey: true, key: 'G' }, bindingsOf('edrv.goToLine'))).toBe(false)
  })

  it('添加选中内容为引用（Ctrl+U）可解析命中，Ctrl+Shift+U 不误命中', () => {
    applyOfficialDefaults()
    expect(chordOf('edrv.addSelectionRef')).toBe('Ctrl+U')
    expect(matchEvent({ ctrlKey: true, key: 'u' }, bindingsOf('edrv.addSelectionRef'))).toBe(true)
    expect(matchEvent({ ctrlKey: true, shiftKey: true, key: 'U' }, bindingsOf('edrv.addSelectionRef'))).toBe(false)
    expect(matchEvent({ ctrlKey: true, key: 'S' }, bindingsOf('edrv.addSelectionRef'))).toBe(false)
  })

  it('命令栏键位（官方仅 Ctrl+Shift+P；F1 候选随官方机制废弃）可解析并命中', () => {
    applyOfficialDefaults()
    expect(chordOf('edrv.showCommands')).toBe('Ctrl+Shift+P')
    expect(matchEvent({ ctrlKey: true, shiftKey: true, key: 'P' }, bindingsOf('edrv.showCommands'))).toBe(true)
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

describe('页签循环键位（官方派发，Ctrl+PageDown 候选随官方机制废弃）', () => {
  it('命令目录含下一/上一页签，默认键位可解析并命中', () => {
    const ids = COMMANDS.map((c) => c.id)
    expect(ids).toContain('edrv.nextTab')
    expect(ids).toContain('edrv.prevTab')
    applyOfficialDefaults()
    expect(chordOf('edrv.nextTab')).toBe('Ctrl+Alt+ArrowRight')
    expect(chordOf('edrv.prevTab')).toBe('Ctrl+Alt+ArrowLeft')
    expect(matchEvent({ ctrlKey: true, altKey: true, key: 'ArrowRight' }, bindingsOf('edrv.nextTab'))).toBe(true)
    expect(matchEvent({ ctrlKey: true, altKey: true, key: 'ArrowLeft' }, bindingsOf('edrv.prevTab'))).toBe(true)
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

describe('applyOfficialChords module state', () => {
  it('官方目录弦表全量替换（旧目录残留不得泄漏）', () => {
    applyOfficialDefaults()
    expect(chordOf('edrv.save')).toBe('Ctrl+S')
    applyOfficialChords({ 'edrv.save': 'Ctrl+Alt+S' })
    expect(chordOf('edrv.save')).toBe('Ctrl+Alt+S')
    expect(chordOf('edrv.quickOpen')).toBeNull()
    expect(bindingsOf('edrv.save')).toEqual([{ ctrl: true, alt: true, shift: false, meta: false, key: 'S' }])
  })

  it('目录未就绪（空弦表）时全部视为未绑定', () => {
    applyOfficialChords({})
    expect(chordOf('edrv.save')).toBeNull()
    expect(bindingsOf('edrv.save')).toEqual([])
  })

  it('空弦条目按未绑定处理（用户显式清空）', () => {
    applyOfficialChords({ 'edrv.toggleSidebar': '' })
    expect(chordOf('edrv.toggleSidebar')).toBeNull()
    expect(bindingsOf('edrv.toggleSidebar')).toEqual([])
  })

  it('官方目录不派生 toggleSidebar 弦（Ctrl+B 冲突保留，默认未绑定）', () => {
    applyOfficialDefaults()
    expect(chordOf('edrv.toggleSidebar')).toBeNull()
  })
})
