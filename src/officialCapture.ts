/** Deferred official-event collection; no private snapshot access. @author ddj 2026年10月26号 */
import { captureState, repairPaths, saveSnapshot } from './reviewDb.js'
import type { OfficialDiff, OfficialSummary, ReviewSnapshot } from './shared/review.js'
import type { Ctx } from './store.js'
import { loadBucket } from './store.js'
import { log } from './log.js'

interface SourceEvent { type: string; seq: number; data: { turn?: number } }
interface SourceSession { id: string; inheritedEventCount?: number; header?: { cwd?: string } }
interface SourceService {
  summary(sessionId: string, seq: number): OfficialSummary | undefined
  diff(sessionId: string, seq: number, index: number, signal: AbortSignal): Promise<OfficialDiff | undefined>
}
interface CaptureTask { sessionId: string; turn: number; seq: number; cwd?: string }
export interface CaptureDeps {
  source: () => SourceService | undefined
  prepare(cwd: string): Promise<void>
  identity(cwd: string, path: string): Promise<string>
  persist: typeof saveSnapshot
  state: typeof captureState
  report(message: string): void
  timeoutMs?: number
  retryMs?: number
}

/** @public @author ddj 2026年10月26号 @param deps Official source and workspace adapters. @returns Bounded collector with cancellation and deferred event reads. */
export function createCollector(deps: CaptureDeps) {
  const waiting: CaptureTask[] = []
  const pending = new Set<string>()
  const controller = new AbortController()
  let active = 0
  let stopped = false
  const running = new Set<string>()
  const tasks = new Set<Promise<void>>()

  /** @private @author ddj 2026年10月26号 @param ms Delay; aborted on unload. @returns Deferred completion, not synchronous observer work. */
  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      /** @private @author ddj 2026年10月26号 Release both timer and listener. */
      function finish(): void { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve() }
      const timer = setTimeout(finish, ms)
      controller.signal.addEventListener('abort', finish, { once: true })
      if (stopped) finish()
    })
  }

  /** @private @author ddj 2026年10月26号 @param task Source identity. @returns Complete payload staged before one database transaction. */
  async function collect(task: CaptureTask): Promise<void> {
    await pause(0) // Official append publishes before summary registration.
    if (stopped) return
    // The session header may predate cd. Bind the durable inbox only after
    // reading the official event cwd; header cwd is a gap-report fallback.
    const source = deps.source()
    if (!source) throw new Error('官方 workspaceChanges 服务不可用')
    let summary: OfficialSummary | undefined
    for (let attempt = 0; attempt < 4 && !stopped; attempt++) {
      summary = source.summary(task.sessionId, task.seq)
      if (summary) break
      await pause(deps.retryMs ?? 100)
    }
    if (!summary || stopped) throw new Error('官方事件已公告，但 summary 已失效或尚不可用')
    // Detach all source aliases before asynchronous work; never resolve against current session cwd.
    summary = structuredClone(summary)
    if (summary.turn !== task.turn) throw new Error('官方 summary 轮次与事件不一致')
    task.cwd = summary.cwd
    await deps.prepare(summary.cwd)
    if (stopped) return
    deps.state(summary.cwd, { ...task, error: '' }, 'queued')
    try {
      const files = []
      for (const [index, file] of summary.files.entries()) {
        if (stopped) return
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(deps.timeoutMs ?? 10000)])
        const diff = await readDiff(source, task, index, signal)
        if (!diff || diff.path !== file.path || diff.display !== file.display) throw new Error('官方文件差异缺失或身份不一致')
        const identity = await deps.identity(summary.cwd, file.path)
        files.push({ identity, diff: structuredClone(diff) })
      }
      if (!stopped) deps.persist(summary.cwd, { ...task, sourceKind: 'official', capturedAt: new Date().toISOString(), summary, files })
    } catch (error) {
      if (!stopped) deps.state(summary.cwd, { ...task, error: String(error) }, 'gap')
      throw error
    }
  }

  /** @private @author ddj 2026年10月26号 Starts at most two independent event reads, with each event's file reads serial. */
  function drain(): void {
    while (!stopped && active < 2 && waiting.length) {
      const index = waiting.findIndex((task) => !running.has(JSON.stringify([task.sessionId, task.turn])))
      if (index < 0) break
      const task = waiting.splice(index, 1)[0]
      const key = JSON.stringify([task.sessionId, task.turn, task.seq])
      const turnKey = JSON.stringify([task.sessionId, task.turn])
      active++; running.add(turnKey)
      const work = collect(task).catch(async (error) => {
        deps.report(`官方差异采集 ${key}: ${String(error)}`)
        if (!stopped && task.cwd) {
          try { await deps.prepare(task.cwd); if (!stopped) deps.state(task.cwd, { ...task, error: String(error) }, 'gap') }
          catch (failure) { deps.report(`官方缺口落盘失败: ${String(failure)}`) }
        }
      }).finally(() => {
        active--; pending.delete(key); running.delete(turnKey); tasks.delete(work); drain()
      })
      tasks.add(work)
    }
  }

  /** @public @author ddj 2026年10月26号 @param session Source session. @param event Published event; inherited fork events are excluded. */
  function enqueue(session: SourceSession, event: SourceEvent): void {
    if (stopped || event.type !== 'workspace/changes' || !Number.isSafeInteger(event.data?.turn)
      || !Number.isSafeInteger(event.seq) || event.seq < (session.inheritedEventCount ?? 0)) return
    const task = { sessionId: session.id, turn: event.data.turn!, seq: event.seq, cwd: session.header?.cwd }
    const key = JSON.stringify([task.sessionId, task.turn, task.seq])
    if (pending.has(key)) return
    pending.add(key); waiting.push(task); drain()
  }

  /** @public @author ddj 2026年10月26号 @returns Bounded durability checkpoint including work queued while active tasks finish. */
  async function flush(): Promise<void> {
    const deadline = Date.now() + (deps.timeoutMs ?? 10000)
    while (tasks.size && !stopped && Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([Promise.all([...tasks]), new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(1, deadline - Date.now())) })])
      clearTimeout(timer)
    }
  }

  /** @public @author ddj 2026年10月26号 @returns Bounded drain, then cancel timers and reads; incomplete staging cannot publish. */
  async function dispose(): Promise<void> {
    await flush()
    stopped = true; controller.abort(); waiting.length = 0; pending.clear()
    // Never await an uncooperative external adapter after the deadline.
    // Every publish path checks stopped; late completion cannot reopen the database.
  }
  return { enqueue, flush, dispose }
}

