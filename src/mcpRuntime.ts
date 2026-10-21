/** Project-owned MCP connections and scoped on-demand capabilities. @author ddj 2026年10月20号 */
import { loadHostModule } from './hostImport.js'
import { entriesOf, MCP_PACKAGE, publicConfig, toolsOf } from './mcp.js'
import { isProjectEntryId } from './compat.js'
import { matchWorkspace } from './mcpIsolation.js'
import { listProjects, projectEntryId, reconcileProject } from './mcpProject.js'
import { parseMcpPolicy, type McpPolicy, type McpPhase, type McpSessionServer, type McpSessionStatus, type MpcConfig, type MpcServer } from './shared/mcp.js'
import { McpPool, waitMcp, type PoolLease, type BridgeMaker } from './mcpPool.js'
import { McpBinding } from './mcpBridge.js'
import { installDiscover, discoverPrompt } from './mcpDiscover.js'
import type { Ctx } from './store.js'
import { cwdOfSession } from './store.js'

export type ProjectDef = { config: MpcConfig; enabled: boolean; policy?: McpPolicy }
type Instance = { key: string; path: string; lease: PoolLease; binding: McpBinding; ready: Promise<void>; startedAt: number; reused: boolean; firstCallMs?: number }
type AgentRecord = {
  instances: Map<string, Instance>
  resources: Map<string, () => void>
  requested: Set<string>
  live: boolean
  tail: Promise<void>
  remove?: () => void
  startedAt: number
  finishedAt?: number
  error?: string
}
export type McpLoader = () => Promise<any>
const runtimes = new WeakMap<object, McpRuntime>()

/** @private @author ddj 2026年09月28号 @returns Official namespace from the running Host installation. */
async function loadMcp(): Promise<any> { return loadHostModule(MCP_PACKAGE) }

/** @public @author ddj 2026年09月28号 @param ctx Host context. @returns Lazy per-host runtime, without opening connections. */
export function runtimeOf(ctx: Ctx): McpRuntime {
  const owner = ctx.root ?? ctx
  let runtime = runtimes.get(owner)
  if (!runtime) { runtime = new McpRuntime(ctx); runtimes.set(owner, runtime) }
  return runtime
}

/** The pool owns transports; each agent owns only revocable public capabilities and leases. */
export class McpRuntime {
  readonly projects = new Map<string, Map<string, ProjectDef>>()
  readonly agents = new Map<any, AgentRecord>()
  readonly pool: McpPool
  private stopped = false
  private offDiscover?: () => void
  private readonly retired = new WeakSet<object>()
  private module?: Promise<any>
  private readonly pending = new Set<Promise<unknown>>()
  private readonly barriers = new Map<string, Promise<void>>()

  /** @public @author ddj 2026年10月20号 @param ctx Host services. @param load Official module resolver. @param make Optional controlled private-scope factory for tests. */
  constructor(private readonly ctx: Ctx, private readonly load: McpLoader = loadMcp, make?: BridgeMaker) {
    this.pool = new McpPool(ctx, () => this.getModule(), make)
  }

  /** @private @author ddj 2026年10月20号 @param task Owned background operation. Tracks failures without abandoning work. */
  private track(task: Promise<unknown>): void {
    this.pending.add(task)
    void task.catch((error) => this.ctx.logger?.warn?.('Project MCP task failed: ' + String(error)))
      .finally(() => this.pending.delete(task))
  }

  /** @private @author ddj 2026年10月20号 @param agent Scope owner. @returns Live record; retired agents cannot be resurrected. */
  private recordOf(agent: any): AgentRecord | undefined {
    if (this.stopped || this.retired.has(agent)) return undefined
    let record = this.agents.get(agent)
    if (!record) {
      record = { instances: new Map(), resources: new Map(), requested: new Set(), live: true, tail: Promise.resolve(), startedAt: Date.now() }
      this.agents.set(agent, record)
    }
    return record
  }

  /** @public @author ddj 2026年10月20号 @param agent Newly created scope. Starts only configuration timing. */
  prepare(agent: any): void { this.recordOf(agent) }

