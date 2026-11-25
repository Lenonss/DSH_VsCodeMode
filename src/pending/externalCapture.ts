/**
 * 外部改动实时采集：非 DSH 文件工具（`ops_bash` 里 `node -e`、prettier、生成器、python/sed 等）
 * 改过的文件，用被监听目录的写事件补进待审投影。
 *
 * 设计取舍：
 * - 只监听工作区根（递归），事件先入队，300ms 静默或 2000ms 封顶后统一读盘；单轮最多处理
 *   MAX_BATCH 个文件、MAX_FLUSH_BYTES 字节，其余留到下一轮。批量按**入队顺序**处理，不按 mtime：
 *   同一毫秒内的多次写入 mtime 相同，用它排序反而可能造出倒序 diff。
 * - 判定顺序固定：已知内容未变 → 跳过；插件自写窗口 → 跳过；编辑器保存窗口 → 只推进基线；
 *   版本库说干净 → 跳过或标成版本库同步；拿不到版本库状态且是首次见到的路径 → 必须自带 mtime 证据
 *   （文件确实在监听开始之后被写过），否则只记缺口不建档；整文件新增短时间成批出现 → 熔断静默一段时间。
 *   写记录前按身份重读一次条目：本批快照可能早于工具落库，不重读就会把工具写入再记成版本库同步。
 *   其余按窗口判定归属后落库。绝不按时间戳猜重复，也绝不把「被读过」当成「被改过」。
 * - 递归监听不可用（Linux）时降级为逐子目录非递归监听；仍不可用就只靠补扫，并把原因写进缺口。
 * - 读盘一律走待审采集的严格 UTF-8 往返：二进制、GBK 等无法字节往返的内容不落记录（记缺口），
 *   绝不因为"分析"而改写任何字节。
 * 作者 ddj 2026-11-24
 */
import { readdirSync, statSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Ctx } from '../store.js'
import { log } from '../log.js'
import type { PendingWrite } from './capture.js'
import { noteCaptureGap, readText } from './capture.js'
import type { StoredEntry } from './persist.js'
import { loadEntries, loadEntry } from './persist.js'
import { FILE_EXCLUDES, EXCLUDES } from '../search/ripgrep.js'
import { pathKeyOf, windows } from './provenance.js'
import type { VcsStatus } from './vcs.js'
import { vcsBaselineOf, vcsStatus } from './vcs.js'
import { vcsScopeOf } from './externalAlign.js'
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
/** 版本库状态命令的最小间隔：补扫与 watch 合并取用，避免频繁起进程。 */
export const VCS_STATUS_MIN_INTERVAL_MS = 5000
/** 递归监听不可用时，最多逐目录监听多少个一级子目录。 */
export const WATCH_DIR_MAX = 64
/** 内存基线表上限（路径比较键数）。 */
export const SEEN_MAX = 5000
/** 定时补扫间隔。 */
export const ALIGN_INTERVAL_MS = 10 * 60_000
/** 版本库写命令之后推迟多久补扫：等命令输出落盘、索引失效完成。 */
export const ALIGN_AFTER_VCS_MS = 1500
/** 每个工作区最多记住多少条「已上报过的缺口」，防止事件风暴把去重表撑大。 */
export const GAP_KEY_MAX = 500
/** 「版本库状态不可用」这条诊断的最短间隔：同一工作区 5 分钟只报一次。 */
export const STATUS_NOTE_MIN_MS = 5 * 60_000
/** mtime 证据的时钟容差：监听开始前这段时间内写过的文件也算「刚被写过」。 */
export const WATCH_SKEW_MS = 2000
/** 熔断窗口：统计「整文件新增」记录的时间窗。 */
export const BURST_WINDOW_MS = 5 * 60_000
/** 窗口内最多允许的整文件新增条数：超过即判定为批量噪声。 */
export const BURST_NEW_LIMIT = 200
/** 熔断后的静默期：这段时间只更新已有条目，不新建。 */
export const BURST_COOLDOWN_MS = 10 * 60_000

