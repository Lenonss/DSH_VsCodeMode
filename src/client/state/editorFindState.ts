/**
 * Workspace-local Ctrl+F state bridge; ddj 2026年10月09号.
 *
 * 快照键语义（ddj 2026年10月16号）：键由调用方传入（findKey），不再限定为工作区 scope——
 * 编辑器按分组隔离搜索框时传「scope + 分组 id」组合键；旧调用传 scope 时行为完全不变。
 */
export interface FindSnapshot {
  searchString: string
  isRevealed: boolean
  matchCase: boolean
  wholeWord: boolean
  isRegex: boolean
}

interface FindState extends FindSnapshot {
  change(value: Partial<FindSnapshot> & { searchScope?: null }, moveCursor: boolean): void
  onFindReplaceStateChange(listener: () => void): { dispose(): void }
}
interface FindController {
  getState(): FindState
  start(options: Record<string, unknown>, state: FindSnapshot & { searchScope: null }): Promise<unknown>
}
export interface FindEditor {
  getContribution(id: string): unknown
}
const snapshots = new Map<string, FindSnapshot>()

/** @private @author ddj 2026年10月09号 @param state Native find state. @returns Only fields safe to share across files. */
function snapshotOf(state: FindState): FindSnapshot {
  return {
    searchString: state.searchString, isRevealed: state.isRevealed,
    matchCase: state.matchCase, wholeWord: state.wholeWord, isRegex: state.isRegex,
  }
}

/** @private @author ddj 2026年10月09号 @param editor Monaco editor. @returns Supported controller, or null for native-only fallback. */
function controllerOf(editor: FindEditor): FindController | null {
  try {
    const controller = editor.getContribution('editor.contrib.findController') as FindController | null
    const state = controller?.getState?.()
    return state && typeof state.change === 'function'
      && typeof state.onFindReplaceStateChange === 'function'
      && typeof controller?.start === 'function' ? controller : null
  } catch { return null }
}

/** @private @author ddj 2026年10月09号 @param controller Optional native controller. @param listener State observer. @returns Disposable subscription, or null when the internal API is incompatible. */
function listenFind(controller: FindController | null, listener: () => void): { dispose(): void } | null {
  try { return controller?.getState().onFindReplaceStateChange(listener) ?? null } catch { return null }
}

/** @private @author ddj 2026年10月09号 @param controller Native controller. @param saved Workspace snapshot. @returns Completion when revealing; never focuses or seeds from selection. */
function applyFind(controller: FindController, saved: FindSnapshot): Promise<unknown> | void {
  const value = { ...saved, searchScope: null }
  if (!saved.isRevealed) { controller.getState().change(value, false); return }
  return controller.start({
    forceRevealReplace: false, seedSearchStringFromSelection: 'none',
    seedSearchStringFromNonEmptySelection: false, seedSearchStringFromGlobalClipboard: false,
    shouldFocus: 0, shouldAnimate: false, updateSearchScope: false, loop: true,
  }, value)
}

/** @public @author ddj 2026年10月09号 @param editor Monaco editor. @returns Model-switch bridge; dispose releases the native listener. */
export function createFindBridge(editor: FindEditor) {
  const controller = controllerOf(editor)
  let findKey: string | null = null
  let paused = true
  let disposed = false

  /** @private @author ddj 2026年10月16号 Capture only user changes into the current findKey bucket, not model-reset or restoration events. */
  function capture(): void {
    if (disposed || paused || !findKey || !controller) return
    try {
      const saved = snapshotOf(controller.getState())
      snapshots.delete(findKey)
      snapshots.set(findKey, saved)
      if (snapshots.size > 20) snapshots.delete(snapshots.keys().next().value!)
    } catch { /* A disposed contribution must not interrupt view capture. */ }
  }
  const listener = listenFind(controller, capture)

  /** @public @author ddj 2026年10月09号 Save before setModel; suppress Monaco's per-model option resets. */
  function pause(): void { capture(); paused = true }

  /** @public @author ddj 2026年10月16号 @param nextKey Bucket owning the bound view（scope 或 scope+分组 id 组合键）. Restore with moveCursor=false; no per-file range or match index. */
  function resume(nextKey: string): void {
    if (disposed || !controller) return
    findKey = nextKey
    const saved = snapshots.get(findKey) ?? {
      searchString: '', isRevealed: false, matchCase: false, wholeWord: false, isRegex: false,
    }
    try {
      const result = applyFind(controller, saved)
      result?.catch(() => {}) // Unsupported internal API leaves native Ctrl+F usable.
    } catch { /* Internal contribution compatibility must not break the editor. */ }
    paused = false
  }

  /** @public @author ddj 2026年10月09号 Save final query and remove listener before editor destruction. */
  function dispose(): void {
    if (disposed) return
    capture()
    disposed = true
    try { listener?.dispose() } catch { /* Already disposed by native editor cleanup. */ }
  }
  return { pause, resume, dispose }
}
