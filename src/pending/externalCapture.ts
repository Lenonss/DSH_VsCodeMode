/**
 * 差异追踪窗口的跟随器：只跟随“AI 文件工具动过、用户还没处理完”的文件。
 *
 * 设计取舍：
 * - 不再为任何新路径建档。`handleOne` 先看该路径有没有开着的窗口：没有就直接丢弃事件，
 *   Unity 重写 `index.json`、生成 `.meta`、脚本写盘都不会再冒出一条差异。
 * - 窗口内的改动只折当前内容（基线不动）：watch 事件走 300ms 静默 / 2000ms 封顶合并，
 *   启动、每 10 分钟和手动按钮各跑一次校准，把窗口内漏掉的事件从磁盘补齐。
 * - 读盘一律走待审采集的严格 UTF-8 往返：二进制、GBK 等无法字节往返的内容只记缺口，
 *   绝不因为“分析”而改写任何字节。
 * - 递归监听不可用（Linux）时降级为逐子目录非递归监听；仍不可用就只靠校准。
 * 作者 ddj 2026年11月25号
 */
import { readdirSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Ctx } from '../store.js'
import { log } from '../log.js'
import type { PendingWrite } from './capture.js'
import { noteCaptureGap, readText } from './capture.js'
import type { StoredEntry } from './persist.js'
import { loadEntries } from './persist.js'
import { FILE_EXCLUDES, EXCLUDES } from '../search/ripgrep.js'
import { pathKeyOf, windows } from './provenance.js'
import { isOpenEntry } from './tracking.js'
import { invalidateIndex } from '../treeIndex.js'

// --region 预算与忽略清单

/** 事件静默合并窗口。 */
export const DEBOUNCE_MS = 300
/** 保存风暴的封顶：从首个事件算起最多等这么久就开跑。 */
export const MAX_WAIT_MS = 2000
/** 单轮最多处理的文件数。 */
export const MAX_BATCH = 64
/** 单轮读取总字节上限。 */
export const MAX_FLUSH_BYTES = 8 << 20
/** 单文件读取上限（与待审采集一致）。 */
export const MAX_FILE_BYTES = 1024 * 1024
/** 递归监听不可用时，最多逐目录监听多少个一级子目录。 */
export const WATCH_DIR_MAX = 64
/** 定时校准间隔：窗口内漏掉的事件靠它从磁盘补齐。 */
export const SYNC_INTERVAL_MS = 10 * 60_000
/** 单次校准最多扫描多少个开窗文件。 */
export const SYNC_MAX = 64
/** 每个工作区最多记住多少条「已上报过的缺口」，防止事件风暴把去重表撑大。 */
export const GAP_KEY_MAX = 500

/**
 * 额外忽略的目录名（在搜索排除项之外，按原样大小写敏感匹配，口径与 EXCLUDES 一致）。
 * 只收版本库元数据、Unity 缓存与构建产物；其余目录跟随事件进入判定，未开窗的路径会被直接丢弃。
 */
export const EXTRA_IGNORE_SEGMENTS = ['.svn', '.hg', '.p4config', 'Library', 'Temp', 'obj', 'Logs']

/** 忽略集合：目录段 + 文件名模式。 */
const IGNORE_SEGMENTS = new Set<string>([...EXCLUDES, ...EXTRA_IGNORE_SEGMENTS])

