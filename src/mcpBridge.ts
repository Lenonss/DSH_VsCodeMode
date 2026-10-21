/** Private official-MCP registrations, never a global provider. @author ddj 2026年10月20号 */
import { loadHostModule } from './hostImport.js'
import type { Ctx } from './store.js'
import type { McpPool, PoolEntry } from './mcpPool.js'

export interface BridgeScope {
  ctx: any
  dispose(): Promise<void>
}
export interface McpSection {
  name: string
  order: number
  interpolate?: boolean
  text: string | ((context?: any) => string)
}
export interface McpProvider {
  request(request: any, execution: any): Promise<any>
}
export type ScopeMaker = (ctx: any, key: object) => BridgeScope

/** Per-agent public surface; original definitions still run inside the normal registry pipeline. */
export class McpBinding {
  private readonly removals: Array<() => void> = []
  private unsubscribe?: () => void
  private closed = false

  /** @public @author ddj 2026年10月20号 @param agent Public scope. @param pool Connection owner. @param entry Exact generation. @param valid Authorization recheck. */
  constructor(private readonly agent: any, private readonly pool: McpPool, private readonly entry: PoolEntry, private readonly valid: () => boolean, private readonly called?: (elapsed: number) => void) {}

  /** @private @author ddj 2026年10月20号 @param execution Registry caller. @throws Stale generation or foreign caller. */
  private check(execution?: any): void {
    if (this.closed || !this.valid() || !this.entry.live || (execution && execution.agent !== this.agent)) throw new Error('项目 MCP 作用域或配置已失效')
  }

  /** @public @author ddj 2026年10月20号 Reconciles exact definitions after official tool-list updates. */
  sync(): void {
    this.check()
    const bridge = this.entry.bridge
    if (!bridge) return
    // Resources and instructions can change independently of tool names; replace the whole small scoped surface.
    this.clear()
    for (const [name, definition] of bridge.tools) {
      /** @author ddj 2026年10月20号 @param args Registry-validated arguments. @param execution Unmodified caller context. @returns Official canonical output. */
      const execute = async (args: unknown, execution: any): Promise<unknown> => {
        this.check(execution)
        return this.pool.run(this.entry, async () => {
          this.check(execution)
          if (bridge.tools.get(name) !== definition) throw new Error('MCP 工具定义已更新，请重新发现')
          const startedAt = Date.now()
          const result = await definition.execute(args, execution)
          this.called?.(Date.now() - startedAt)
          return result
        }, execution.signal)
      }
      this.removals.push(this.agent.ctx.get('tools').register({ ...definition, execute }))
    }
    // Resource ownership stays with the runtime's single lazy provider, avoiding duplicate namespace registration.
    for (const section of bridge.sections.values()) {
      /** @author ddj 2026年10月20号 @param context Actual prompt assembly. @returns Only valid-generation instructions. */
      const text = (context: any): string => {
        if (!this.valid() || this.closed) return ''
        if (typeof section.text === 'function') return section.text(context)
        return section.text
      }
      this.removals.push(this.agent.ctx.get('systemPrompt').section({ ...section, text }))
    }
    /** @author ddj 2026年10月20号 Reconciles dynamic official registrations only for a live subscriber. */
    const update = (): void => { if (!this.closed && this.valid() && this.entry.live) this.sync() }
    if (!this.unsubscribe) this.unsubscribe = bridge.subscribe(update)
  }

  /** @private @author ddj 2026年10月20号 Removes only this binding's exact scoped registrations. */
  private clear(): void {
    for (const remove of this.removals.splice(0).reverse()) remove()
  }

  /** @public @author ddj 2026年10月20号 Revokes proxies synchronously before releasing a lease. */
  dispose(): void {
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.clear()
  }
}

/** A connection's private surface. Public consumers register scoped proxies, not this scope. */
export class McpBridge {
  readonly tools = new Map<string, any>()
  readonly resources = new Map<string, McpProvider>()
  readonly sections = new Map<string, McpSection>()
  private readonly listeners = new Set<() => void>()
  private closed = false
  private closing?: Promise<void>

  /** @private @author ddj 2026年10月20号 @param scope Private lifetime and registration context. */
  private constructor(readonly scope: BridgeScope) {}

  /** @public @author ddj 2026年10月20号 @param ctx Host owner. @param make Optional real scope factory for installed-host tests. @returns Isolated registration adapter. */
  static async create(ctx: Ctx, make?: ScopeMaker): Promise<McpBridge> {
    const factory = make ?? (await loadHostModule('@deepseek-ai/dsh-scope') as { createScope: ScopeMaker }).createScope
    const scope = factory(ctx, {})
    // Providers must be installed after the backing scope's initial activation transaction.
    await scope.ctx.fiber?.await?.()
    const bridge = new McpBridge(scope)
    bridge.install()
    return bridge
  }

  /** @private @author ddj 2026年10月20号 Installs only private services; no project registration reaches the root. */
  private install(): void {
    const privateCtx = this.scope.ctx.isolate('tools').isolate('mcpResources').isolate('systemPrompt')
    privateCtx.provide('tools', { register: (definition: any) => this.register(this.tools, definition.name, definition) })
    privateCtx.provide('mcpResources', { register: (name: string, provider: McpProvider) => this.register(this.resources, name, provider) })
    privateCtx.provide('systemPrompt', {
      getSectionOrder: () => 3100,
      section: (section: McpSection) => this.register(this.sections, section.name, section),
    })
    this.scope.ctx = privateCtx
  }

  /** @private @author ddj 2026年10月20号 @param registry Private generation map. @param name Stable registration name. @param entry Exact value. @returns Exact-entry removal, safe after replacement. */
  private register<T>(registry: Map<string, T>, name: string, entry: T): () => void {
    if (this.closed) throw new Error('MCP bridge is disposed')
    if (registry.has(name)) throw new Error('Duplicate private MCP registration: ' + name)
    registry.set(name, entry)
    this.changed()

    return () => {
      if (registry.get(name) !== entry) return
      registry.delete(name)
      this.changed()
    }
  }

  /** @public @author ddj 2026年10月20号 @param listener Surface change subscriber. @returns Subscription disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** @private @author ddj 2026年10月20号 Notifies consumers; observer errors cannot corrupt the official sync transaction. */
  private changed(): void {
    for (const listener of this.listeners) {
      try { listener() } catch { /* Runtime owns diagnostics for its subscriber. */ }
    }
  }

  /** @public @author ddj 2026年10月20号 @returns Quiescent private-scope teardown. */
  dispose(): Promise<void> {
    this.closed = true
    return this.closing ??= this.closeScope()
  }

  /** @private @author ddj 2026年10月20号 @returns Exact scope closure before forgetting registrations. */
  private async closeScope(): Promise<void> {
    await this.scope.dispose()
    this.tools.clear()
    this.resources.clear()
    this.sections.clear()
    this.changed()
    this.listeners.clear()
  }
}
