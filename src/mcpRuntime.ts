/** Agent-owned project MCP fibers. @author ddj 2026年09月28号 */
import { loadHostModule } from './hostImport.js'
import { entriesOf, MCP_PACKAGE, publicConfig, toolsOf } from './mcp.js'
import { isProjectEntryId } from './compat.js'
import { matchWorkspace } from './mcpIsolation.js'
import { listProjects, projectEntryId, reconcileProject } from './mcpProject.js'
import type { MpcConfig, MpcServer } from './shared/mcp.js'
import type { Ctx } from './store.js'

export type ProjectDef = { config: MpcConfig; enabled: boolean }
type Instance = { fiber?: any; key: string; path: string; error?: string; stopping?: Promise<void> }
type AgentRecord = { instances: Map<string, Instance>; live: boolean }
export type McpLoader = () => Promise<any>
const runtimes = new WeakMap<object, McpRuntime>()

/**
 * Load the official plugin from the running host's installation tree.
 * @private @author ddj 2026年09月28号
 * @returns Official MCP plugin namespace; rejects if the host package is absent.
 */
async function loadMcp(): Promise<any> {
  return loadHostModule(MCP_PACKAGE)
}

/**
 * Resolve one runtime per host, shared by lifecycle and RPC contexts.
 * @public @author ddj 2026年09月28号
 * @param ctx Host context.
 * @returns Lazy runtime; allocating it does not start connections.
 */
export function runtimeOf(ctx: Ctx): McpRuntime {
  const owner = ctx.root ?? ctx
  let runtime = runtimes.get(owner)
  if (!runtime) {
    runtime = new McpRuntime(ctx)
    runtimes.set(owner, runtime)
  }
  return runtime
}

/** Agent -> server -> fiber ledger. Configuration alone never opens a connection. */
export class McpRuntime {
  readonly projects = new Map<string, Map<string, ProjectDef>>()
  readonly agents = new Map<any, AgentRecord>()
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false
  private readonly retired = new WeakSet<object>()
  private module?: Promise<any>

  /**
   * Create an idle ledger with an injectable official-plugin resolver.
   * @public @author ddj 2026年09月28号
   * @param ctx Host services and lifecycle owner.
   * @param load Official module resolver, replaceable in targeted tests.
   */
  constructor(private readonly ctx: Ctx, private readonly load: McpLoader = loadMcp) {}

  /**
   * Serialize reconfiguration and creation; a failed operation cannot poison the queue.
   * @private @author ddj 2026年09月28号
   * @param action Mutation to execute while the runtime remains live.
   * @returns Completion of this mutation, including official startup readiness.
   */
  private enqueue(action: () => Promise<void>): Promise<void> {
    const run = async () => { if (!this.stopped) await action() }
    const next = this.tail.then(run)
    this.tail = next.catch(() => undefined)
    return next
  }

  /**
   * Find the longest registered workspace containing an agent's cwd.
   * @public @author ddj 2026年09月28号
   * @param agent Live agent.
   * @returns Registered workspace path, or undefined outside managed workspaces.
   */
  workspace(agent: any): string | undefined {
    const paths = (this.ctx.get('workspaceRegistry')?.list?.() ?? []).map((ws: { path: string }) => ws.path)
    return matchWorkspace(agent?.session?.header?.cwd, paths)
  }

  /**
   * Read configured server ownership, including disabled definitions.
   * @public @author ddj 2026年09月28号
   * @returns Server name to workspace mapping.
   */
  owners(): Map<string, string> {
    const names = new Map<string, string>()
    for (const record of this.agents.values()) {
      for (const [name, instance] of record.instances) names.set(name, instance.path)
    }
    for (const [path, defs] of this.projects) for (const name of defs.keys()) names.set(name, path)
    return names
  }

  /**
   * Publish ownership changes before any provider can become visible.
   * @private @author ddj 2026年09月28号
   * @sideEffects Refreshes agent restrictions and scoped prompt shadows synchronously.
   */
  private changed(): void {
    this.ctx.emit?.('vscode-mode/mcp-change')
  }

  /**
   * Replace one validated file snapshot and update its active agents.
   * @public @author ddj 2026年09月28号
   * @param path Registered workspace path.
   * @param defs Validated source definitions.
   * @param refresh Optional server whose unchanged fiber must also be recreated.
   * @returns Completion after old fibers close and replacement startups settle.
   */
  replace(path: string, defs: Map<string, ProjectDef>, refresh?: string): Promise<void> {
    const update = async () => {
      this.projects.set(path, defs)
      this.changed()
      for (const [agent, record] of this.agents) await this.syncAgent(agent, record, this.workspace(agent) === path ? refresh : undefined)
      this.changed()
    }
    return this.enqueue(update)
  }