/** 忽略文件名（glob 只有这几条，直接判后缀/全名，不引第三方匹配器）。 */
const IGNORE_FILES = new Set(FILE_EXCLUDES.map((pattern) => pattern.replace(/^\*\*\//, '')))

/**
 * @public
 * @author ddj 2026-11-24
 * @description: 判断绝对路径是否不进记录：工作区外、忽略目录段、插件自身 sidecar、构建产物、`.map`、
 * 以及计划页打包临时目录 `plans/<slug>/runtime/`。
 * @param cwd 工作区根
 * @param absolute 绝对路径
 * @returns 忽略返回 true
 */
export function isIgnoredPath(cwd: string, absolute: string): boolean {
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const unified = absolute.replace(/\\/g, '/')
  if (root && !(unified === root || unified.toLowerCase().startsWith(root.toLowerCase() + '/'))) return true
  const relative = root && unified.length > root.length ? unified.slice(root.length + 1) : unified
  const segments = relative.split('/').filter(Boolean)
  if (!segments.length) return true
  // 目录段命中即忽略；最后一段是文件名，单独按文件名规则判。
  for (const segment of segments.slice(0, -1)) {
    if (IGNORE_SEGMENTS.has(segment)) return true
  }
  const name = segments[segments.length - 1]!
  if (IGNORE_SEGMENTS.has(name)) return true
  if (IGNORE_FILES.has(name)) return true
  if (name.endsWith('.map')) return true
  // 计划页被打包后只剩 plan.packed.html，但打包期间的 runtime/ 是构建临时产物
  for (let index = 0; index + 2 < segments.length; index++) {
    if (segments[index] === 'plans' && segments[index + 2] === 'runtime') return true
  }
  return false
}

// --endregion

// --region 类型

/** 跟随器的两个开关。 */
export interface ExternalSettings {
  /** 实时跟随开窗文件（watch）。 */
  watch: boolean
  /** 启动与每 10 分钟从磁盘校准开窗文件。 */
  scan: boolean
}

/** 一次校准的结果。 */
export interface SyncOutcome {
  /** 检查了多少个开窗文件。 */
  checked: number
  /** 折进了多少次改动。 */
  folded: number
  /** 读盘失败等缺口说明。 */
  gaps: string[]
}

/** 跟随器依赖：Host 能力 + 可注入的测试接缝。 */
export interface ExternalCaptureDeps {
  ctx: Ctx
  settings(): ExternalSettings
  /** 折进窗口：与工具链路共用同一个待审库入口，返回是否真的折了。 */
  fold(write: PendingWrite): boolean
  /** 覆盖读盘（测试注入）；缺省走 ctx.fs 的严格 UTF-8 往返。 */
  read?(cwd: string, absolute: string): Promise<string | null>
  /** 覆盖条目读取（测试注入）；缺省读待审库。 */
  entries?(cwd: string): StoredEntry[]
  now?(): number
}

/** 跟随器对外能力。 */
export interface ExternalCapture {
  /** 确保工作区已开始监听（幂等；同时安排一次启动校准）。 */
  ensure(cwd: string, sessionId: string): void
  /** 立即校准一次并返回结果。 */
  sync(cwd: string): Promise<SyncOutcome>
  /** 工作区不再需要监听（会话销毁）。 */
  dismiss(cwd: string): void
  /** 收到一个写事件（watcher 与测试共用）。 */
  enqueue(cwd: string, absolute: string): void
  /** 立即处理脏队列（测试与卸载共用）。 */
  flush(cwd?: string): Promise<void>
  /** 停监听、清定时器。 */
  dispose(): void
}

/** 单工作区运行时状态。 */
interface Workspace {
  cwd: string
  sessionId: string
  watchers: FSWatcher[]
  dirty: Map<string, { path: string; seq: number }>
  timer: ReturnType<typeof setTimeout> | null
  firstAt: number
  /** 串行链：watch 批次与校准不交叉读写同一批条目。 */
  chain: Promise<void>
  degraded: string
  /** 启动校准是否已排过。 */
  scheduled: boolean
  /** 定时校准器。 */
  syncTimer: ReturnType<typeof setInterval> | null
  /** 已上报过的缺口键（同路径/同原因只报一次）。 */
  gapKeys: Set<string>
}

// --endregion

// --region 跟随器

/**
 * @public
 * @author ddj 2026年11月25号
 * @description: 装配差异窗口跟随器：watch 进队、合并读盘、只折已开窗路径；可整体卸载。
 * @param deps Host 能力与测试接缝
 * @returns 跟随器
 */
export function installExternalCapture(deps: ExternalCaptureDeps): ExternalCapture {
  const spaces = new Map<string, Workspace>()
  const now = deps.now ?? Date.now
  let seq = 0
  let stopped = false

  /**
   * @private
   * @description: 取（或建）工作区运行时状态。
   * @param cwd 工作区
   * @param sessionId 会话
   * @returns 状态
   */
  function spaceOf(cwd: string, sessionId: string): Workspace {
    const key = pathKeyOf(cwd)
    const existing = spaces.get(key)
    if (existing) return existing
    const created: Workspace = {
      cwd: String(cwd), sessionId, watchers: [], dirty: new Map(), timer: null, firstAt: 0,
      chain: Promise.resolve(), degraded: '', scheduled: false, syncTimer: null, gapKeys: new Set(),
    }
    spaces.set(key, created)
    return created
  }

  /**
   * @private
   * @description: 把任务串到本工作区的调用链上，失败只记日志、不打断后续任务。
   * @param space 工作区状态
   * @param task 任务
   * @returns 任务完成
   */
  function run(space: Workspace, task: () => Promise<void>): Promise<void> {
    const next = space.chain.then(task).catch((error) => { log.warn('差异窗口跟随失败：' + String(error)) })
    space.chain = next
    return next
  }

  /**
   * @private
   * @description: 事件分发：只收文件名，忽略目录与忽略清单。
   * @param space 工作区状态
   * @param base 被监听目录
   * @param name 事件文件名
   * @returns 无
   */
  function onEvent(space: Workspace, base: string, name: string | Buffer | null): void {
    if (stopped || !name) return
    enqueue(space.cwd, resolve(base, String(name)))
  }

  /**
   * @private
   * @description: 关闭一个工作区的全部监听器。
   * @param space 工作区状态
   * @returns 无
   */
  function closeWatchers(space: Workspace): void {
    for (const watcher of space.watchers) {
      try { watcher.close() } catch { /* 关闭失败不影响卸载 */ }
    }
    space.watchers = []
  }

  /**
   * @private
   * @description: 开始监听；递归可用就用递归，否则逐一级子目录监听，都不可用时只留校准。
   * @param space 工作区状态
   * @returns 无
   */
  function startWatch(space: Workspace): void {
    if (space.watchers.length || stopped) return
    try {
      const watcher = watch(space.cwd, { recursive: true, persistent: false }, (_event, name) => onEvent(space, space.cwd, name))
      // EventEmitter 的 'error' 无监听者时抛出未捕获异常，必须挂处理器
      watcher.on('error', (error) => { log.warn('差异窗口监听中断（改为只靠校准）：' + String(error)); closeWatchers(space) })
      space.watchers.push(watcher)
      return
    } catch (error) {
      log.debug('递归监听不可用，降级逐目录监听：' + String(error))
    }
    try {
      const entries = readdirSync(space.cwd, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !IGNORE_SEGMENTS.has(entry.name))
        .slice(0, WATCH_DIR_MAX)
      for (const entry of entries) {
        const dir = join(space.cwd, entry.name)
        const watcher = watch(dir, { persistent: false }, (_event, name) => onEvent(space, dir, name))
        watcher.on('error', (error) => log.debug('目录监听中断：' + dir + ' ' + String(error)))
        space.watchers.push(watcher)
      }
      if (!space.watchers.length) space.degraded = '目录监听不可用'
    } catch (error) {
      space.degraded = '目录监听不可用：' + String(error)
      log.warn('差异窗口监听不可用（改为只靠校准）：' + String(error))
    }
  }

  /**
   * @private
   * @description: 重新安排本批处理时刻：静默 300ms，但不超过首个事件后 2000ms。
   * @param space 工作区状态
   * @returns 无
   */
  function schedule(space: Workspace): void {
    const at = now()
    if (!space.firstAt) space.firstAt = at
    if (space.timer) clearTimeout(space.timer)
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, space.firstAt + MAX_WAIT_MS - at))
    space.timer = setTimeout(() => {
      space.timer = null
      void flushSpace(space)
    }, wait)
  }

  /**
   * @private
   * @description: 取条目集合：真实路径读待审库，测试可注入。
   * @param cwd 工作区
   * @returns 路径比较键 → 条目
   */
  function entriesOf(cwd: string): Map<string, StoredEntry> {
    const stored = deps.entries ? deps.entries(cwd) : loadEntries(cwd)
    const map = new Map<string, StoredEntry>()
    for (const entry of stored) map.set(pathKeyOf(entry.entry.id), entry)
    return map
  }

  /**
   * @private
   * @description: 读磁盘内容；缺失返回 null，其它失败抛出（由调用点记缺口）。
   * @param cwd 工作区
   * @param absolute 绝对路径
   * @returns 内容或 null
   */
  async function readOf(cwd: string, absolute: string): Promise<string | null> {
    if (deps.read) return deps.read(cwd, absolute)
    const fs = deps.ctx.get('fs')
    if (!fs) throw new Error('缺少 fs 服务')
    const target = await fs.resolve(absolute, { cwd })
    return readText(fs, target)
  }

  /**
   * @private
   * @author ddj 2026年11月25号
   * @description: 同一条缺口只上报一次；去重表满了就丢最早的键，保证内存有界。
   * @param space 工作区状态
   * @param absolute 出问题的路径
   * @param message 原因
   * @returns 无
   */
  function noteGapOnce(space: Workspace, absolute: string, message: string): void {
    const key = absolute + '\u0000' + message
    if (space.gapKeys.has(key)) return
    if (space.gapKeys.size >= GAP_KEY_MAX) {
      const oldest = space.gapKeys.values().next().value
      if (oldest !== undefined) space.gapKeys.delete(oldest)
    }
    space.gapKeys.add(key)
    noteCaptureGap(space.cwd, space.sessionId, absolute, message)
  }

  /**
   * @private
   * @author ddj 2026年11月25号
   * @description: 把一个已开窗条目与磁盘对齐：内容变了就折进窗口，没变不落库。
   * @param space 工作区状态
   * @param stored 已开窗条目
   * @returns 是否折了改动
   * @throws 读盘失败
   */
  async function foldStored(space: Workspace, stored: StoredEntry): Promise<boolean> {
    if (stopped || !isOpenEntry(stored.entry)) return false
    const key = pathKeyOf(stored.entry.id)
    // 插件自己的写回（撤销/重做）：内容随后会出现在条目里，这里不折
    if (windows.windowOf(key, now()) === 'self') return false
    const content = await readOf(space.cwd, stored.entry.id)
    const sameMissing = stored.flags.missing === (content === null)
    if (sameMissing && content === stored.entry.newText) return false
    const origin = windows.windowOf(key, now()) === 'editor' ? 'editor' : 'external'
    return deps.fold({
      cwd: space.cwd,
      sessionId: space.sessionId,
      path: stored.entry.path,
      identity: stored.entry.id,
      before: stored.entry.newText,
      after: content,
      now: now(),
      tool: 'watch',
      origin,
      baseKind: 'known',
    })
  }

  /**
   * @private
   * @description: 处理本工作区的一个批次：取一批 → 读盘判定 → 落库 → 失效目录树。
   * @param space 工作区状态
   * @returns 无
   */
  function flushSpace(space: Workspace): Promise<void> {
    return run(space, async () => {
      if (stopped) return
      space.firstAt = 0
      let bytes = 0
      let recorded = 0
      try {
        const entries = entriesOf(space.cwd)
        const batch = [...space.dirty.entries()].slice(0, MAX_BATCH)
        for (const [key] of batch) space.dirty.delete(key)
        const ordered = batch.sort((left, right) => left[1].seq - right[1].seq)
        const touched: string[] = []
        for (const [, item] of ordered) {
          if (stopped) break
          const stored = entries.get(pathKeyOf(item.path))
          // 没开窗的路径直接丢：Unity、脚本、索引器改的文件都不再产生记录
          if (!stored) continue
          try {
            const size = item.path.length
            if (bytes + size > MAX_FLUSH_BYTES) { space.dirty.set(pathKeyOf(item.path), item); continue }
            bytes += size
            if (await foldStored(space, stored)) { recorded += 1; touched.push(item.path) }
          } catch (error) {
            noteGapOnce(space, item.path, String(error))
            log.debug('差异窗口跳过：' + item.path + ': ' + String(error))
          }
        }
        for (const path of touched) invalidateIndex(deps.ctx, space.cwd, path)
        if (recorded) log.debug(`差异窗口折入 ${recorded} 条（${space.cwd}）`)
      } finally {
        if (space.dirty.size) schedule(space)
      }
    })
  }

  /**
   * @private
   * @author ddj 2026年11月25号
   * @description: 从磁盘校准所有开窗文件：补启动前/离线期间漏掉的事件。
   * @param space 工作区状态
   * @returns 校准结果
   */
  async function syncWorkspace(space: Workspace): Promise<SyncOutcome> {
    const outcome: SyncOutcome = { checked: 0, folded: 0, gaps: [] }
    await run(space, async () => {
      if (stopped) return
      const entries = entriesOf(space.cwd)
      const open = [...entries.values()].filter((stored) => isOpenEntry(stored.entry)).slice(0, SYNC_MAX)
      let bytes = 0
      for (const stored of open) {
        if (stopped) break
        outcome.checked += 1
        const size = stored.entry.newText.length
        if (bytes + size > MAX_FLUSH_BYTES) break
        bytes += size
        try {
          if (await foldStored(space, stored)) outcome.folded += 1
        } catch (error) {
          const message = stored.entry.path + ': ' + String(error)
          outcome.gaps.push(message)
          noteGapOnce(space, stored.entry.path, String(error))
        }
      }
    })
    return outcome
  }

  /**
   * @private
   * @description: 收一个写事件进队并重新排期；忽略清单命中直接丢。
   * @param cwd 工作区
   * @param absolute 绝对路径
   * @returns 无
   */
  function enqueue(cwd: string, absolute: string): void {
    if (stopped || !absolute || !cwd || !deps.settings().watch) return
    if (isIgnoredPath(cwd, absolute)) return
    const space = spaces.get(pathKeyOf(cwd)) ?? spaceOf(cwd, '')
    seq += 1
    space.dirty.set(pathKeyOf(absolute), { path: absolute, seq })
    schedule(space)
  }

  return {
    ensure(cwd: string, sessionId: string): void {
      if (stopped || !cwd) return
      const space = spaceOf(cwd, sessionId)
      if (deps.settings().watch) startWatch(space)
      if (!deps.settings().scan || space.scheduled) return
      space.scheduled = true
      // 启动校准：重启后把窗口内离线期间的改动补齐
      const timer = setTimeout(() => { void syncWorkspace(space) }, 0)
      if (typeof timer.unref === 'function') timer.unref()
      if (!space.syncTimer) {
        space.syncTimer = setInterval(() => { void syncWorkspace(space) }, SYNC_INTERVAL_MS)
        if (typeof space.syncTimer.unref === 'function') space.syncTimer.unref()
      }
    },
    sync(cwd: string): Promise<SyncOutcome> {
      if (stopped || !cwd) return Promise.resolve({ checked: 0, folded: 0, gaps: [] })
      return syncWorkspace(spaceOf(cwd, ''))
    },
    dismiss(cwd: string): void {
      const key = pathKeyOf(cwd)
      const space = spaces.get(key)
      if (!space) return
      closeWatchers(space)
      if (space.timer) clearTimeout(space.timer)
      if (space.syncTimer) clearInterval(space.syncTimer)
      spaces.delete(key)
    },
    enqueue(cwd: string, absolute: string): void {
      enqueue(cwd, absolute)
    },
    async flush(cwd?: string): Promise<void> {
      for (const [key, space] of spaces) {
        if (cwd && key !== pathKeyOf(cwd)) continue
        if (space.timer) { clearTimeout(space.timer); space.timer = null }
        await flushSpace(space)
        await space.chain
      }
    },
    dispose(): void {
      stopped = true
      for (const space of spaces.values()) {
        closeWatchers(space)
        if (space.timer) clearTimeout(space.timer)
        if (space.syncTimer) clearInterval(space.syncTimer)
        space.dirty.clear()
        space.gapKeys.clear()
      }
      spaces.clear()
    },
  }
}

// --endregion

// --region 装配入口

/** 当前装配的跟随器实例：RPC 的「校准一次」经它执行，避免再实现一套读盘逻辑。 */
let activeCapture: ExternalCapture | undefined

/**
 * @author ddj 2026年11月25号
 * @description: 登记当前跟随器；卸载时传 undefined，避免 RPC 打到旧实例。
 * @param instance 跟随器实例
 * @returns 无
 */
export function setCapture(instance: ExternalCapture | undefined): void {
  activeCapture = instance
}

/**
 * @author ddj 2026年11月25号
 * @description: 从 RPC 侧触发一次校准：只对齐开窗文件，不建任何新记录。
 * @param cwd 工作区
 * @returns 校准结果
 */
export async function captureSync(cwd: string): Promise<SyncOutcome> {
  if (!activeCapture) return { checked: 0, folded: 0, gaps: ['差异窗口跟随器未装配'] }
  return activeCapture.sync(cwd)
}

// --endregion
