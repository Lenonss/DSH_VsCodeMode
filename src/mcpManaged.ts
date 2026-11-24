/**
 * dsh-vscode-mode host — 官方 mcpManager 托管的项目 MCP（DSH 0.2.3+）。
 * 职责：注册名派生、插件配置 → 官方条目、按工作区需求计的注册生命周期、状态缓存。
 * 约束：只经 mcpManager 端口访问官方服务；旧版宿主由调用方回落 mcpPool，本模块不感知；
 *       凭据不落插件，只登记官方要求的 credentialKey。
 * 作者 ddj 2026年11月23号
 */
import { createHash } from 'node:crypto'
import { managerPort, toManagerEntry, viewOf, type ManagerPort, type ManagerView } from './mcpManagerBridge.js'
import type { McpPolicy, MpcConfig } from './shared/mcp.js'
import type { Ctx } from './store.js'

// #region 类型

/** 一个项目定义；与 mcpRuntime.ProjectDef 同形，单独声明避免循环 import。 */
export interface ManagedDef {
  config: MpcConfig
  enabled: boolean
  policy?: McpPolicy
}

/** 对外的一条托管状态。 */
export interface ManagedState {
  state: string
  error?: string
  /** 官方报告的 OAuth 授权阶段。 */
  phase?: string
  /** 官方报告的真连上时刻（epoch 毫秒，仅 connected 状态有）。 */
  connectedAt?: number
  /** 本条注册的挂载时刻（epoch 毫秒），供会话卡片算耗时。 */
  since?: number
}

/** 一条托管注册的账目。 */
interface Held {
  /** 官方注册名，同时是工具命名空间。 */
  name: string
  /** 所属工作区路径。 */
  path: string
  /** .mcp.json 里的服务器名。 */
  server: string
  /** 配置 + 策略 + 启用态的稳定指纹。 */
  key: string
  /** 需求计数：归零才真正注销。 */
  refs: number
  /** 注册时刻：会话卡片按它算本服务器的耗时。 */
  mountedAt: number
  /** 注销函数；注册失败时缺省。 */
  dispose?: () => void
}

// #endregion

// #region 派生函数

/**
 * 派生官方注册名：8 位工作区哈希 + 原名截断，两段都满足 [A-Za-z0-9_-]{1,32}。
 * @public @author ddj 2026年11月23号
 * @param workspacePath 工作区路径
 * @param serverName .mcp.json 里的服务器名
 * @returns 全局唯一的注册名
 */
export function managedName(workspacePath: string, serverName: string): string {
  const digest = createHash('sha1').update(String(workspacePath)).digest('hex')
  const short = String(serverName).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 23)
  return digest.slice(0, 8) + '-' + short
}

/**
 * 配置指纹：内容或策略一变就要重注册，避免官方沿用旧连接。
 * @private @author ddj 2026年11月23号
 * @param def 项目定义
 * @returns 稳定指纹
 */
function keyOf(def: ManagedDef): string {
  return JSON.stringify([def.config, def.policy ?? null, def.enabled === true])
}

// #endregion

// #region 托管层

/** 官方 manager 上的项目级注册账本；一个宿主实例一份。 */
export class ManagedProject {
  /** 期望集合：工作区 → 服务器名 → 定义。 */
  private readonly desired = new Map<string, Map<string, ManagedDef>>()
  /** 已产生的注册：注册名 → 账目。 */
  private readonly held = new Map<string, Held>()
  /** 注册名 → 所属工作区，供隔离层判定归属。 */
  private readonly paths = new Map<string, string>()
  /** 状态缓存：注册名 → 官方视图。 */
  private readonly views = new Map<string, ManagerView>()
  private stop?: () => void

  /** @public @author ddj 2026年11月23号 @param ctx 宿主上下文 @param port 官方 manager 端口（可注入） */
  constructor(private readonly ctx: Ctx, private readonly port: ManagerPort = managerPort(ctx as never)) {}

  /** @public @author ddj 2026年11月23号 @returns 官方 manager 是否可用 */
  available(): boolean {
    return this.port.available()
  }

  /**
   * 订阅官方状态流：状态变化写入缓存并通知插件内部消费者。
   * @public @author ddj 2026年11月23号
   * @returns 无
   */
  start(): void {
    if (this.stop || !this.port.available()) return
    const controller = new AbortController()
    this.stop = () => controller.abort()
    void this.follow(controller.signal)
  }

  /**
   * 逐帧收集官方视图；流断开只记日志，不向装配期传播。
   * @private @author ddj 2026年11月23号
   * @param signal 订阅生命周期
   * @returns 流结束
   */
  private async follow(signal: AbortSignal): Promise<void> {
    try {
      for await (const views of this.port.watch(signal)) {
        this.views.clear()
        for (const view of views) if (view.name) this.views.set(view.name, view)
        this.ctx.emit?.('vscode-mode/mcp-change')
      }
    } catch (error) {
      if (!signal.aborted) this.ctx.logger?.warn?.('托管 MCP 状态流中断：' + String(error))
    }
  }

  /**
   * 对齐一个工作区的期望集合：变配置的重注册，删掉或禁用的注销，其余不动。
   * 只影响已经持有的注册，绝不因为对齐全量连接。
   * @public @author ddj 2026年11月23号
   * @param path 工作区路径
   * @param defs 该工作区的定义
   * @returns 无
   */
  sync(path: string, defs: Map<string, ManagedDef>): void {
    this.desired.set(path, defs)
    for (const record of [...this.held.values()]) {
      if (record.path !== path) continue
      const def = defs.get(record.server)
      if (def?.enabled && keyOf(def) === record.key) continue
      this.retire(record)
      if (def?.enabled && record.refs > 0) this.mount(path, record.server, def, record.refs)
    }
    this.ctx.emit?.('vscode-mode/mcp-change')
  }

