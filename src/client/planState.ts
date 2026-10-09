/** Plan identities and live-only event reduction. @author ddj 2026年10月08号 */
export interface PlanDocument { address: string; markdown: string; title: string }
export interface PlanOpen { path?: string; plan?: PlanDocument }
export interface PlanEntry { type?: string; event: { type: string; seq?: number; data: unknown } }
export interface PlanWindow { revision: number; entries: readonly PlanEntry[]; change: { kind: string; entries?: readonly PlanEntry[] } }
const associated = new Map<string, Set<string>>()

/** @private @author ddj 2026年10月08号 @param value JSON candidate. @returns Object or empty record. */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}
/** @private @author ddj 2026年10月08号 @param value Tool arguments. @returns Parsed object, never throws. */
function argsOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return record(value)
  try { return record(JSON.parse(value)) } catch { return {} }
}
/** @private @author ddj 2026年10月08号 @param path Path identity. @returns Slash-normalized, Windows-case-folded identity. */
function pathKey(path: string): string {
  const value = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^(?:[a-z]:\/|\/\/)/i.test(value) ? value.toLowerCase() : value
}
/** @private @author ddj 2026年10月08号 @param path File path. @param cwd Workspace. @returns Absolute association identity. */
function absoluteKey(path: string, cwd = ''): string {
  return pathKey(/^(?:[a-z]:[\\/]|\/)/i.test(path) || !cwd ? path : cwd + '/' + path.replace(/^\.\//, ''))
}
/** @public @author ddj 2026年10月08号 @param path File path. @param cwd Workspace. @param sessionId Association owner. @returns Whether a Markdown file belongs to a plan directory or explicit submission. */
export function isPlanPath(path: string, cwd = '', sessionId = ''): boolean {
  if (!/\.(?:md|markdown)$/i.test(path) || path.replace(/\\/g, '/').split('/').includes('..')) return false
  const key = absoluteKey(path, cwd)
  const root = cwd ? pathKey(cwd) + '/plans/' : 'plans/'
  return key.startsWith(root) || /(?:^|\/)\.dsh\/plans\//.test(key)
    || Boolean(associated.get(sessionId)?.has(key))
}
/** @public @author ddj 2026年10月08号 @param address Official resource address. @returns Whether this is an official plan resource, without treating it as a disk path. */
export function isPlanAddress(address: unknown): address is string {
  if (typeof address !== 'string') return false
  try {
    const segments = address.split('/').slice(3).map(decodeURIComponent)
    if (segments.some((value) => !value || /[\\/]/.test(value))) return false
    if (address.startsWith('dsh-resource://plan-review/')) return segments.length === 2
    if (!address.startsWith('dsh-resource://plan/')) return false
    return segments.length === 2 || (segments.length === 5 && segments[0] === 'subagent'
      && ['one-shot', 'continuable', 'unknown'].includes(segments[3]))
  } catch { return false }
}
/** @public @author ddj 2026年10月08号 @param address Official address. @param value Provider or review payload. @returns Valid complete read-only plan, if available. */
export function planDocument(address: string, value: unknown): PlanDocument | undefined {
  const data = record(value)
  if (!isPlanAddress(address) || typeof data.markdown !== 'string') return undefined
  const title = /^#\s+(\S[^\r\n]*)/.exec(data.markdown.trim())?.[1]
  if (!title) return undefined
  return { address, markdown: data.markdown, title }
}
/** @private @author ddj 2026年10月08号 @param sessionId Current session. @param path Explicit plan path. @param cwd Workspace. Stores bounded associations, not file contents. */
function associate(sessionId: string, path: string, cwd: string): void {
  const paths = associated.get(sessionId) ?? new Set<string>()
  paths.add(absoluteKey(path, cwd))
  if (paths.size > 128) paths.delete(paths.values().next().value!)
  associated.set(sessionId, paths)
  if (associated.size > 32) associated.delete(associated.keys().next().value!)
}
/** @public @author ddj 2026年10月08号 Clear associations when the plugin unloads. */
export function clearPlanState(): void { associated.clear() }

/** @public @author ddj 2026年10月08号
 * Reduce only live append deltas; hydration, pagination, reconnect and duplicate sequences never open plans.
 * @param sessionId Feed owner. @param cwd Workspace. @returns Revision-aware reducer.
 */
export function createPlanFeed(sessionId: string, cwd = '') {
  let revision: number | undefined
  let watermark = -1
  const pending = new Map<string, { name: string; args: Record<string, unknown> }>()
  const seen = new Set<string>()

  /** @private @author ddj 2026年10月08号 @param entry Durable entry. @param live Whether opening is permitted. @returns New plan open, if any. */
  function reduce(entry: PlanEntry, live: boolean): PlanOpen | undefined {
    const event = entry.event
    const data = record(event.data)
    const result = event.type === 'tool/result' ? record(data.message) : data
    const id = event.type === 'tool/result' ? result.toolCallId : data.subCallId ?? data.callId
    if (typeof id !== 'string') return undefined
    const isCall = event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start'
    const settled = event.type === 'tool/result' || event.type === 'tool/ptc-dispatch'
    if (!isCall && !settled) return undefined
    const args = argsOf(data.arguments)
    if (isCall) pending.set(id, { name: String(data.name), args })
    const call = event.type === 'tool/result' ? pending.get(id) : { name: String(data.name), args }
    if (settled) pending.delete(id)
    if (!call || !live || seen.has(id) || result.isError === true || data.error) return undefined
    if (call.name === 'exit_plan_mode') {
      if (event.type === 'tool/result') return undefined
      const address = 'dsh-resource://plan/' + encodeURIComponent(sessionId) + '/' + encodeURIComponent(id)
      const plan = planDocument(address, { markdown: call.args.plan })
      if (plan) { remember(id); return { plan } }
      return undefined
    }
    if (!settled || !['write', 'edit'].includes(call.name) || typeof call.args.file_path !== 'string') return undefined
    const path = call.args.file_path
    if (call.name === 'write' && typeof call.args.content === 'string' && /^#\s*计划[：:]/.test(call.args.content.trim())) associate(sessionId, path, cwd)
    if (!isPlanPath(path, cwd, sessionId)) return undefined
    remember(id)
    return { path }
  }
  /** @private @author ddj 2026年10月08号 @param id Handled call. Bound retained identities and incomplete calls. */
  function remember(id: string): void {
    seen.add(id)
    if (seen.size > 256) seen.delete(seen.values().next().value!)
  }
  /** @public @author ddj 2026年10月08号 @param snapshot Event window. @returns Live opens, in durable order. */
  function consume(snapshot: PlanWindow): PlanOpen[] {
    if (snapshot.revision === revision) return []
    const baseline = revision === undefined || snapshot.change.kind === 'replace'
    revision = snapshot.revision
    if (baseline) pending.clear()
    const entries = baseline ? snapshot.entries : snapshot.change.kind === 'append' ? snapshot.change.entries ?? [] : []
    const opens: PlanOpen[] = []
    for (const entry of entries) {
      if (entry.type === 'transient') continue
      const seq = entry.event.seq
      const live = !baseline && (seq === undefined || seq > watermark)
      if (seq !== undefined) watermark = Math.max(watermark, seq)
      const open = reduce(entry, live)
      if (open) opens.push(open)
    }
    while (pending.size > 256) pending.delete(pending.keys().next().value!)
    return opens
  }
  return { consume }
}