  /** @public @author ddj 2026年10月20号 @param agent Owner. @param error Configuration failure, never sent raw to clients. */
  configError(agent: any, error?: unknown): void {
    const record = this.recordOf(agent)
    if (record) record.error = error === undefined ? undefined : '项目 MCP 配置读取或校验失败，保留最后有效配置；请查看 Host 日志'
  }

  /** @public @author ddj 2026年09月28号 @param agent Agent identity. @returns Longest registered workspace containing its cwd. */
  workspace(agent: any): string | undefined {
    const paths = (this.ctx.get('workspaceRegistry')?.list?.() ?? []).map((ws: { path: string }) => ws.path)
    return matchWorkspace(cwdOfSession(this.ctx, agent?.session) ?? undefined, paths)
  }

  /** @public @author ddj 2026年09月28号 @returns Configured namespaces including disabled definitions. */
  owners(): Map<string, string> {
    const names = new Map<string, string>()
    for (const record of this.agents.values()) for (const [name, instance] of record.instances) names.set(name, instance.path)
    for (const [path, defs] of this.projects) for (const name of defs.keys()) names.set(name, path)
    return names
  }

  /** @private @author ddj 2026年10月20号 @param def Effective definition. @returns Config and policy generation identity. */
  private defKey(def: ProjectDef): string { return JSON.stringify([def.config, parseMcpPolicy(def.policy)]) }

  /** @private @author ddj 2026年09月28号 Refreshes existing isolation restrictions synchronously. */
  private changed(): void { this.ctx.emit?.('vscode-mode/mcp-change') }

  /** @private @author ddj 2026年10月20号 @param instance Public lease to revoke. Revokes synchronously before lease release. */
  private revoke(instance: Instance): void { instance.binding.dispose(); instance.lease.release() }

  /** @public @author ddj 2026年10月20号 @param path Owner workspace. @param defs Validated snapshot. @param refresh Optional explicitly invalidated service. @param wait Await configuration cleanup, never connection readiness. @returns Publication and optionally cleanup completion. */
  async replace(path: string, defs: Map<string, ProjectDef>, refresh?: string, wait = true): Promise<void> {
    if (this.stopped) return
    const previous = this.projects.get(path)
    if (!refresh && previous && JSON.stringify([...previous]) === JSON.stringify([...defs])) return
    this.projects.set(path, defs)
    const closing = new Set<ReturnType<McpPool['acquire']>['entry']>()
    for (const [agent, record] of this.agents) {
      for (const [name, instance] of record.instances) {
        const def = defs.get(name)
        if (instance.path !== path) continue
        if (this.workspace(agent) === path && def?.enabled && this.defKey(def) === instance.key && name !== refresh) continue
        record.instances.delete(name)
        this.revoke(instance)
        closing.add(instance.lease.entry)
      }
    }
    // Warm entries may have no active subscribers, but must still respect config invalidation.
    for (const entry of this.pool.entries.values()) {
      if (entry.spec.workspace !== path) continue
      const def = defs.get(entry.spec.config.serverName)
      const config = def && this.options(def.config, path)
      if (!def?.enabled || JSON.stringify(config) !== JSON.stringify(entry.spec.config)
        || JSON.stringify(parseMcpPolicy(def.policy)) !== JSON.stringify(entry.spec.policy) || entry.spec.config.serverName === refresh) closing.add(entry)
    }
    const prior = this.barriers.get(path) ?? Promise.resolve()
    const cleanup = Promise.all([...closing].map((entry) => this.pool.retire(entry))).then(() => undefined)
    const barrier = Promise.all([prior, cleanup]).then(() => undefined)
    this.barriers.set(path, barrier)
    this.track(barrier)
    this.changed()
    const updates = [...this.agents].map(([agent, record]) => this.enqueue(agent, record))
    if (wait) await Promise.all([barrier, ...updates])
  }