  /**
   * Attach an agent once and await its project plugin startups.
   * @public @author ddj 2026年09月28号
   * @param agent Created or already-active agent.
   * @returns Completion suitable for the serial agent/created listener.
   */
  attach(agent: any): Promise<void> {
    if (this.stopped || this.retired.has(agent)) return Promise.resolve()
    let record = this.agents.get(agent)
    if (!record) {
      record = { instances: new Map(), live: true }
      this.agents.set(agent, record)
    }
    const target = record
    const attach = async () => { await this.syncAgent(agent, target); this.changed() }
    return this.enqueue(attach)
  }

  /**
   * Dispose a single connection before releasing its ledger slot.
   * @private @author ddj 2026年09月28号
   * @param record Agent ledger.
   * @param name Server name to stop.
   * @returns Awaitable Cordis teardown; failures remain visible to the caller.
   */
  private async stopOne(record: AgentRecord, name: string): Promise<void> {
    const instance = record.instances.get(name)
    if (instance) await this.stopFiber(instance)
    if (record.instances.get(name) === instance) record.instances.delete(name)
  }

  /**
   * Await exact fiber teardown, including a disposer already claimed by its owning scope.
   * @private @author ddj 2026年09月28号
   * @param instance Connection ledger entry.
   * @returns Shared completion of asynchronous Cordis effects.
   */
  private stopFiber(instance: Instance): Promise<void> {
    const close = async () => {
      const fiber = instance.fiber
      await fiber?.dispose()
      while (fiber?.inertia !== undefined) await fiber.inertia
    }
    return instance.stopping ??= close()
  }

  /**
   * Cancel and drain every fiber owned by a disposed agent.
   * @public @author ddj 2026年09月28号
   * @param agent Disposed agent.
   * @returns Completion of connection cleanup.
   */
  async detach(agent: any): Promise<void> {
    this.retired.add(agent)
    const record = this.agents.get(agent)
    if (!record) return
    record.live = false
    await Promise.all([...record.instances.keys()].map((name) => this.stopOne(record, name)))
    this.agents.delete(agent)
    this.changed()
  }

  /**
   * Match the agent ledger to the current enabled definitions.
   * @private @author ddj 2026年09月28号
   * @param agent Scoped plugin owner.
   * @param record Agent ledger.
   * @param refresh Optional server to reconnect.
   * @returns Completion of removals and scoped mounts.
   */
  private async syncAgent(agent: any, record: AgentRecord, refresh?: string): Promise<void> {
    if (!record.live || this.stopped) return
    const path = this.workspace(agent)
    const defs = this.projects.get(path ?? '') ?? new Map<string, ProjectDef>()
    for (const [name, instance] of record.instances) {
      const def = defs.get(name)
      if (def?.enabled && instance.path === path && instance.key === JSON.stringify(def.config) && name !== refresh) continue
      await this.stopOne(record, name)
    }
    for (const [name, def] of defs) {
      if (!record.live || this.stopped) break
      if (!def.enabled || record.instances.has(name)) continue
      await this.mount(agent, record, def.config, path!)
    }
  }

  /**
   * Cache successful module loads while allowing explicit refresh after transient failures.
   * @private @author ddj 2026年10月08号
   * @returns Official plugin module; load failures propagate to the instance diagnostic.
   */
  private async getModule(): Promise<any> {
    const loading = this.module ??= this.load()
    try {
      return await loading
    } catch (error) {
      if (this.module === loading) this.module = undefined
      throw error
    }
  }

  /**
   * Mount the official plugin through agent.ctx; ACTIVE is not connection evidence.
   * @private @author ddj 2026年09月28号
   * @param agent Scoped context owner.
   * @param record Agent ledger.
   * @param config Validated source config.
   * @param path Default stdio working directory.
   * @returns Settled startup; errors are retained for the project status view.
   */
  private async mount(agent: any, record: AgentRecord, config: MpcConfig, path: string): Promise<void> {
    const instance: Instance = { key: JSON.stringify(config), path }
    record.instances.set(config.serverName, instance)
    try {
      const officialMcp = await this.getModule()
      if (!record.live || this.stopped) return
      const global = entriesOf(this.ctx).find((entry) => !isProjectEntryId(String(entry.id ?? entry.options?.id ?? '')) && entry.options?.config?.serverName === config.serverName)
      if (global) throw new Error('serverName 已被全局 MCP 使用：' + config.serverName)
      const options = config.transport === 'stdio' ? { ...config, cwd: config.cwd || path } : { ...config }
      instance.fiber = agent.ctx.plugin(officialMcp, options)
      await instance.fiber
    } catch (error) {
      instance.error = String(error)
      await this.stopFiber(instance)
      instance.fiber = undefined
    }
  }

