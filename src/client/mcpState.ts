import type { MpcProject, MpcServer } from '../shared/mcp.js'
import type { rpc } from './rpc.js'

export interface McpView {
  servers: MpcServer[]
  projects: MpcProject[]
  loading: boolean
  busy: string
  error: string
}
interface McpTiming { interval?: number; timeout?: number }
interface ReadToken { controller: AbortController; version: number; timer: ReturnType<typeof setTimeout> }
type Result = { ok: boolean; error?: string }

/** Owns MCP read lifetimes and one synchronous mutation lock for the entire management page. */
export class McpState {
  readonly view: McpView = { servers: [], projects: [], loading: true, busy: '', error: '' }
  private active = false
  private visible = true
  private disposed = false
  private version = 0
  private reading: ReadToken | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly interval: number
  private readonly timeout: number

  /** @public @author ddj 2026年10月08号 @param request Typed RPC transport. @param changed View notification. @param timing Bounded read and polling timings. */
  constructor(private readonly request: typeof rpc, private readonly changed: (view: McpView) => void, timing: McpTiming = {}) {
    this.interval = Math.max(100, timing.interval ?? 2500)
    this.timeout = Math.max(50, timing.timeout ?? 10000)
  }

  //region Read lifecycle
  /** @private @author ddj 2026年10月08号 @description Publish a copied view only while mounted. */
  private emit(): void {
    if (!this.disposed) this.changed({ ...this.view })
  }

  /** @private @author ddj 2026年10月08号 @description Cancel scheduled reads and invalidate every older response. */
  private invalidate(): void {
    this.version++
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.reading?.controller.abort()
  }

  /** @private @author ddj 2026年10月08号 @description Schedule a single read only after the preceding transport settled. */
  private schedule(): void {
    if (this.disposed || !this.active || !this.visible || this.reading || this.view.loading || this.view.busy || this.timer !== null) return
    this.timer = setTimeout(this.poll, this.interval)
  }

  /** @private @author ddj 2026年10月08号 @description Timer entry, with failures handled in read. */
  private poll = (): void => {
    this.timer = null
    void this.read(false)
  }

  /** @private @author ddj 2026年10月08号 @returns Versioned read token with an abort deadline. */
  private beginRead(): ReadToken {
    const controller = new AbortController()
    const version = this.version
    /** @author ddj 2026年10月08号 @description Abort timed-out transport and invalidate its eventual response. */
    const expire = (): void => {
      controller.abort()
      if (this.disposed || version !== this.version) return
      this.version++
      this.view.loading = false
      this.view.error = '读取 MCP 状态超时'
      this.emit()
    }
    const token = { controller, version, timer: setTimeout(expire, this.timeout) }
    this.reading = token
    return token
  }

  /** @private @author ddj 2026年10月08号 @param initial Initialization versus read-only polling. @param signal Abort deadline. @returns Complete settled data, never an early half-settled initial read. @throws Transport or host failures. */
  private async fetchData(initial: boolean, signal: AbortSignal): Promise<Pick<McpView, 'servers' | 'projects'>> {
    if (!initial) {
      const snapshot = await this.request('mcp.snapshot', {}, signal)
      if (!snapshot.ok) throw new Error(snapshot.error)
      return snapshot
    }
    const [list, groups] = await Promise.allSettled([this.request('mcp.list', {}, signal), this.request('mcp.projects', {}, signal)])
    if (list.status === 'rejected') throw list.reason
    if (groups.status === 'rejected') throw groups.reason
    if (!list.value.ok) throw new Error(list.value.error)
    if (!groups.value.ok) throw new Error(groups.value.error)
    return { servers: list.value.servers, projects: groups.value.projects }
  }

  /** @private @author ddj 2026年10月08号 @param initial Use legacy initialization RPCs once; later polls are read-only snapshots. @returns Completion after transport settles; aborted results never publish. */
  private async read(initial: boolean): Promise<void> {
    if (this.disposed || this.reading || this.view.busy) return
    if (!initial && (!this.active || !this.visible)) return
    const token = this.beginRead()
    try {
      const signal = token.controller.signal
      const { servers, projects } = await this.fetchData(initial, signal)
      if (!this.disposed && token.version === this.version && !signal.aborted) {
        this.view.servers = servers
        this.view.projects = projects
        this.view.error = ''
      }
    } catch (error) {
      if (!this.disposed && token.version === this.version && !token.controller.signal.aborted) this.view.error = String(error)
    } finally {
      clearTimeout(token.timer)
      this.reading = null
      if (!this.disposed) {
        this.view.loading = false
        this.emit()
        this.schedule()
      }
    }
  }

  /** @public @author ddj 2026年10月08号 @description Initialize list/projects once per mounted page. @returns Load completion. */
  load(): Promise<void> { return this.read(true) }

  /** @public @author ddj 2026年10月08号 @param active Whether the top-level MCP tab is selected. */
  setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    if (!active) this.invalidate()
    this.schedule()
  }

  /** @public @author ddj 2026年10月08号 @param visible Whether document visibility permits background requests. */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    if (!visible) this.invalidate()
    this.schedule()
  }

  /** @public @author ddj 2026年10月08号 @description Stop timers and invalidate all responses on unmount. */
  dispose(): void {
    this.disposed = true
    this.invalidate()
    if (this.reading) clearTimeout(this.reading.timer)
  }
  //endregion

  //region Serialized mutations
  /**
   * @public
   * @author ddj 2026年10月08号
   * @description Acquire a synchronous page-wide lock before validation/RPC. Duplicate actions are rejected; failed saves never call commit.
   * @param label Busy indicator key.
   * @param task Validation and RPC work, including synchronous configuration errors.
   * @param commit Apply successful result; may reset and close a save form.
   * @returns Whether this mutation committed successfully while mounted.
   */
  async mutate<T extends Result>(label: string, task: () => Promise<T>, commit: (result: T) => void): Promise<boolean> {
    if (this.disposed || this.view.busy) return false
    this.invalidate()
    this.view.busy = label
    this.view.error = ''
    this.emit()
    try {
      const result = await task()
      if (!result.ok) throw new Error(result.error)
      if (this.disposed) return false
      commit(result)
      return true
    } catch (error) {
      if (!this.disposed) this.view.error = String(error)
      return false
    } finally {
      if (!this.disposed) {
        this.view.busy = ''
        this.emit()
        this.schedule()
      }
    }
  }
  //endregion
}