  /** @private @author ddj 2026年10月20号 @param agent Owner. @param record Lightweight queue. @returns Scoped catalogue/resource update, not transport initialization. */
  private enqueue(agent: any, record: AgentRecord): Promise<void> {
    const update = async (): Promise<void> => {
      if (!record.live || this.stopped) return
      this.syncAgent(agent, record)
    }
    const task = record.tail.then(update)
    record.tail = task.catch(() => { record.error = 'MCP 清理或入口更新失败，请查看 Host 日志' })
    this.track(task)
    return task
  }

  /** @public @author ddj 2026年10月20号 @param agent Live agent. @returns Lightweight capability installation; never waits for MCP startup. */
  attach(agent: any): Promise<void> {
    const record = this.recordOf(agent)
    if (!record) return Promise.resolve()
    this.offDiscover ??= installDiscover(this, this.ctx)
    if (!record.remove) record.remove = discoverPrompt(this, agent)
    return this.enqueue(agent, record)
  }

  /** @private @author ddj 2026年10月20号 @param agent Owner. @param record Scope record. Updates lazy resources and schedules explicit background services. */
  private syncAgent(agent: any, record: AgentRecord): void {
    const path = this.workspace(agent)
    const defs = this.projects.get(path ?? '') ?? new Map<string, ProjectDef>()
    for (const [name, instance] of record.instances) {
      const def = defs.get(name)
      if (instance.path === path && def?.enabled && this.defKey(def) === instance.key) continue
      record.instances.delete(name)
      this.revoke(instance)
    }
    for (const remove of record.resources.values()) remove()
    record.resources.clear()
    for (const [name, def] of defs) {
      if (!def.enabled) continue
      this.lazyResource(agent, record, name)
      if (!record.instances.has(name) && (parseMcpPolicy(def.policy).startup === 'background' || record.requested.has(name))) this.track(this.connect(agent, name))
    }
    record.finishedAt ??= Date.now()
    this.changed()
  }

  /** @private @author ddj 2026年10月20号 @param agent Owner. @param record Ledger. @param name Enabled namespace. Installs a resource-only on-demand entry without starting a connection. */
  private lazyResource(agent: any, record: AgentRecord, name: string): void {
    const resources = agent.ctx.get('mcpResources')
    /** @author ddj 2026年10月20号 @param request Resource operation. @param execution Actual registry caller. @returns Official provider result after demand connection. */
    const request = async (request: any, execution: any): Promise<any> => {
      if (execution?.agent !== agent) throw new Error('不能借用其他会话的 MCP 资源')
      await this.connect(agent, name, execution.signal)
      const instance = record.instances.get(name)
      if (!instance || !this.valid(agent, record, name, instance)) throw new Error('项目 MCP 配置已失效')
      return this.pool.run(instance.lease.entry, async () => {
        if (!this.valid(agent, record, name, instance)) throw new Error('项目 MCP 配置已失效')
        const provider = instance.lease.entry.bridge?.resources.get(name)
        if (!provider) throw new Error('MCP 未提供资源入口')
        const startedAt = Date.now()
        const result = await provider.request(request, execution)
        instance.firstCallMs ??= Date.now() - startedAt
        return result
      }, execution.signal)
    }
    record.resources.set(name, resources.register(name, { request }))
  }

  /** @private @author ddj 2026年10月20号 @param agent Owner. @param record Ledger. @param name Namespace. @param instance Exact lease. @returns Whether a previously issued proxy can still execute. */
  private valid(agent: any, record: AgentRecord, name: string, instance: Instance): boolean {
    const path = this.workspace(agent)
    const def = this.projects.get(path ?? '')?.get(name)
    return !this.stopped && record.live && record.instances.get(name) === instance && instance.path === path
      && def?.enabled === true && this.defKey(def) === instance.key
  }

  /** @private @author ddj 2026年10月20号 @param config Official config. @param path Default working directory. @returns Detached effective config; project strategy is never forwarded. */
  private options(config: MpcConfig, path: string): MpcConfig {
    return config.transport === 'stdio' ? { ...config, cwd: config.cwd || path } : { ...config }
  }

