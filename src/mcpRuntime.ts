/** Project-owned MCP connections and scoped on-demand capabilities. @author ddj 2026年10月20号 */
import { loadHostModule } from './hostImport.js'
import { entriesOf, MCP_PACKAGE, publicConfig, toolsOf } from './mcp.js'
import { isProjectEntryId } from './compat.js'
import { matchWorkspace } from './mcpIsolation.js'
import { ManagedProject, managedName } from './mcpManaged.js'
import { managerPort } from './mcpManagerBridge.js'
import { listProjects, projectEntryId, reconcileProject } from './mcpProject.js'
import { parseMcpPolicy, type McpPolicy, type McpPhase, type McpSessionServer, type McpSessionStatus, type MpcConfig, type MpcServer, type MpcStatus } from './shared/mcp.js'
import { McpPool, waitMcp, type PoolLease, type BridgeMaker } from './mcpPool.js'
import { McpBinding } from './mcpBridge.js'
import { installDiscover, discoverPrompt } from './mcpDiscover.js'
import type { Ctx } from './store.js'
import { cwdOfSession } from './store.js'
import { hostRootOf } from './hostRoot.js'

export type ProjectDef = { config: MpcConfig; enabled: boolean; policy?: McpPolicy }
type Instance = { key: string; path: string; lease: PoolLease; binding: McpBinding; ready: Promise<void>; startedAt: number; reused: boolean; firstCallMs?: number }
type AgentRecord = {
  instances: Map<string, Instance>
  resources: Map<string, () => void>
  /** 托管后端的注册租约：服务器名 → 释放函数。 */
  holds: Map<string, () => void>
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
  const owner = hostRootOf(ctx)
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
  /** 挂载后端：装配期探明后固定，避免两套连接并存。 */
  private backendChoice?: 'manager' | 'pool'
  /** 显式钉死后端（旧条目清理未完时回落连接池），不再重新探测。 */
  private backendPinned = false
  /** 托管层；旧版宿主永不建立。 */
  private managedLayer?: ManagedProject

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
      record = { instances: new Map(), resources: new Map(), holds: new Map(), requested: new Set(), live: true, tail: Promise.resolve(), startedAt: Date.now() }
      this.agents.set(agent, record)
    }
    return record
  }

  /** @public @author ddj 2026年10月20号 @param agent Newly created scope. Starts only configuration timing. */
  prepare(agent: any): void { this.recordOf(agent) }

  /**
   * 探明挂载后端：官方 mcpManager 可用就走托管，否则走自有连接池。
   * 允许一次「池→托管」升级（加载顺序可能让 manager 晚于本插件就绪），
   * 但只在连接池还没建立任何条目时升级，保证同一服务器不会两套连接并存。
   * @public @author ddj 2026年11月23号
   * @returns 后端名
   */
  probeBackend(): 'manager' | 'pool' {
    if (this.backendPinned && this.backendChoice) return this.backendChoice
    const detected = managerPort(this.ctx as never).available() ? 'manager' : 'pool'
    const idle = this.pool.entries.size === 0
    if (this.backendChoice === undefined || (detected === 'manager' && idle)) this.backendChoice = detected
    return this.backendChoice ?? detected
  }

  /**
   * 装配期发现旧条目清理未完成时强制回落连接池，绝不与托管双写。
   * @public @author ddj 2026年11月23号
   * @returns 无
   */
  forcePool(): void {
    this.backendChoice = 'pool'
    this.backendPinned = true
  }

  /**
   * 取托管层；只在托管后端使用，旧版宿主不会建立它。
   * @private @author ddj 2026年11月23号
   * @returns 托管层
   */
  private managedOf(): ManagedProject {
    this.managedLayer ??= new ManagedProject(this.ctx)
    return this.managedLayer
  }

  /**
   * 插件自己托管注册的名字，供全局列表去重。
   * @public @author ddj 2026年11月23号
   * @returns 注册名集合（未建托管层时为空）
   */
  managedNames(): Set<string> {
    return new Set(this.managedLayer?.ownedNames().keys() ?? [])
  }

  /**
   * 托管后端按需重启；连接池后端已由 replace(refresh) 重挂载，这里不再动。
   * @public @author ddj 2026年11月23号
   * @param path Owner workspace.
   * @param serverName Target definition.
   * @returns 重启完成
   */
  async refresh(path: string, serverName: string): Promise<void> {
    if (this.probeBackend() === 'manager') await this.managedOf().refresh(path, serverName)
  }

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
    for (const [name, path] of this.managedLayer?.ownedNames() ?? []) names.set(name, path)
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
    // 托管层只在已建立后跟随配置；首次建立时由 attach/connect 自行同步。
    this.managedLayer?.sync(path, defs)
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
    if (this.probeBackend() === 'manager') {
      this.holdFor(agent, record)
      return Promise.resolve()
    }
    return this.enqueue(agent, record)
  }

  /**
   * 托管后端：为本会话所在工作区的每个启用定义取注册租约，工作区外的一律释放。
   * @private @author ddj 2026年11月23号
   * @param agent 会话作用域
   * @param record 该会话的账目
   * @returns 无
   */
  private holdFor(agent: any, record: AgentRecord): void {
    const path = this.workspace(agent)
    const defs = path ? this.projects.get(path) ?? new Map<string, ProjectDef>() : new Map<string, ProjectDef>()
    const managed = this.managedOf()
    managed.start()
    if (path) managed.sync(path, defs)

    for (const [name, release] of record.holds) {
      if (defs.get(name)?.enabled) continue
      release()
      record.holds.delete(name)
    }
    for (const [name, def] of defs) {
      if (!def.enabled || record.holds.has(name) || !path) continue
      record.holds.set(name, managed.hold(path, name))
    }
    this.changed()
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
    const path = this.workspace(agent) ?? ''
    const enabled = [...this.projects.get(path) ?? []].filter(([, def]) => def.enabled)
    if (this.probeBackend() === 'manager') {
      const managed = this.managedOf()
      return enabled.map(([serverName]) => ({ serverName, phase: managedPhase(managed.stateOf(path, serverName).state) }))
    }
    return enabled.map(([serverName]) => {
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
    if (this.probeBackend() === 'manager') return this.connectManaged(agent, record, name)
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
    const registry = agent.ctx.get('tools')
    // Discovery is not step admission; the official executor still owns execution permission.
    let visible: ReadonlySet<string>
    if (typeof registry?.definitions === 'function') {
      visible = new Set(registry.definitions(agent).map((tool: { name: string }) => tool.name))
    } else if (typeof registry?.view === 'function') {
      visible = new Set(registry.view(agent).visible.keys())
    } else {
      throw new Error('项目 MCP 工具目录不可用：缺少公开 definitions 或旧版 view 接口')
    }
    const tools = [...instance.lease.entry.bridge!.tools.values()].filter((tool) => visible.has(tool.name))
      .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    return { serverName: name, tools, resources: instance.lease.entry.bridge!.resources.has(name), nextRequest: 'Use these tools in the next model request; PTC must start a new program to refresh its SDK.' }
  }

  /**
   * 托管后端：连接由官方 manager 持有，这里只确认归属并回读该会话可见的工具。
   * @private @author ddj 2026年11月23号
   * @param agent 会话作用域
   * @param record 该会话账目
   * @param name .mcp.json 里的服务器名
   * @returns 真实工具清单，不猜
   */
  private connectManaged(agent: any, record: AgentRecord, name: string): { serverName: string; tools: any[]; resources: boolean; nextRequest: string } {
    const path = this.workspace(agent)
    const def = path ? this.projects.get(path)?.get(name) : undefined
    if (!path || !def?.enabled) throw new Error('当前工作区未启用该项目 MCP')
    const managed = this.managedOf()
    managed.sync(path, this.projects.get(path) ?? new Map())
    if (!record.holds.has(name)) record.holds.set(name, managed.hold(path, name))

    const state = managed.stateOf(path, name)
    if (state.state === 'failed') throw new Error(state.error ?? '项目 MCP 托管失败')
    // 资源登记同样由官方实例完成，插件这边不再持有资源入口，因此不谎报 resources。
    const tools = toolsOf(this.ctx, managedName(path, name), agent).map((tool) => ({ name: tool.name, description: tool.description }))
    return { serverName: name, tools, resources: false, nextRequest: 'Use these tools in the next model request; PTC must start a new program to refresh its SDK.' }
  }

  /** @public @author ddj 2026年10月20号 @param agent Disposed owner. @returns Scoped teardown; shared transports remain owned by other leases. */
  async detach(agent: any): Promise<void> {
    this.retired.add(agent)
    const record = this.agents.get(agent)
    if (!record) return
    record.live = false
    record.remove?.()
    for (const remove of record.resources.values()) remove()
    for (const release of record.holds.values()) release()
    record.holds.clear()
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
    if (this.probeBackend() === 'manager') return this.viewsManaged(path)
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

  /**
   * 托管后端的项目视图：状态取自官方 manager，工具取自各会话真实可见集合。
   * @private @author ddj 2026年11月23号
   * @param path 工作区路径
   * @returns 脱敏服务器视图
   */
  private viewsManaged(path: string): MpcServer[] {
    const managed = this.managedOf()
    return [...this.projects.get(path) ?? []].map(([name, def]) => {
      const state = managed.stateOf(path, name)
      const tools = new Map<string, MpcServer['tools'][number]>()
      for (const [agent] of this.agents) {
        if (this.workspace(agent) !== path) continue
        for (const tool of toolsOf(this.ctx, managedName(path, name), agent)) tools.set(tool.name, tool)
      }
      const view: MpcServer = {
        id: projectEntryId(path, name), serverName: name, enabled: def.enabled, transport: def.config.transport,
        config: publicConfig(def.config as unknown as Record<string, unknown>), policy: parseMcpPolicy(def.policy),
        status: managedStatusOf(def.enabled, state.state), tools: [...tools.values()], toolCount: tools.size,
        instanceCount: state.state === 'connected' ? 1 : 0, sessionCount: 0,
        managed: true, managerState: state.state, registrationName: managedName(path, name),
      }
      if (state.error) view.error = state.error
      if (state.phase) view.phase = state.phase
      return view
    })
  }

  /** @public @author ddj 2026年10月20号 @returns Complete owned transport and capability cleanup. */
  async dispose(): Promise<void> {
    this.stopped = true
    this.offDiscover?.()
    await Promise.all([...this.agents.keys()].map((agent) => this.detach(agent)))
    await this.managedLayer?.dispose()
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

/**
 * 列出仍残留在 loader 里的项目条目：托管后端不允许它们存在，否则就是双写。
 * @public @author ddj 2026年11月23号
 * @param ctx Host loader.
 * @returns 残留条目 id
 */
export function leftoverOf(ctx: Ctx): string[] {
  return entriesOf(ctx)
    .filter((entry) => isProjectEntryId(String(entry.id ?? entry.options?.id ?? '')))
    .map((entry) => String(entry.id))
}

/**
 * 官方状态 → 插件阶段：未知一律 idle，不假装连上。
 * @private @author ddj 2026年11月23号
 * @param state 官方状态名
 * @returns 插件阶段
 */
function managedPhase(state: string): McpPhase {
  if (state === 'connected') return 'ready'
  if (state === 'connecting') return 'starting'
  if (state === 'failed') return 'error'
  return 'idle'
}

/**
 * 官方状态 → 面板状态：未连接的默认值保持 configured，不冒充 verified。
 * @private @author ddj 2026年11月23号
 * @param enabled 配置里的启用态
 * @param state 官方状态名
 * @returns 面板状态
 */
function managedStatusOf(enabled: boolean, state: string): MpcStatus {
  if (!enabled) return 'disabled'
  if (state === 'connected') return 'connected'
  if (state === 'connecting') return 'connecting'
  if (state === 'failed') return 'error'
  return 'configured'
}

/** @public @author ddj 2026年10月20号 @param ctx Host lifecycle. @returns Config/catalogue readiness, independent from all project MCP handshakes. */
export async function installMcpRuntime(ctx: Ctx): Promise<void> {
  const runtime = runtimeOf(ctx)
  let ready: Promise<void>
  /** @author ddj 2026年10月20号 Loads validated snapshots before exposing lazy capabilities. */
  const initialize = async (): Promise<void> => {
    await clearLegacy(ctx)
    // 托管后端要求旧条目彻底清空；清理未完就回落连接池，绝不与托管双写。
    if (runtime.probeBackend() === 'manager' && leftoverOf(ctx).length > 0) {
      ctx.logger?.warn?.('旧版项目 MCP 条目清理未完成，本次改用连接池后端：' + leftoverOf(ctx).join(', '))
      runtime.forcePool()
    }
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
  const cleanup = async (): Promise<void> => { offCreate?.(); offDispose?.(); await runtime.dispose(); runtimes.delete(hostRootOf(ctx)) }
  ctx.effect(() => cleanup, 'vscode-mode:mcp-runtime')
  ready = initialize()
  await ready
  await Promise.all((ctx.get('agents')?.list?.() ?? []).map((agent: any) => runtime.attach(agent)))
}