  /**
   * 取一个工作区需求租约：首个租约才真正注册，末个租约注销。
   * @public @author ddj 2026年11月23号
   * @param path 工作区路径
   * @param server .mcp.json 里的服务器名
   * @returns 释放函数（可重复调用）
   */
  hold(path: string, server: string): () => void {
    const def = this.desired.get(path)?.get(server)
    if (!def?.enabled) return () => {}
    const name = managedName(path, server)
    const record = this.held.get(name)
    if (!record) {
      this.mount(path, server, def, 1)
      return this.releaseHook(name)
    }
    record.refs += 1
    if (keyOf(def) !== record.key) {
      this.retire(record)
      this.mount(path, server, def, record.refs)
    }
    return this.releaseHook(name)
  }

  /**
   * 造释放函数：同一个租约只生效一次，计数归零才注销。
   * @private @author ddj 2026年11月23号
   * @param name 注册名
   * @returns 释放函数
   */
  private releaseHook(name: string): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const record = this.held.get(name)
      if (!record) return
      record.refs = Math.max(0, record.refs - 1)
      if (record.refs === 0) this.retire(record)
    }
  }

  /**
   * 真正注册一条托管条目；冲突或校验失败只记状态，不抛给调用方。
   * @private @author ddj 2026年11月23号
   * @param path 工作区路径
   * @param server 服务器名
   * @param def 项目定义
   * @param refs 初始需求计数
   * @returns 无
   */
  private mount(path: string, server: string, def: ManagedDef, refs: number): void {
    const name = managedName(path, server)
    const record: Held = { name, path, server, key: keyOf(def), refs, mountedAt: Date.now() }
    this.held.set(name, record)
    const reason = this.conflictOf(name)
    if (reason) {
      this.ctx.logger?.warn?.('MCP 托管注册跳过（' + name + '）：' + reason)
      this.recordError(name, reason)
      return
    }
    try {
      record.dispose = this.port.register(name, toManagerEntry(def.config, name, 'on-demand'))
      this.paths.set(name, path)
    } catch (error) {
      const message = '托管注册失败：' + String(error)
      this.ctx.logger?.warn?.('MCP 托管注册失败（' + name + '）：' + String(error))
      this.recordError(name, message)
    }
    this.ctx.emit?.('vscode-mode/mcp-change')
  }

  /**
   * 检查注册名是否已被官方设置页或别的注册占用。
   * @private @author ddj 2026年11月23号
   * @param name 注册名
   * @returns 冲突原因，可用时 undefined
   */
  private conflictOf(name: string): string | undefined {
    const view = this.views.get(name) ?? viewOf(this.port.list(), name)
    if (!view) return undefined
    return view.configured ? '注册名已被官方设置页的服务器占用：' + name : '注册名已被另一个注册占用：' + name
  }

  /**
   * 注销一条账目：先摘账本再调用官方 disposer，失败只记日志。
   * @private @author ddj 2026年11月23号
   * @param record 账目
   * @returns 无
   */
  private retire(record: Held): void {
    this.held.delete(record.name)
    this.paths.delete(record.name)
    try {
      record.dispose?.()
    } catch (error) {
      this.ctx.logger?.warn?.('MCP 托管注销失败（' + record.name + '）：' + String(error))
    }
    this.ctx.emit?.('vscode-mode/mcp-change')
  }

  /**
   * 把一次失败挂进状态缓存，面板据此显示错误而不是假装连上。
   * @private @author ddj 2026年11月23号
   * @param name 注册名
   * @param message 可读原因
   * @returns 无
   */
  private recordError(name: string, message: string): void {
    this.views.set(name, { name, configured: true, state: 'failed', error: message })
  }

  /**
   * 重启一条托管连接；没有该注册时什么都不做。
   * @public @author ddj 2026年11月23号
   * @param path 工作区路径
   * @param server 服务器名
   * @returns 重启完成
   */
  async refresh(path: string, server: string): Promise<void> {
    const record = this.held.get(managedName(path, server))
    if (record) await this.port.restart(record.name)
  }

  /**
   * 读一条托管的当前状态；挂载时刻与官方连上时刻一并带出。
   * @public @author ddj 2026年11月23号
   * @param path 工作区路径
   * @param server 服务器名
   * @returns 状态与可选错误
   */
  stateOf(path: string, server: string): ManagedState {
    const name = managedName(path, server)
    const held = this.held.get(name)
    const view = this.views.get(name)
    // 没注册过就不是 disabled：那是「按需、还没人用」，面板按 configured 显示。
    if (!view) return held ? { state: 'unknown', since: held.mountedAt } : { state: 'idle' }
    const state: ManagedState = { state: view.state }
    if (held) state.since = held.mountedAt
    if (view.error) state.error = view.error
    if (view.phase) state.phase = view.phase
    if (view.connectedAt !== undefined) state.connectedAt = view.connectedAt
    return state
  }

  /**
   * 注册名 → 工作区：隔离层按它判定工具归属。
   * @public @author ddj 2026年11月23号
   * @returns 只读映射副本
   */
  ownedNames(): Map<string, string> {
    return new Map(this.paths)
  }

  /**
   * 停订阅并注销全部托管条目。
   * @public @author ddj 2026年11月23号
   * @returns 清理完成
   */
  async dispose(): Promise<void> {
    this.stop?.()
    this.stop = undefined
    for (const record of [...this.held.values()]) this.retire(record)
    this.desired.clear()
    this.views.clear()
    this.paths.clear()
  }
}

// #endregion
