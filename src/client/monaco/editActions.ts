/** Plugin-local Monaco editing bindings. @author ddj 2026年10月12号 */
export interface EditTarget {
  getModel(): unknown
  getOption(option: number): unknown
  hasTextFocus(): boolean
  focus(): void
  trigger(source: string, action: string, payload: null): void
  createContextKey(name: string, value: boolean): { reset(): void }
  onDidDispose(listener: () => void): { dispose(): void }
  addAction(action: { id: string; label: string; precondition: string; contextMenuGroupId: string; run(): void }): { dispose(): void }
}
export interface EditMonaco {
  KeyMod: { CtrlCmd: number }
  KeyCode: { Slash: number; KeyD: number }
  editor: {
    EditorOption: { readOnly: number }
    addKeybindingRules(rules: Array<{ keybinding: number; command: string; when: string }>): { dispose(): void }
  }
}

/** @public @author ddj 2026年10月12号 @param editor Target editor. @param monaco Monaco API. @param action Native action. @returns Whether a writable model accepted the action. @sideEffects Restores focus and runs an undoable native edit. */
export function runEditAction(editor: EditTarget | null, monaco: EditMonaco | null, action: string): boolean {
  if (!editor?.getModel() || !monaco || editor.getOption(monaco.editor.EditorOption.readOnly)) return false
  editor.focus()
  editor.trigger('edrv-edit', action, null)
  return true
}

/** @public @author ddj 2026年10月12号 @param editor Plugin editor. @param monaco Monaco API. @returns Idempotent disposer. @sideEffects Overrides only plugin-local bindings and menu entries until editor disposal. */
export function bindEditActions(editor: EditTarget, monaco: EditMonaco): () => void {
  const local = editor.createContextKey('edrvLocalEdit', true)
  const focus = 'edrvLocalEdit && editorTextFocus'
  const writable = focus + ' && !editorReadonly'
  const rules = monaco.editor.addKeybindingRules([
    { keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash, command: '', when: focus },
    { keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyD, command: 'editor.action.copyLinesDownAction', when: writable },
  ])
  /** @private @author ddj 2026年10月12号 Runs the native language-aware comment action. */
  const comment = (): void => { runEditAction(editor, monaco, 'editor.action.commentLine') }
  /** @private @author ddj 2026年10月12号 Runs the native multi-selection line-copy action. */
  const duplicate = (): void => { runEditAction(editor, monaco, 'editor.action.copyLinesDownAction') }
  const actions = [
    editor.addAction({ id: 'edrv.toggleComment', label: '切换行注释', precondition: writable, contextMenuGroupId: '1_edrv', run: comment }),
    editor.addAction({ id: 'edrv.duplicateLine', label: '向下复制行（Ctrl+D，编辑器本地）', precondition: writable, contextMenuGroupId: '1_edrv', run: duplicate }),
  ]
  let disposed = false
  /** @private @author ddj 2026年10月12号 Releases global rule contributions owned by this instance. */
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    rules.dispose()
    for (const action of actions) action.dispose()
    local.reset()
    lifetime.dispose()
  }
  const lifetime = editor.onDidDispose(dispose)
  return dispose
}