/** 会改动工作副本的版本库 RPC：只有这些方法之后才值得补扫。 */
export const VCS_WRITE_METHODS = new Set([
  'svn.revert', 'svn.resolve', 'svn.add', 'svn.cleanup', 'svn.update', 'svn.ignore', 'svn.commit',
])

/** 会改动工作副本的版本库工具名。 */
export const VCS_WRITE_TOOLS = new Set([
  'svn_add', 'svn_delete', 'svn_revert', 'svn_commit', 'svn_update', 'svn_resolve', 'svn_cleanup',
  'svn_propset', 'svn_propdel', 'svn_changelist', 'remote_ssh_write',
])

/**
 * 额外忽略的目录名（在搜索排除项之外，按原样大小写敏感匹配，口径与 EXCLUDES 一致）。
 * 只收版本库元数据、Unity 缓存与构建产物：第三方与代码生成目录不在忽略之列，
 * 它们的改动靠「mtime 证据 + 版本库状态」两道闸门拦，而不是按目录名一刀切。
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

/** 外部采集的两个开关。 */
export interface ExternalSettings {
  watch: boolean
  scan: boolean
}

/** 采集依赖：Host 能力 + 可注入的测试接缝。 */
export interface ExternalCaptureDeps {
  ctx: Ctx
  settings(): ExternalSettings
  /** 落库：与 installPending 复用同一个 sink。 */
  record(write: PendingWrite): void
  /** 覆盖读盘（测试注入）；缺省走 ctx.fs 的严格 UTF-8 往返。 */
  read?(cwd: string, absolute: string): Promise<string | null>
  /** 覆盖条目读取（测试注入）；缺省读待审库。 */
  entries?(cwd: string): Map<string, StoredEntry>
  /** 覆盖版本库状态（测试注入）；缺省跑一条 status 命令。 */
  status?(cwd: string, sessionId: string): Promise<VcsStatus | null>
  /** 覆盖补扫执行（测试注入）；缺省调用 alignInWorkspace。 */
  align?(cwd: string, sessionId: string): Promise<void>
  /** 覆盖 mtime 读取（测试注入）；缺省 statSync。拿不到返回 undefined。 */
  mtime?(cwd: string, absolute: string): number | undefined
  /** 覆盖单条最新条目读取（测试注入）；缺省按身份查一条。 */
  latest?(cwd: string, absolute: string): StoredEntry | undefined
  now?(): number
}

/** 采集器对外能力。 */
export interface ExternalCapture {
  /** 确保工作区已开始监听（幂等；同时触发一次后台补扫）。 */
  ensure(cwd: string, sessionId: string): void
  /** 申请一次延迟补扫（版本库命令之后、手动按钮都用它；同一工作区会合并）。 */
  requestAlign(cwd: string, delayMs?: number): void
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
  seen: Map<string, string | null>
  timer: ReturnType<typeof setTimeout> | null
  firstAt: number
  flushing: boolean
  again: boolean
  degraded: string
  statusAt: number
  status?: VcsStatus | null
  alignedAt: number
  alignTimer: ReturnType<typeof setTimeout> | null
  /** 延后补扫的定时器（版本库命令后/手动按钮，同一工作区合并一次）。 */
  requestTimer: ReturnType<typeof setTimeout> | null
  /** 本次监听的起始时刻：文件 mtime 不比它新，就不是「刚被写过」。 */
  startedAt: number
  /** 已上报过的缺口键（同路径/同原因只报一次）。 */
  gapKeys: Set<string>
  /** 上次把「版本库状态不可用」写进缺口的时刻。 */
  statusNoteAt: number
  /** 熔断窗口起点与窗口内已建的整文件新增条数。 */
  burstAt: number
  burstCount: number
  /** 熔断静默截止时刻：在此之前不新建整文件新增记录。 */
  burstMutedUntil: number
}

// --endregion

// --region 采集器

