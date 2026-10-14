import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { bindEditActions, runEditAction } from '../src/client/monaco/editActions.js'
import { hasCodeFocus } from '../src/client/editorModelState.js'
import { officialCommandOf } from '../src/client/shortcutsOfficial.js'

afterEach(() => vi.unstubAllGlobals())

/** @private @author ddj 2026年10月12号 @returns Native-action contract test fixture, not a simulated Monaco edit algorithm. */
function fixture() {
  const dispose = vi.fn()
  const monaco = { KeyMod: { CtrlCmd: 2048 }, KeyCode: { Slash: 90, KeyD: 34 }, editor: {
    EditorOption: { readOnly: 91 }, addKeybindingRules: vi.fn(() => ({ dispose })),
  } }
  const editor = {
    getModel: vi.fn(() => ({} as unknown)), getOption: vi.fn(() => false as unknown),
    hasTextFocus: () => true, focus: vi.fn(), trigger: vi.fn(),
    createContextKey: vi.fn(() => ({ reset: vi.fn() })),
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })), addAction: vi.fn(() => ({ dispose: vi.fn() })),
  }
  return { editor, monaco, dispose }
}

describe('plugin-local native edit actions', () => {
  it.each(['editor.action.commentLine', 'editor.action.copyLinesDownAction'])('forwards %s without reinventing native undo or selection semantics', (action) => {
    const { editor, monaco } = fixture()
    expect(runEditAction(editor, monaco, action)).toBe(true)
    expect(editor.focus).toHaveBeenCalledOnce()
    expect(editor.trigger).toHaveBeenCalledWith('edrv-edit', action, null)
    editor.getOption.mockReturnValue(true)
    expect(runEditAction(editor, monaco, action)).toBe(false)
    editor.getOption.mockReturnValue(false)
    editor.getModel.mockReturnValue(null)
    expect(runEditAction(editor, monaco, action)).toBe(false)
    expect(editor.trigger).toHaveBeenCalledOnce()
  })
  it('overrides Ctrl+/ with empty scoped pass-through and Ctrl+D with native copy', () => {
    const { editor, monaco, dispose } = fixture()
    const release = bindEditActions(editor, monaco)
    expect(monaco.editor.addKeybindingRules).toHaveBeenCalledWith([
      { keybinding: 2048 | 90, command: '', when: 'edrvLocalEdit && editorTextFocus' },
      { keybinding: 2048 | 34, command: 'editor.action.copyLinesDownAction', when: 'edrvLocalEdit && editorTextFocus && !editorReadonly' },
    ])
    const actions = editor.addAction.mock.calls as unknown as Array<[{ id: string; label: string; run(): void }]>
    expect(actions[0][0]).toMatchObject({ id: 'edrv.toggleComment', label: '切换行注释' })
    actions[0][0].run(); actions[1][0].run()
    expect(editor.trigger.mock.calls).toEqual([
      ['edrv-edit', 'editor.action.commentLine', null],
      ['edrv-edit', 'editor.action.copyLinesDownAction', null],
    ])
    const handles = editor.addAction.mock.results.map((result) => result.value)
    release(); release()
    expect(dispose).toHaveBeenCalledOnce()
    for (const handle of handles) expect(handle.dispose).toHaveBeenCalledOnce()
    expect(editor.createContextKey.mock.results[0].value.reset).toHaveBeenCalledOnce()
    expect(editor.onDidDispose.mock.results[0].value.dispose).toHaveBeenCalledOnce()
  })
  it('registers native actions in EditorView and reload only at client root', () => {
    const view = readFileSync(new URL('../src/client/ui/EditorView.ts', import.meta.url), 'utf8')
    const root = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
    expect(view).toContain('bindEditActions(ed, m)')
    expect(view).toContain('addReloadGuard({ check: checkReload, prepare: prepareReload })')
    expect(view).toContain('saveTimerRef.current.isPending() || savingRef.current.size')
    expect(view).toContain('ctl.isDirty?.()')
    expect(view).toContain('readSync(scope, path)')
    expect(root).toContain('installPageReload(flushPageState, notifyReload)')
    expect(view).not.toContain('installPageReload(')
  })
  it('limits official shortcuts to code input and passes outside it or in a modal', () => {
    const editorNode = { classList: { contains: () => false } }
    class FakeElement {
      constructor(public input: boolean) {}
      closest(selector: string) { return this.input && selector.includes('monaco-editor') ? editorNode : null }
    }
    vi.stubGlobal('window', { monaco: { editor: { getEditors: () => [{ getDomNode: () => editorNode, hasTextFocus: () => true, getModel: () => ({}) }] } } })
    vi.stubGlobal('Element', FakeElement)
    const code = new FakeElement(true)
    vi.stubGlobal('document', { activeElement: code, querySelector: () => null })
    const runner = { isAvailable: () => true, run: vi.fn(() => true) }
    const def = officialCommandOf({ id: 'edrv.toggleComment', label: 'comment' }, runner)
    expect(hasCodeFocus(code)).toBe(true)
    const result = def.resolve({ region: 'editable', modal: null, target: code })
    expect(result.status).toBe('handled')
    if (result.status === 'handled') result.run()
    expect(runner.run).toHaveBeenCalledOnce()
    expect(def.resolve({ region: 'editable', modal: null, target: new FakeElement(false) }).status).toBe('pass')
    expect(def.resolve({ region: 'editable', modal: 'shortcuts', target: code }).status).toBe('pass')
  })
})