  /** @public @author ddj 2026年10月20号 @param agent Actual execution owner. @returns Safe enabled catalogue without opening connections. */
  catalogue(agent: any): Array<{ serverName: string; phase: McpPhase }> {
    const record = this.agents.get(agent)
    if (!record?.live || this.stopped) return []
    return [...this.projects.get(this.workspace(agent) ?? '') ?? []].filter(([, def]) => def.enabled)
      .map(([serverName]) => {
        const entry = record.instances.get(serverName)?.lease.entry
        const phase: McpPhase = entry?.fiber?.state === 3 ? 'error' : entry?.phase ?? 'idle'
        return { serverName, phase }
      })
  }

  /** @private @author ddj 2026年10月20号 @param agent Owner. @param record Ledger. @param path Workspace. @param name Namespace. @param def Validated definition. @returns Synchronously reserved lease and public binding. */
  private reserve(agent: any, record: AgentRecord, path: string, name: string, def: ProjectDef): Instance {
    const lease = this.pool.acquire({ workspace: path, owner: agent, config: this.options(def.config, path), policy: parseMcpPolicy(def.policy) })
    const instance = { key: this.defKey(def), path, lease, startedAt: Date.now(), reused: lease.entry.refs > 1 || lease.entry.phase === 'ready' } as Instance
    const valid = (): boolean => this.valid(agent, record, name, instance)
    instance.binding = new McpBinding(agent, this.pool, lease.entry, valid, (elapsed) => { instance.firstCallMs ??= elapsed })
    record.instances.set(name, instance)
    instance.ready = lease.entry.ready.then(() => {
      if (!valid()) throw new Error('项目 MCP 配置已失效')
      instance.binding.sync()
      this.changed()
    })
    this.track(instance.ready)
    return instance
  }

  /** @public @author ddj 2026年10月20号 @param agent Actual active caller. @param name Enabled configured server. @param signal Caller-local cancellation. @returns Real tool schemas after private initial sync; no guessed tools. */
  async connect(agent: any, name: string, signal?: AbortSignal): Promise<{ serverName: string; tools: any[]; resources: boolean; nextRequest: string }> {
    const record = this.agents.get(agent)
    if (!record?.live || this.stopped) throw new Error('会话未激活，不能连接项目 MCP')
    await waitMcp(record.tail, signal)
    const path = this.workspace(agent)
    await waitMcp(this.barriers.get(path ?? '') ?? Promise.resolve(), signal)
    if (!record.live || this.workspace(agent) !== path) throw new Error('项目 MCP 作用域已失效')
    const def = this.projects.get(path ?? '')?.get(name)
    if (!def?.enabled || !path) throw new Error('当前工作区未启用该项目 MCP')
    const global = entriesOf(this.ctx).some((entry) => !isProjectEntryId(String(entry.id ?? entry.options?.id ?? '')) && entry.options?.config?.serverName === name)
    if (global) throw new Error('serverName 已被全局 MCP 使用')
    let instance = record.instances.get(name)
    if (instance?.lease.entry.phase === 'error' && (instance.lease.entry.retryAt ?? Infinity) <= Date.now()) {
      record.instances.delete(name); this.revoke(instance); instance = undefined
    }
    record.requested.add(name)
    instance ??= this.reserve(agent, record, path, name, def)
    await waitMcp(instance.ready, signal)
    if (!this.valid(agent, record, name, instance)) throw new Error('项目 MCP 配置已失效')
    const visible = agent.ctx.get('tools')?.view?.(agent)?.visible
    const tools = [...instance.lease.entry.bridge!.tools.values()].filter((tool) => visible?.has(tool.name))
      .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    return { serverName: name, tools, resources: instance.lease.entry.bridge!.resources.has(name), nextRequest: 'Use these tools in the next model request; PTC must start a new program to refresh its SDK.' }
  }