/**
 * @public
 * @author ddj 2026-11-24
 * @description: 装配外部改动采集：watch 进队、合并读盘、按判定链落库；可整体卸载。
 * @param deps Host 能力与测试接缝
 * @returns 采集器
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
      cwd: String(cwd), sessionId, watchers: [], dirty: new Map(), seen: new Map(),
      timer: null, firstAt: 0, flushing: false, again: false, degraded: '',
      statusAt: 0, status: undefined, alignedAt: 0, alignTimer: null, requestTimer: null,
      startedAt: 0, gapKeys: new Set(), statusNoteAt: 0,
      burstAt: 0, burstCount: 0, burstMutedUntil: 0,
    }
    spaces.set(key, created)
    return created
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
   * @description: 开始监听；递归可用就用递归，否则逐一级子目录监听，都不可用时只留补扫。
   * @param space 工作区状态
   * @returns 无
   */
  function startWatch(space: Workspace): void {
    if (space.watchers.length || stopped) return
    space.startedAt = now()
    try {
      const watcher = watch(space.cwd, { recursive: true, persistent: false }, (_event, name) => onEvent(space, space.cwd, name))
      // EventEmitter 的 'error' 无监听者时抛出未捕获异常，必须挂处理器
      watcher.on('error', (error) => { log.warn('外部改动监听中断（改为只靠补扫）：' + String(error)); closeWatchers(space) })
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
      log.warn('外部改动监听不可用（改为只靠补扫）：' + String(error))
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
    if (deps.entries) return deps.entries(cwd)
    const map = new Map<string, StoredEntry>()
    for (const stored of loadEntries(cwd)) map.set(pathKeyOf(stored.entry.id), stored)
    return map
  }

  /**
   * @private
   * @author ddj 2026年11月25号
   * @description: 取某路径的最新条目：批次快照可能早于工具落库，写记录前按身份重读一条。
   * @param space 工作区状态
   * @param absolute 绝对路径
   * @param fallback 批次内的旧条目
   * @returns 最新条目（读不到时回落到旧条目）
   */
  function latestOf(space: Workspace, absolute: string, fallback: StoredEntry | undefined): StoredEntry | undefined {
    try {
      if (deps.latest) return deps.latest(space.cwd, absolute) ?? fallback
      return loadEntry(space.cwd, absolute) ?? fallback
    } catch {
      return fallback
    }
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
   * @description: 取版本库状态（带最小间隔缓存）；无 shell 或非 git/svn 时返回 null。
   * @param space 工作区状态
   * @returns 状态或 null
   */
  async function statusOf(space: Workspace): Promise<VcsStatus | null> {
    const at = now()
    if (space.status !== undefined && at - space.statusAt < VCS_STATUS_MIN_INTERVAL_MS) return space.status
    space.statusAt = at
    if (deps.status) {
      space.status = await deps.status(space.cwd, space.sessionId)
      return space.status
    }
    const scope = vcsScopeOf(deps.ctx, space.cwd, space.sessionId)
    if (!scope) {
      noteStatusOnce(space, '没有 shell 能力，版本库状态不可用')
      space.status = null
      return space.status
    }
    space.status = await vcsStatus(scope.shell, space.cwd, (reason) => noteStatusOnce(space, reason))
    return space.status
  }

  /**
   * @private
   * @author ddj 2026-11-24
   * @description: 读文件修改时间（测试可注入）；读不到返回 undefined。
   * @param space 工作区状态
   * @param absolute 绝对路径
   * @returns 毫秒时间戳或 undefined
   */
  function mtimeOf(space: Workspace, absolute: string): number | undefined {
    if (deps.mtime) return deps.mtime(space.cwd, absolute)
    try { return statSync(absolute).mtimeMs } catch { return undefined }
  }

  /**
   * @private
   * @author ddj 2026-11-24
   * @description: 判断文件是否在本次监听开始之后被写过：这是「拿不到版本库状态」时唯一的外部证据。
   * @param space 工作区状态
   * @param absolute 绝对路径
   * @returns 刚被写过返回 true
   */
  function recentlyWritten(space: Workspace, absolute: string): boolean {
    if (!space.startedAt) return false
    const mtime = mtimeOf(space, absolute)
    return mtime !== undefined && mtime >= space.startedAt - WATCH_SKEW_MS
  }

  /**
   * @private
   * @author ddj 2026-11-24
   * @description: 同一条缺口只上报一次；去重表满了就丢最早的键，保证内存有界。
   * @param space 工作区状态
   * @param key 去重键
   * @param absolute 出问题的路径
   * @param message 原因
   * @returns 无
   */
  function noteGapOnce(space: Workspace, key: string, absolute: string, message: string): void {
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
   * @author ddj 2026-11-24
   * @description: 「版本库状态不可用」按工作区节流上报，让面板能说清为什么没拦住噪声。
   * @param space 工作区状态
   * @param reason 失败原因（命令回执头 200 字）
   * @returns 无
   */
  function noteStatusOnce(space: Workspace, reason: string): void {
    const at = now()
    if (at - space.statusNoteAt < STATUS_NOTE_MIN_MS) return
    space.statusNoteAt = at
    noteCaptureGap(space.cwd, space.sessionId, space.cwd, '版本库状态不可用：' + reason.slice(0, 200))
  }

  /**
   * @private
   * @author ddj 2026-11-24
   * @description: 整文件新增的熔断：短时间成批出现「没有基线的整文件新增」时判定为批量噪声，
   * 静默一段时间不新建档，只留一条缺口。已有条目的更新不受影响。
   * @param space 工作区状态
   * @param absolute 触发熔断的路径
   * @returns 允许新建返回 true
   */
  function allowNewWholeFile(space: Workspace, absolute: string): boolean {
    const at = now()
    if (space.burstMutedUntil > at) return false
    if (at - space.burstAt > BURST_WINDOW_MS) {
      space.burstAt = at
      space.burstCount = 0
    }
    space.burstCount += 1
    if (space.burstCount <= BURST_NEW_LIMIT) return true
    space.burstMutedUntil = at + BURST_COOLDOWN_MS
    noteGapOnce(space, 'burst:' + String(space.burstMutedUntil), absolute,
      `短时间内新建 ${space.burstCount} 条整文件新增记录：疑似批量噪声，暂停 ${Math.round(BURST_COOLDOWN_MS / 60000)} 分钟`)
    return false
  }

  /**
   * @private
   * @description: 处理一个路径：判定链见文件头注释。
   * @param space 工作区状态
   * @param absolute 绝对路径
   * @param entries 本批共享的条目表
   * @returns 是否新增或更新了条目
   */
  async function handleOne(space: Workspace, absolute: string, entries: Map<string, StoredEntry>): Promise<boolean> {
    const key = pathKeyOf(absolute)
    const at = now()
    const content = await readOf(space.cwd, absolute)
    const stored = entries.get(key)
    const sameContent = stored !== undefined && stored.entry.newText === (content ?? '')
    const sameMissing = stored !== undefined && stored.flags.missing === (content === null)
    if (stored && sameContent && sameMissing) {
      space.seen.set(key, content)
      return false
    }

    const window = windows.windowOf(key, at)
    if (window === 'self') {
      // 插件自己刚写回（撤销/镜像写穿）：内容随后会出现在条目里，这里不建新记录
      space.seen.set(key, content)
      return false
    }
    if (window === 'editor') {
      space.seen.set(key, content)
      // 编辑器保存：只推进基线；已有条目按外部改动吸收（基线不动、标分歧），不新开行
      if (!stored) return false
      const current = latestOf(space, absolute, stored)
      if (!current || current.entry.newText === (content ?? '')) return false
      deps.record(writeOf(space, absolute, current.entry.newText, content, at, 'watch', 'editor', 'known'))
      return true
    }

    const status = await statusOf(space)
    if (status && !status.entries.has(key)) {
      // 版本库说这个路径相对基线干净：可能是版本库同步，也可能是工具刚写完、
      // 而本批快照还停在上一轮（git 忽略的路径根本不出现在 status 里）。
      space.seen.set(key, content)
      if (!stored) return false
      const current = latestOf(space, absolute, stored)
      if (!current || current.entry.newText === (content ?? '')) return false
      deps.record(writeOf(space, absolute, current.entry.newText, content, at, 'vcs', 'vcs', 'known'))
      return true
    }
    // 拿不到版本库状态时，首次见到的路径必须自带证据：文件真的在监听开始之后被写过。
    // 否则事件多半只是读取/属性变化（整树扫描、索引器、杀软），按「整文件新增」建档会刷出幽灵差异。
    if (!status && !stored && !space.seen.has(key) && !recentlyWritten(space, absolute)) {
      noteGapOnce(space, 'absent:' + key, absolute, '无版本库状态且文件未改动，未建档')
      space.seen.set(key, content)
      return false
    }

    const before = await beforeOf(space, key, absolute, stored, status, content)
    if (before.text === null && content === null) {
      // 观察不到任何内容（既没文件也没基线）：没有可审的差异
      space.seen.set(key, null)
      return false
    }
    // 没有基线的整文件新增是幽灵记录的典型形态：短时间成批出现就熔断，避免一次噪声刷满面板
    if (!stored && before.text === null && !allowNewWholeFile(space, absolute)) {
      space.seen.set(key, content)
      return false
    }
    deps.record(writeOf(space, absolute, before.text, content, at, 'watch',
      windows.inAgentWindow(at) ? 'agent' : 'external', before.kind))
    space.seen.set(key, content)
    return true
  }

  /**
   * @private
   * @description: 求修改前内容：已知内容 → 首次观察 → 版本库新增/基线 → 未知。
   * @param space 工作区状态
   * @param key 路径比较键
   * @param absolute 绝对路径
   * @param stored 既有条目
   * @param status 版本库状态
   * @param content 当前内容
   * @returns 修改前内容与可信度
   */
  async function beforeOf(
    space: Workspace, key: string, absolute: string, stored: StoredEntry | undefined,
    status: VcsStatus | null, content: string | null,
  ): Promise<{ text: string | null; kind: 'known' | 'absent' | 'vcs' | 'unknown' }> {
    if (stored) return { text: stored.flags.missing ? null : stored.entry.newText, kind: 'known' }
    if (space.seen.has(key)) {
      const seen = space.seen.get(key) ?? null
      return { text: seen, kind: seen === null ? 'absent' : 'known' }
    }
    const entry = status?.entries.get(key)
    if (entry?.status === 'added') return { text: null, kind: 'absent' }
    if (entry && content !== null) {
      const scope = vcsScopeOf(deps.ctx, space.cwd, space.sessionId)
      if (scope && status) {
        const base = await vcsBaselineOf(scope.shell, status, absolute)
        if (base !== null) return { text: base, kind: 'vcs' }
      }
    }
    return { text: null, kind: 'unknown' }
  }

  /**
   * @private
   * @description: 组装一条待审写入（watch 通道）。
   * @param space 工作区状态
   * @param absolute 绝对路径
   * @param before 修改前内容
   * @param after 当前内容
   * @param at 时间
   * @param source 采集通道
   * @param origin 归属
   * @param baseKind 基线可信度
   * @returns 待审写入
   */
  function writeOf(
    space: Workspace, absolute: string, before: string | null, after: string | null, at: number,
    source: 'watch' | 'vcs', origin: 'agent' | 'editor' | 'vcs' | 'external',
    baseKind: 'known' | 'absent' | 'vcs' | 'unknown',
  ): PendingWrite {
    return {
      cwd: space.cwd, sessionId: space.sessionId, path: absolute, identity: absolute,
      before, after, now: at, tool: source, origin, baseKind,
    }
  }

  /**
   * @private
   * @description: 处理本工作区的一个批次：取一批 → 读盘判定 → 落库 → 失效目录树。
   * @param space 工作区状态
   * @returns 无
   */
  async function flushSpace(space: Workspace): Promise<void> {
    if (stopped) return
    if (space.flushing) { space.again = true; return }
    space.flushing = true
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
        try {
          const size = item.path.length
          if (bytes + size > MAX_FLUSH_BYTES) { space.dirty.set(pathKeyOf(item.path), item); continue }
          bytes += size
          if (await handleOne(space, item.path, entries)) { recorded += 1; touched.push(item.path) }
        } catch (error) {
          noteCaptureGap(space.cwd, space.sessionId, item.path, error)
          log.debug('外部改动跳过：' + item.path + ': ' + String(error))
        }
      }
      for (const path of touched) invalidateIndex(deps.ctx, space.cwd, path)
      if (recorded) log.debug(`外部改动记录 ${recorded} 条（${space.cwd}）`)
    } catch (error) {
      log.warn('外部改动处理失败：' + String(error))
    } finally {
      space.flushing = false
      if (space.seen.size > SEEN_MAX) {
        for (const key of [...space.seen.keys()].slice(0, space.seen.size - SEEN_MAX)) space.seen.delete(key)
      }
      if (space.dirty.size) schedule(space)
      else if (space.again) { space.again = false; schedule(space) }
    }
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
      if (!deps.settings().watch) return
      startWatch(space)
      // 启动对齐：后台跑一次补扫，把 watch 启动之前漏掉的改动补录进来
      if (!deps.settings().scan || space.alignedAt) return
      space.alignedAt = now()
      const timer = setTimeout(() => { void alignNow(space) }, 0)
      if (typeof timer.unref === 'function') timer.unref()
      if (!space.alignTimer) space.alignTimer = setInterval(() => { void alignNow(space) }, ALIGN_INTERVAL_MS)
      if (typeof space.alignTimer.unref === 'function') space.alignTimer.unref()
    },
    dismiss(cwd: string): void {
      const key = pathKeyOf(cwd)
      const space = spaces.get(key)
      if (!space) return
      closeWatchers(space)
      if (space.timer) clearTimeout(space.timer)
      if (space.requestTimer) clearTimeout(space.requestTimer)
      if (space.alignTimer) clearInterval(space.alignTimer)
      spaces.delete(key)
    },
    requestAlign(cwd: string, delayMs = ALIGN_AFTER_VCS_MS): void {
      // 版本库写命令和手动按钮共用：同工作区在延迟窗内只跑一次补扫
      if (stopped || !cwd || !deps.settings().scan) return
      const space = spaces.get(pathKeyOf(cwd))
      if (!space) return
      if (space.requestTimer) clearTimeout(space.requestTimer)
      const timer = setTimeout(() => {
        space.requestTimer = null
        void alignNow(space)
      }, Math.max(0, delayMs))
      if (typeof timer.unref === 'function') timer.unref()
      space.requestTimer = timer
    },
    enqueue(cwd: string, absolute: string): void {
      enqueue(cwd, absolute)
    },
    async flush(cwd?: string): Promise<void> {
      for (const [key, space] of spaces) {
        if (cwd && key !== pathKeyOf(cwd)) continue
        if (space.timer) { clearTimeout(space.timer); space.timer = null }
        await flushSpace(space)
      }
    },
    dispose(): void {
      stopped = true
      for (const space of spaces.values()) {
        closeWatchers(space)
        if (space.timer) clearTimeout(space.timer)
        if (space.alignTimer) clearInterval(space.alignTimer)
        space.dirty.clear()
        space.seen.clear()
      }
      spaces.clear()
    },
  }

  /**
   * @private
   * @description: 后台补扫一次（复用 externalAlign 的候选与预算）。
   * @param space 工作区状态
   * @returns 无
   */
  async function alignNow(space: Workspace): Promise<void> {
    if (stopped || !deps.settings().scan) return
    try {
      if (deps.align) { await deps.align(space.cwd, space.sessionId); return }
      const { alignInWorkspace } = await import('./externalAlign.js')
      const outcome = await alignInWorkspace(deps.ctx, space.cwd, space.sessionId, deps.record)
      if (outcome.gaps.length) log.debug('补扫缺口：' + outcome.gaps.join('；'))
    } catch (error) {
      log.debug('后台补扫失败：' + String(error))
    }
  }
}

// --endregion
