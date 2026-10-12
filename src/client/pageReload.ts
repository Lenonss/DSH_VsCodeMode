/** Guarded page-only reload; never restarts Host. @author ddj 2026年10月12号 */
export interface ReloadGuard { check(): string | null; prepare(): void }
export interface ReloadDeps {
  flush(): Promise<void>
  reload(): void
  notify(message: string): void
  timeoutMs?: number
}
const guards = new Set<ReloadGuard>()

/** @public @author ddj 2026年10月12号 @param guard Live editor checks and view-state capture. @returns Unregister function. */
export function addReloadGuard(guard: ReloadGuard): () => void {
  guards.add(guard)
  return () => { guards.delete(guard) }
}

/** @private @author ddj 2026年10月12号 @param checks Current editor guards. @returns First unsafe state, or null. */
function reloadBlock(checks: Iterable<ReloadGuard>): string | null {
  for (const guard of checks) {
    const reason = guard.check()
    if (reason) return reason
  }
  return null
}

/** @public @author ddj 2026年10月12号 @param deps Page operations. @param checks Live editor guards. @returns Serialized request and cancellation. @sideEffects Flushes view state then reloads only when still safe. */
export function createPageReload(deps: ReloadDeps, checks: Iterable<ReloadGuard> = guards) {
  let busy = false
  let disposed = false
  /** @private @author ddj 2026年10月12号 @returns Completion of one guarded reload attempt. */
  async function request(): Promise<void> {
    if (busy || disposed) return
    busy = true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const reason = reloadBlock(checks)
      if (reason) { deps.notify('未刷新：' + reason); return }
      for (const guard of checks) guard.prepare()
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('界面状态保存超时')), deps.timeoutMs ?? 5000)
      })
      await Promise.race([deps.flush(), timeout])
      if (disposed) return
      const changed = reloadBlock(checks)
      if (changed) { deps.notify('未刷新：' + changed); return }
      deps.reload()
    } catch (error) {
      if (!disposed) deps.notify('未刷新：' + String(error))
    } finally {
      clearTimeout(timer)
      busy = false
    }
  }
  return { request, dispose: () => { disposed = true } }
}

/** @public @author ddj 2026年10月12号 @returns Whether no live modal blocks page commands. */
export function pageKeysAllowed(): boolean {
  if (typeof document === 'undefined') return true
  return document.querySelector('[role="dialog"], [aria-modal="true"]') === null
}

/** @public @author ddj 2026年10月12号 @param flush Durable UI-state flush. @param notify User-visible failure sink. @returns Root-scope listener disposer. */
export function installPageReload(flush: () => Promise<void>, notify: (message: string) => void): () => void {
  const controller = createPageReload({ flush, notify, reload: () => window.location.reload() })
  /** @private @author ddj 2026年10月12号 Ignores modal-blocked commands even from programmatic callers. */
  const onReload = (): void => { if (pageKeysAllowed()) void controller.request() }
  window.addEventListener('edrv.command.reloadWindow', onReload)
  return () => {
    controller.dispose()
    window.removeEventListener('edrv.command.reloadWindow', onReload)
  }
}
