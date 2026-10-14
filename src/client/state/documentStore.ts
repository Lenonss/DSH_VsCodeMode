/** One save owner per document, independent of group placement. @author ddj 2026年10月14号 */
export interface TextModel { getValue(): string; isDisposed?(): boolean; getVersionId?(): number }
export interface SaveResult { ok: boolean; rev?: string; conflict?: boolean; error?: string }
export interface DocumentState {
  model: TextModel | null
  rev?: string
  dirty: boolean
  conflict: boolean
  pending: ReturnType<typeof setTimeout> | null
  saving: Promise<SaveResult> | null
  again: boolean
  generation: number
}
export interface SaveRequest { path: string; content: string; rev?: string }
export interface DocumentDeps {
  save(request: SaveRequest): Promise<SaveResult>
  changed?(path: string, state: DocumentState): void
  saved?(path: string, content: string, model: TextModel, result: SaveResult): void
  failed?(path: string, result: SaveResult): void
  blocked?(path: string): boolean
}

/** @public @author ddj 2026年10月14号 @param deps IO/version guard and view notifications. @returns Shared lifecycle without model disposal. */
export function createDocStore(deps: DocumentDeps) {
  const documents = new Map<string, DocumentState>()
  let disposed = false

  /** @public @author ddj 2026年10月14号 @param path Canonical file path. @returns Document state, lazily created. */
  function state(path: string): DocumentState {
    let item = documents.get(path)
    if (!item) {
      item = { model: null, dirty: false, conflict: false, pending: null, saving: null, again: false, generation: 0 }
      documents.set(path, item)
    }
    return item
  }

  /** @private @author ddj 2026年10月14号 @param path Canonical path. @param item Current state. Publish change to all views. */
  function notify(path: string, item: DocumentState): void { deps.changed?.(path, item) }

  /** @public @author ddj 2026年10月14号 @param path File path. @param model Existing model. @param rev Optional disk revision. Bind without erasing edits. */
  function bind(path: string, model: TextModel, rev?: string): void {
    const item = state(path)
    if (item.model && item.model !== model) item.generation += 1
    item.model = model
    if (rev) item.rev = rev
  }

  /** @public @author ddj 2026年10月14号 @param path File path. @param rev Disk token. @param conflict Optional conflict marker. Update disk baseline only. */
  function baseline(path: string, rev?: string, conflict?: boolean): void {
    const item = state(path)
    if (rev) item.rev = rev
    if (conflict !== undefined) item.conflict = conflict
    notify(path, item)
  }

  /** @private @author ddj 2026年10月14号 @param item Document state. Cancel delayed save, not in-flight IO. */
  function cancel(item: DocumentState): void {
    if (item.pending !== null) clearTimeout(item.pending)
    item.pending = null
  }

  /** @private @author ddj 2026年10月14号 @param path Saved path. @param item Owner state. @param model Captured model. @param content Saved snapshot. @param version Captured version. @param generation Owner generation. @param result IO result. Accept only current content. */
  function accept(path: string, item: DocumentState, model: TextModel, content: string, version: number | undefined, generation: number, result: SaveResult): void {
    if (documents.get(path) !== item || item.generation !== generation || item.model !== model) return
    if (!result.ok) {
      item.conflict = result.conflict === true || item.conflict
      deps.failed?.(path, result)
      return
    }
    if (result.rev) item.rev = result.rev
    if (!model.isDisposed?.() && model.getValue() === content && (version === undefined || version === model.getVersionId?.())) item.dirty = false
    deps.saved?.(path, content, model, result)
  }

  /** @public @author ddj 2026年10月14号 @param path File path. @param manual Explicit user save may invoke version guard despite conflict. @returns Deduplicated save completion; failures retain dirty state. */
  function save(path: string, manual = false): Promise<SaveResult> {
    const item = state(path)
    cancel(item)
    if (disposed || !item.model || item.model.isDisposed?.()) return Promise.resolve({ ok: false, error: '文件模型不可用' })
    if (!manual && (item.conflict || deps.blocked?.(path))) return Promise.resolve({ ok: false, conflict: true })
    if (item.saving) { item.again = item.dirty; return item.saving }
    const model = item.model, content = model.getValue(), version = model.getVersionId?.(), generation = item.generation
    const request = { path, content, rev: item.rev }
    /** @private @author ddj 2026年10月14号 @param result IO result. @returns Original result after guarded acceptance. */
    function success(result: SaveResult): SaveResult { accept(path, item, model, content, version, generation, result); return result }
    /** @private @author ddj 2026年10月14号 @param error IO failure. @returns Failure without discarding content. */
    function failure(error: unknown): SaveResult {
      const result = { ok: false, error: String(error) }
      if (documents.get(path) === item) deps.failed?.(path, result)
      return result
    }
    /** @private @author ddj 2026年10月14号 Complete one request before scheduling another changed snapshot. */
    function settled(): void {
      item.saving = null
      notify(path, item)
      if (documents.get(path) !== item || disposed || !item.again) return
      item.again = false
      if (item.dirty && !item.conflict) edit(path)
    }
    item.saving = Promise.resolve().then(() => deps.save(request)).then(success, failure).finally(settled)
    notify(path, item)
    return item.saving
  }

  /** @public @author ddj 2026年10月14号 @param path File path. @param delay Debounce milliseconds. Mark dirty and schedule a document-owned save. */
  function edit(path: string, delay = 700): void {
    if (disposed) return
    const item = state(path)
    item.dirty = true
    cancel(item)
    if (!item.conflict && !deps.blocked?.(path)) {
      /** @private @author ddj 2026年10月14号 Save the same document even after group/focus changes. */
      function delayed(): void { item.pending = null; void save(path) }
      item.pending = setTimeout(delayed, delay)
    }
    notify(path, item)
  }

  /** @public @author ddj 2026年10月14号 @param path Optional document. @returns Pending saves submitted; moving groups need not call this. */
  function flush(path?: string): Promise<SaveResult[]> {
    const work: Promise<SaveResult>[] = []
    for (const [key, item] of documents) {
      if (path && path !== key) continue
      if (item.pending !== null || (item.dirty && !item.saving)) work.push(save(key))
      else if (item.saving) work.push(item.saving)
    }
    return Promise.all(work)
  }

  /** @public @author ddj 2026年10月14号 @param path File removed from tracking. @returns False while unsafe; never destroys a model. */
  function release(path: string): boolean {
    const item = documents.get(path)
    if (!item) return true
    if (item.dirty || item.saving) return false
    cancel(item)
    documents.delete(path)
    return true
  }

  /** @public @author ddj 2026年10月14号 @returns Whether dirty or in-flight content prevents reload. */
  function unsafe(): boolean { return [...documents.values()].some((item) => item.dirty || item.pending !== null || !!item.saving) }

  /** @public @author ddj 2026年10月14号 Cancel timers on teardown; retained models and in-flight save guards survive. */
  function dispose(): void { disposed = true; for (const item of documents.values()) cancel(item) }
  return { state, bind, baseline, edit, save, flush, release, unsafe, dispose }
}
export type DocumentStore = ReturnType<typeof createDocStore>
