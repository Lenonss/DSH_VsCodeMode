/** Optional navigation only; remote snapshots never become local editable files. @author ddj 2026年11月04号 */
export interface ForgeBridge { available(): boolean; open(sessionId: string, local?: boolean): boolean }

/** @public @author ddj 2026年11月04号 @param ctx Client capabilities. @param current Current session reader. @returns Capability-gated official navigation, with no polling or writes. */
export function forgeBridge(ctx: { get(name: string): unknown }, current: () => string | undefined): ForgeBridge {
  const capabilities = () => {
    try {
      const tabs = ctx.get('sidebarRightTabs') as { get?(kind: string): unknown }
      const service = ctx.get('sidebarRight') as { openTab?(kind: string): void; openResource?(address: string, options?: unknown): void }
      return { tabs, service }
    } catch { return undefined }
  }
  return {
    available() {
      const capabilitiesNow = capabilities()
      return Boolean(capabilitiesNow?.tabs?.get?.('forge-panel') && capabilitiesNow.tabs.get('forge-changes') && capabilitiesNow.service?.openTab && capabilitiesNow.service.openResource)
    },
    open(sessionId, local = false) {
      if (!sessionId || current() !== sessionId || !this.available()) return false
      const service = capabilities()!.service
      try {
        if (local) service.openResource!('dsh-resource://forge-changes/' + encodeURIComponent(sessionId) + '/local', { kind: 'forge-changes' })
        else service.openTab!('forge-panel')
        return true
      } catch { return false }
    },
  }
}
