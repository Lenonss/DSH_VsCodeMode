/** Optional shared popup adapter retaining the plugin's action models. @author ddj 2026年11月04号 */
export interface PopupItem {
  id: string
  label: string
  disabled?: boolean
  danger?: boolean
  separator?: boolean
  commandId?: string
  run: () => void | Promise<void>
}
interface MenuTarget { kind: string; value: { owner: string; sessionId: string; path: string } }
interface MenuService {
  register(contribution: { id: string; target: string; order: number; resolve: (target: MenuTarget['value'], signal: AbortSignal) => unknown[] }): () => void
  open(target: MenuTarget, point: { x: number; y: number }): void
  close(): void
  active?: { getSnapshot(): { kind?: string; value?: { owner?: string } } | null }
}
export interface OfficialMenuBridge {
  open(kind: 'resource' | 'tab', sessionId: string, path: string, point: { x: number; y: number }, items: PopupItem[], valid: () => boolean): boolean
  invalidate(valid: () => boolean): void
  dispose(): void
}
let ownerSeq = 0

/** @public @author ddj 2026年11月04号 @param ctx Optional service context. @returns Retry-on-use bridge for late service registration, with legacy fallback. */
export function lazyMenus(ctx: { get(name: string): unknown }): OfficialMenuBridge {
  let bridge: OfficialMenuBridge | undefined
  let stopped = false
  return {
    open(...args) { if (stopped) return false; bridge ??= officialMenus(ctx); return bridge?.open(...args) ?? false },
    invalidate(valid) { bridge?.invalidate(valid) },
    dispose() { stopped = true; bridge?.dispose(); bridge = undefined },
  }
}

/** @public @author ddj 2026年11月04号 @param ctx Optional service context. @returns Scoped bridge or no capability, preserving the existing popup. */
export function officialMenus(ctx: { get(name: string): unknown }): OfficialMenuBridge | undefined {
  let service: MenuService
  try { service = ctx.get('contextMenus') as MenuService } catch { return undefined }
  if (!service || typeof service.register !== 'function' || typeof service.open !== 'function' || typeof service.close !== 'function') return undefined
  const owner = 'edrv-menu-' + ++ownerSeq
  let current: { items: PopupItem[]; valid: () => boolean; revision: number } | undefined
  let revision = 0
  let stopped = false
  const disposers: Array<() => void> = []
  try {
    for (const kind of ['resource', 'tab']) {
      disposers.push(service.register({ id: owner + '-' + kind, target: 'edrv.' + kind, order: 30,
        resolve: (target, signal) => {
          const opening = current
          if (stopped || target.owner !== owner || !opening || !opening.valid() || signal.aborted) return []
          return opening.items.map((item) => ({ id: item.id, label: item.label, disabled: item.disabled,
            danger: item.danger, separatorBefore: item.separator, commandId: item.commandId,
            run: async () => {
              if (stopped || opening.revision !== revision || !opening.valid() || item.disabled) return
              await item.run()
            } }))
        },
      }))
    }
  } catch { for (const dispose of disposers) dispose(); return undefined }
  /** @private @author ddj 2026年11月04号 Close only this bridge's active shared popup. */
  function closeOwned(): void {
    const active = service.active?.getSnapshot()
    if (active?.value?.owner === owner && (active.kind === 'edrv.resource' || active.kind === 'edrv.tab')) service.close()
  }
  return {
    open(kind, sessionId, path, point, items, valid) {
      if (stopped || !sessionId || !valid()) return false
      current = { items, valid, revision: ++revision }
      try { service.open({ kind: 'edrv.' + kind, value: { owner, sessionId, path } }, point); return true }
      catch { current = undefined; return false }
    },
    invalidate(valid) {
      if (current?.valid !== valid) return
      revision++; current = undefined; closeOwned()
    },
    dispose() { stopped = true; revision++; current = undefined; closeOwned(); for (const dispose of disposers) dispose() },
  }
}
