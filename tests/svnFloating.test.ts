import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

/** @private @author ddj 2026年10月14号 @param name UI module basename. @returns Current production source for wiring assertions. */
function source(name: string): string { return readFileSync(new URL('../src/client/ui/' + name + '.ts', import.meta.url), 'utf8') }
/** @private @author ddj 2026年10月14号 @param text Production source. @param name Named function. @param scope Explicit runtime dependencies. @returns Executable real callback. */
function callback(text: string, name: string, scope: Record<string, unknown>): (...args: any[]) => any {
  const file = ts.createSourceFile('ui.ts', text, ts.ScriptTarget.Latest, true)
  let body = ''
  /** @private @author ddj 2026年10月14号 @param node Production AST node. Locate actual callback without recreating its behavior. */
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) body = node.getText(file)
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!body) throw new Error('Missing callback: ' + name)
  return new Function(...Object.keys(scope), ts.transpile(body) + '; return ' + name)(...Object.values(scope))
}

const editor = source('EditorView')
describe('SVN nonmodal window wiring', () => {
  it.each(['SvnUpdateDialog', 'SvnLogDialog', 'SvnLogStats', 'SvnPatchDialog', 'SvnSumDialog', 'SvnAiPlanDialog'])('%s uses shared editor window chrome', (name) => {
    expect(source(name)).toContain('React.createElement(FloatingWindow, {')
    expect(source(name)).toContain("from './FloatingWindow.js'")
  })
  it('keeps ordinary confirmation/range modal and editor-return semantics', () => {
    expect(source('SvnLogDialog')).toContain('React.createElement(ModalShell, {')
    expect(source('FloatingEditor')).toContain('React.createElement(FloatingWindow, {')
    expect(source('FloatingEditor')).toContain('props.onReturn(props.group)')
    expect(source('SvnUpdateDialog')).toContain('closeOnEsc: closeMode.passive, onClose: dismiss')
    expect(source('SvnAiPlanDialog')).toContain('closeOnEsc: !running')
  })
  it('mounts diff independently in both render paths and preserves all diff guards', () => {
    expect(editor).not.toContain('} else if (svnDiff) {')
    expect(editor.match(/\n\s+svnDiffEl,/g)).toHaveLength(2)
    expect(editor).toContain("title: '文件对比 · ' + baseNameOf(svnDiff.path)")
    expect(editor).toContain('...svnDiff, key:')
    expect(editor).toContain('blocked: false')
    expect(editor).not.toContain('&& !svnDiff')
    const open = editor.slice(editor.indexOf('const openFile ='), editor.indexOf('function receiptReady'))
    expect(open).not.toContain('setSvnDiff(null)')
  })
  it('restores the same update dialog/job only for the update diff return path', () => {
    const setSvnDiff = vi.fn(); const setSvnUpdateDialog = vi.fn(); const setSvnUpdateReturn = vi.fn()
    const dialog = { jobId: 'original-job' }
    callback(editor, 'closeSvnDiff', { setSvnDiff, setSvnUpdateDialog, setSvnUpdateReturn, svnUpdateReturn: { from: 'diff', dialog } })()
    expect(setSvnDiff).toHaveBeenCalledWith(null); expect(setSvnUpdateDialog).toHaveBeenCalledWith(dialog)
    expect(setSvnUpdateReturn).toHaveBeenCalledWith(null)
    setSvnUpdateDialog.mockClear()
    callback(editor, 'closeSvnDiff', { setSvnDiff, setSvnUpdateDialog, setSvnUpdateReturn, svnUpdateReturn: null })()
    expect(setSvnUpdateDialog).not.toHaveBeenCalled()
  })
})

describe('real log keyboard callback isolation', () => {
  const text = source('SvnLogDialog')
  it('has no page-level key listener and observes content size for pane fitting', () => {
    expect(text).not.toContain("window.addEventListener('keydown'")
    expect(text).toContain('onKeyDown: onLogKey')
    expect(text).toContain('new ResizeObserver')
    expect(text).toContain('observer.disconnect()')
  })
  it('skips text controls and nested range/menu; arrows operate only log selection', () => {
    const sorted = [{ revision: 3 }, { revision: 2 }]
    const onRefresh = vi.fn(); const setSelected = vi.fn(); const setAnchorRev = vi.fn()
    const scope = { sorted, selected: [sorted[0]], onRefresh, setSelected, setAnchorRev, menu: null, rangeOpen: false, inputOwnsKey: () => false }
    const event = { key: 'ArrowDown', target: {}, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    callback(text, 'onLogKey', scope)(event)
    expect(setSelected).toHaveBeenCalledWith([sorted[1]]); expect(setAnchorRev).toHaveBeenCalledWith(2)
    setSelected.mockClear()
    for (const override of [{ inputOwnsKey: () => true }, { menu: {} }, { rangeOpen: true }]) callback(text, 'onLogKey', { ...scope, ...override })(event)
    expect(setSelected).not.toHaveBeenCalled()
    callback(text, 'onLogKey', scope)({ ...event, key: 'F5' }); expect(onRefresh).toHaveBeenCalledTimes(1)
  })
})
