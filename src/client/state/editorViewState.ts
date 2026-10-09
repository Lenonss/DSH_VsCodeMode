/** Model-owned view/find lifecycle; ddj 2026年10月09号. */
import { createFindBridge, type FindEditor } from './editorFindState.js'
import { upsertViewState, viewStatesLoad, viewStatesSave } from './viewStateCache.js'

export interface ViewEditor extends FindEditor {
  getModel(): unknown
  setModel(model: unknown): void
  saveViewState(): unknown
  restoreViewState(state: unknown): void
  dispose(): void
}

/** @public @author ddj 2026年10月09号 @param editor Monaco instance. @returns Keeper owning the model's scope/path, independent of React's active closure. */
export function createViewKeeper(editor: ViewEditor) {
  const find = createFindBridge(editor)
  let bound: { scope: string; path: string; model: unknown } | null = null
  let disposed = false

  /** @public @author ddj 2026年10月09号 @param path Optional expected path; mismatches never write a snapshot under the wrong file. Persist viewport even if cursor never moved. */
  function save(path?: string): void {
    if (disposed || !bound || (path && path !== bound.path)) return
    try {
      if (editor.getModel() !== bound.model) return
      const states = viewStatesLoad(bound.scope)
      const next = upsertViewState(states, bound.path, editor.saveViewState())
      if (next !== states) viewStatesSave(bound.scope, next)
    } catch { /* A missing/disposed model must not overwrite a valid snapshot. */ }
  }

  /** @public @author ddj 2026年10月09号 @param scope Model workspace. @param path Cache path. @param model Ready text model. Restore only on identity change, before explicit navigation effects. */
  function bind(scope: string, path: string, model: unknown): void {
    if (disposed || !path || !model) return
    if (bound?.scope === scope && bound.path === path && bound.model === model
      && editor.getModel() === model) return
    save()
    find.pause()
    if (editor.getModel() !== model) editor.setModel(model)
    bound = { scope, path, model }
    const state = viewStatesLoad(scope)[path]
    if (state) {
      try { editor.restoreViewState(state) } catch { /* Stale fold ranges may be invalid. */ }
    }
    find.resume(scope)
  }

  /** @public @author ddj 2026年10月09号 Save before dispose/ref clearing; repeated cleanup is a no-op. */
  function dispose(): void {
    if (disposed) return
    save()
    find.dispose()
    disposed = true
    bound = null
    editor.dispose()
  }
  return { save, bind, dispose }
}
