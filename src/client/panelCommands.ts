import type { SessionScope } from './sessionScope.js'

export type PanelAction = 'quickOpen' | 'searchInFiles'
export interface PanelRoute {
  readScope(): SessionScope
  canOpen(): boolean
  open(): boolean
}
interface PendingPanel extends SessionScope { action: PanelAction; expires: number }
interface PanelHost { action: PanelAction; scope: SessionScope; run(): void }
let route: PanelRoute | null = null
const hosts = new Set<PanelHost>()
const storage = globalThis as typeof globalThis & { __edrvPanelCommand__?: PendingPanel }

/**
 * Compare the command's session and workspace identity.
 * @author ddj 2026年09月28号
 * @param left Requested scope.
 * @param right Mounted scope.
 * @returns Whether both refer to the same session and known workspace.
 */
function sameScope(left: SessionScope, right: SessionScope): boolean {
  return Boolean(left.sessionId && left.sessionId === right.sessionId
    && (!left.cwd || !right.cwd || left.cwd === right.cwd))
}

/**
 * Find the most recently mounted matching command receiver.
 * @author ddj 2026年09月28号
 * @param action Panel action.
 * @param scope Active session scope.
 * @returns Receiver if mounted.
 */
function panelHost(action: PanelAction, scope: SessionScope): PanelHost | undefined {
  return [...hosts].reverse().find((host) => host.action === action && sameScope(scope, host.scope))
}

/**
 * Install the existing sidebar route and current-session reader.
 * @author ddj 2026年09月28号
 * @param next Route capabilities; no side effects during availability checks.
 * @returns Identity-safe disposal; pending intent survives plugin reload.
 */
export function setPanelRoute(next: PanelRoute): () => void {
  route = next
  return () => { if (route === next) route = null }
}

/**
 * Check that a command has a mounted receiver or a usable editor route.
 * @author ddj 2026年09月28号
 * @param action Panel action.
 * @returns False when genuinely unavailable, allowing official key dispatch to pass.
 */
export function panelAvailable(action: PanelAction): boolean {
  const scope = route?.readScope()
  if (!scope?.sessionId) return false
  return Boolean(panelHost(action, scope) || route?.canOpen())
}

/**
 * Deliver now or preserve an intent until the editor mounts.
 * @author ddj 2026年09月28号
 * @param action Panel action.
 * @returns Whether the mounted host or sidebar accepted the request.
 */
export function runPanelCommand(action: PanelAction): boolean {
  const scope = route?.readScope()
  if (!scope?.sessionId) return false
  const host = panelHost(action, scope)
  if (host) { host.run(); return true }
  if (!route?.canOpen()) return false
  const pending = { ...scope, action, expires: Date.now() + 30_000 }
  storage.__edrvPanelCommand__ = pending
  try {
    if (route.open()) return true
  } catch { /* A disappearing sidebar leaves the command unhandled. */ }
  if (storage.__edrvPanelCommand__ === pending) delete storage.__edrvPanelCommand__
  return false
}

/**
 * Attach one scoped receiver and consume a still-current pending intent once.
 * @author ddj 2026年09月28号
 * @param action Panel action.
 * @param scope Mounted session/workspace.
 * @param run Action using the mounted component's state.
 * @returns Receiver disposal.
 */
export function bindPanelCommand(action: PanelAction, scope: SessionScope, run: () => void): () => void {
  const host = { action, scope, run }
  hosts.add(host)
  const pending = storage.__edrvPanelCommand__
  if (pending && (pending.expires < Date.now() || !sameScope(pending, route?.readScope() ?? {}))) {
    delete storage.__edrvPanelCommand__
  } else if (pending?.action === action && sameScope(pending, scope)) {
    delete storage.__edrvPanelCommand__
    run()
  }
  return () => { hosts.delete(host) }
}