  /**
   * Build project status from exact agent scopes without assuming ACTIVE means connected.
   * @public @author ddj 2026年09月28号
   * @param path Workspace to summarize.
   * @returns Masked server views, including configured-only and disabled definitions.
   */
  views(path: string): MpcServer[] {
    const defs = this.projects.get(path) ?? new Map<string, ProjectDef>()
    return [...defs].map(([name, def]) => this.serverView(path, name, def))
  }

  /**
   * Summarize one definition and its connection instances across matching agents.
   * @private @author ddj 2026年09月28号
   * @param path Owning workspace.
   * @param name Server name.
   * @param def Persisted definition.
   * @returns Honest status and union of tools visible to its agents.
   */
  private serverView(path: string, name: string, def: ProjectDef): MpcServer {
    const tools = new Map<string, MpcServer['tools'][number]>()
    const instances: Instance[] = []
    for (const [agent, record] of this.agents) {
      if (this.workspace(agent) !== path) continue
      const instance = record.instances.get(name)
      if (!instance) continue
      instances.push(instance)
      for (const tool of toolsOf(this.ctx, name, agent)) tools.set(tool.name, tool)
    }
    const error = instances.find((item) => item.error)?.error
    const fibers = instances.filter((item) => item.fiber)
    const failed = error || fibers.some((item) => item.fiber.state === 3)
    const status = !def.enabled ? 'disabled' : failed ? 'error' : fibers.length === 0 ? 'configured'
      : fibers.some((item) => item.fiber.state === 1 || item.fiber.state === 0) ? 'connecting' : 'unverified'
    return {
      id: projectEntryId(path, name), serverName: name, enabled: def.enabled,
      transport: def.config.transport, config: publicConfig(def.config as unknown as Record<string, unknown>),
      status, instanceCount: fibers.length, toolCount: tools.size, tools: [...tools.values()],
      error: error || (failed ? 'MCP 插件未正常运行' : undefined),
    }
  }

  /**
   * Close every owned connection and prevent queued work from mounting replacements.
   * @public @author ddj 2026年09月28号
   * @returns Completion after connection disposal and pending startup work settle.
   */
  async dispose(): Promise<void> {
    this.stopped = true
    await Promise.all([...this.agents.keys()].map((agent) => this.detach(agent)))
    await this.tail
    this.projects.clear()
    this.module = undefined
  }
}

/**
 * Remove every old global project entry before any agent-scoped mount is attempted.
 * @public @author ddj 2026年09月28号
 * @param ctx Host loader context.
 * @returns Completion of loader removal and connection teardown.
 */
export async function clearLegacy(ctx: Ctx): Promise<void> {
  const loader = ctx.get('loader')
  for (const entry of entriesOf(ctx)) {
    if (!isProjectEntryId(String(entry.id ?? entry.options?.id ?? ''))) continue
    await loader.remove(entry.id)
  }
}

/**
 * Install awaited creation hooks, migrate global entries, and attach existing agents.
 * @public @author ddj 2026年09月28号
 * @param ctx Host lifecycle context; installIsolation must already be installed.
 * @returns Readiness for index.apply to await before advertising startup completion.
 */
export async function installMcpRuntime(ctx: Ctx): Promise<void> {
  const runtime = runtimeOf(ctx)
  let ready: Promise<void>
  const initialize = async () => {
    await clearLegacy(ctx)
    await listProjects(ctx)
    for (const agent of ctx.get('agents')?.list?.() ?? []) await runtime.attach(agent)
  }
  const created = async ({ agent }: { agent: any }) => {
    await ready
    const path = runtime.workspace(agent)
    if (path) {
      try { await reconcileProject(ctx, path) }
      catch (error) { ctx.logger?.warn?.('MCP configuration retained: ' + String(error)) }
    }
    await runtime.attach(agent)
  }
  const disposed = ({ agent }: { agent: any }) => {
    void runtime.detach(agent).catch((error) => ctx.logger?.warn?.('MCP disposal failed: ' + String(error)))
  }
  const offCreate = ctx.on('agent/created', created)
  const offDispose = ctx.on('agent/disposed', disposed)
  const cleanup = async () => {
    offCreate?.()
    offDispose?.()
    await runtime.dispose()
    runtimes.delete(ctx.root ?? ctx)
  }
  ctx.effect(() => cleanup, 'vscode-mode:mcp-runtime')
  ready = initialize()
  await ready
}