/** @private @author ddj 2026年10月26号 @param source Public service. @param task Event. @param index File position. @param signal Cancellation/deadline. @returns A read bounded even if an adapter ignores abort. */
async function readDiff(source: SourceService, task: CaptureTask, index: number, signal: AbortSignal): Promise<OfficialDiff | undefined> {
  return new Promise((resolve, reject) => {
    /** @private @author ddj 2026年10月26号 Propagate timeout or unload. */
    function aborted(): void { reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) { aborted(); return }
    Promise.resolve().then(() => source.diff(task.sessionId, task.seq, index, signal))
      .then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

/** @public @author ddj 2026年10月26号 @param ctx Host lifecycle owner; services remain optional for older Hosts. */
export function installCapture(ctx: Ctx, onSnapshot?: (cwd: string, snapshot: ReviewSnapshot) => void): () => Promise<void> {
  const collector = createCollector({
    source: () => ctx.get('workspaceChanges'),
    prepare: async (cwd) => { await loadBucket(ctx, cwd); await repairPaths(cwd, resolvePath) },
    identity: resolvePath,
    persist: (cwd, snapshot) => {
      const saved = saveSnapshot(cwd, snapshot)
      onSnapshot?.(cwd, snapshot)
      return saved
    }, state: captureState, report: (message) => log.warn(message),
  })
  // Subscribe first: seed reads must not create a live-event race window.
  ctx.on('session/event', collector.enqueue)
  ctx.on('session/created', backfill)
  ctx.on('session/flush', collector.flush)
  for (const session of ctx.get('sessions').list()) void backfill(session)
  return collector.dispose

  /** @private @author ddj 2026年10月27号 @param cwd Source workspace. @param path Official relative path. @returns Backend-owned process path; never stringify opaque targets. @throws Invalid backend path. */
  async function resolvePath(cwd: string, path: string): Promise<string> {
    const fs = ctx.get('fs')
    const target = await fs.resolve(path, { cwd })
    const processPath = fs.processPath(target)
    if (typeof processPath !== 'string' || !processPath || processPath === '[object Object]') {
      throw new Error('官方文件路径解析失败')
    }
    return processPath
  }

  /** @private @author ddj 2026年10月26号 @param session Live session. Only public async reads, excluding inherited records. */
  async function backfill(session: SourceSession): Promise<void> {
    const query = ctx.get('sessionQuery')
    if (!query?.listEvents || !query?.readEvent) {
      log.warn('官方历史补采不可用：缺少 sessionQuery；后续实时事件仍会采集')
      return
    }
    try {
      // Repair durable history independently: official summaries do not survive Host restart.
      // Each saved snapshot resolves against its own cwd, not the current session directory.
      if (session.header?.cwd) {
        await loadBucket(ctx, session.header.cwd)
        await repairPaths(session.header.cwd, resolvePath)
      }
      // Semantic search omits structural events; only the raw metadata list contains workspace/changes.
      const events = await query.listEvents(session.id)
      for (const event of events) {
        if (event.type !== 'workspace/changes' || event.seq < (session.inheritedEventCount ?? 0)) continue
        const window = await query.readEvent({ sessionId: session.id, seq: event.seq })
        collector.enqueue(session, window.target)
      }
    } catch (error) { log.warn('官方历史补采失败：' + String(error)) }
  }
}