  /** @public @author ddj 2026年10月20号 @param agent Disposed owner. @returns Scoped teardown; shared transports remain owned by other leases. */
  async detach(agent: any): Promise<void> {
    this.retired.add(agent)
    const record = this.agents.get(agent)
    if (!record) return
    record.live = false
    record.remove?.()
    for (const remove of record.resources.values()) remove()
    for (const instance of record.instances.values()) this.revoke(instance)
    record.instances.clear()
    this.agents.delete(agent)
    this.changed()
  }

  /** @private @author ddj 2026年10月08号 @returns Cached official module; failures are retryable. */
  private async getModule(): Promise<any> {
    const loading = this.module ??= this.load()
    try { return await loading } catch (error) { if (this.module === loading) this.module = undefined; throw error }
  }

  /** @public @author ddj 2026年10月20号 @returns Detached read-only active session statuses, without IO or activation. */
  sessionSnapshot(): { sessions: McpSessionStatus[]; sampledAt: number } {
    const sessions: McpSessionStatus[] = []
    for (const [agent, record] of this.agents) {
      if (!record.live || typeof agent?.session?.id !== 'string') continue
      const servers = this.sessionServers(agent, record)
      const active = servers.find((server) => ['stopping', 'starting', 'loading', 'queued'].includes(server.phase))
      let phase: McpPhase = 'ready'
      if (record.error || servers.some((server) => server.phase === 'error')) phase = 'error'
      else if (active) phase = active.phase
      else if (!record.finishedAt) phase = 'preparing'
      else if (!servers.length) phase = 'none'
      else if (servers.some((server) => server.phase === 'idle')) phase = 'idle'
      const attempts = servers.filter((server) => server.phase !== 'idle')
      const startedAt = attempts.length ? Math.min(...attempts.map((server) => server.startedAt)) : record.startedAt
      sessions.push({ configMs: Math.max(0, (record.finishedAt ?? Date.now()) - record.startedAt), sessionId: agent.session.id, phase, startedAt, phaseAt: active?.phaseAt ?? startedAt,
        finishedAt: active ? undefined : Math.max(record.finishedAt ?? record.startedAt, ...servers.map((server) => server.finishedAt ?? 0)), error: record.error, servers })
    }
    return { sessions, sampledAt: Date.now() }
  }

  /** @private @author ddj 2026年10月20号 @param agent Owner. @param record Ledger. @returns Server phases with caller-local timing, not pooled connection age. */
  private sessionServers(agent: any, record: AgentRecord): McpSessionServer[] {
    return this.catalogue(agent).map(({ serverName, phase }) => {
      const instance = record.instances.get(serverName)
      if (!instance) return { serverName, phase: 'idle', startedAt: record.finishedAt ?? record.startedAt, phaseAt: record.finishedAt ?? record.startedAt }
      const entry = instance.lease.entry
      return { serverName, phase, startedAt: instance.startedAt, phaseAt: Math.max(instance.startedAt, entry.phaseAt),
        finishedAt: entry.finishedAt && Math.max(instance.startedAt, entry.finishedAt), error: entry.error, reused: instance.reused,
        queuedMs: Math.max(0, (entry.startAt ?? Date.now()) - instance.startedAt),
        connectMs: entry.connectedAt === undefined ? undefined : Math.max(0, entry.connectedAt - Math.max(instance.startedAt, entry.startAt ?? instance.startedAt)), firstCallMs: instance.firstCallMs }
    })
  }

  /** @public @author ddj 2026年09月28号 @param path Workspace. @returns Masked configuration and pool/lease counts; initialization is not health. */
  views(path: string): MpcServer[] {
    return [...this.projects.get(path) ?? []].map(([name, def]) => {
      const entries = [...this.pool.entries.values()].filter((entry) => entry.spec.workspace === path && entry.spec.config.serverName === name)
      const tools = new Map<string, MpcServer['tools'][number]>()
      for (const [agent] of this.agents) if (this.workspace(agent) === path) for (const tool of toolsOf(this.ctx, name, agent)) tools.set(tool.name, tool)
      const failed = entries.some((entry) => entry.phase === 'error' || entry.error)
      const busy = entries.some((entry) => ['queued', 'loading', 'starting', 'stopping'].includes(entry.phase))
      let status: MpcServer['status'] = 'configured'
      if (!def.enabled) status = 'disabled'
      else if (failed) status = 'error'
      else if (busy) status = 'connecting'
      else if (entries.some((entry) => entry.phase === 'ready')) status = 'unverified'
      return { id: projectEntryId(path, name), serverName: name, enabled: def.enabled, transport: def.config.transport,
        config: publicConfig(def.config as unknown as Record<string, unknown>), policy: parseMcpPolicy(def.policy), status,
        instanceCount: entries.filter((entry) => entry.fiber).length, sessionCount: entries.reduce((total, entry) => total + entry.refs, 0),
        tools: [...tools.values()], toolCount: tools.size, error: failed ? 'MCP 初始化或清理异常，请查看 Host 日志' : undefined }
    })
  }

  /** @public @author ddj 2026年10月20号 @returns Complete owned transport and capability cleanup. */
  async dispose(): Promise<void> {
    this.stopped = true
    this.offDiscover?.()
    await Promise.all([...this.agents.keys()].map((agent) => this.detach(agent)))
    await this.pool.dispose()
    await Promise.allSettled([...this.pending])
    this.projects.clear()
    this.module = undefined
  }
}

/** @public @author ddj 2026年09月28号 @param ctx Host loader. @returns Removal of legacy global project entries before any scoped entry is installed. */
export async function clearLegacy(ctx: Ctx): Promise<void> {
  const loader = ctx.get('loader')
  for (const entry of entriesOf(ctx)) {
    if (!isProjectEntryId(String(entry.id ?? entry.options?.id ?? ''))) continue
    await loader.remove(entry.id)
  }
}

/** @public @author ddj 2026年10月20号 @param ctx Host lifecycle. @returns Config/catalogue readiness, independent from all project MCP handshakes. */
export async function installMcpRuntime(ctx: Ctx): Promise<void> {
  const runtime = runtimeOf(ctx)
  let ready: Promise<void>
  /** @author ddj 2026年10月20号 Loads validated snapshots before exposing lazy capabilities. */
  const initialize = async (): Promise<void> => {
    await clearLegacy(ctx)
    const { projects } = await listProjects(ctx, false)
    for (const agent of ctx.get('agents')?.list?.() ?? []) {
      runtime.prepare(agent)
      const project = projects.find((item) => item.workspacePath === runtime.workspace(agent))
      if (project?.fileError) runtime.configError(agent, project.fileError)
    }
  }
  /** @author ddj 2026年10月20号 @param event Actual created agent. Reads configuration but never waits for connection startup. */
  const created = async ({ agent }: { agent: any }): Promise<void> => {
    runtime.prepare(agent)
    await ready
    const path = runtime.workspace(agent)
    if (path) {
      try { await reconcileProject(ctx, path, undefined, false); runtime.configError(agent) }
      catch (error) { runtime.configError(agent, error); ctx.logger?.warn?.('MCP configuration retained: ' + String(error)) }
    }
    await runtime.attach(agent)
  }
  /** @author ddj 2026年10月20号 @param event Actual disposed agent. Revokes public access synchronously. */
  const disposed = ({ agent }: { agent: any }): void => { void runtime.detach(agent).catch((error) => ctx.logger?.warn?.('MCP disposal failed: ' + String(error))) }
  const offCreate = ctx.on('agent/created', created)
  const offDispose = ctx.on('agent/disposed', disposed)
  /** @author ddj 2026年10月20号 @returns Full lifecycle teardown. */
  const cleanup = async (): Promise<void> => { offCreate?.(); offDispose?.(); await runtime.dispose(); runtimes.delete(ctx.root ?? ctx) }
  ctx.effect(() => cleanup, 'vscode-mode:mcp-runtime')
  ready = initialize()
  await ready
  await Promise.all((ctx.get('agents')?.list?.() ?? []).map((agent: any) => runtime.attach(agent)))
}
