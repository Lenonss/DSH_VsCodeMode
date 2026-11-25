/**
 * 归档库清理：保留期 + 每文件上限 + 撤销栈截断。
 *
 * 设计取舍：
 * - 只删「已判定」的内容：`batches.pending > 0` 或批次内任一条 `records.pending > 0` 的整批跳过，
 *   绝不因为时间久就丢掉还没判的 hunk。
 * - 删除顺序写死：先按 call_id 清 `revert_intents`，再删 `records`，最后删 `batches`。
 *   表里的 REFERENCES 只是声明，SQLite 默认不开外键，靠这条顺序避免孤儿行。
 * - 时间比较用 `Date.parse`，解析失败的时间一律当「不超期」，宁可少删。
 * - 真删之前先留一份同名备份（`<db>.before-purge.bak`，覆盖写），每个工作区只占一份。
 * 作者 ddj 2026-11-24
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { archiveDbFile, dshHome, PLUGIN_ID } from './paths.js'
import { dbFor, activeReady, closeArchiveDbs } from './archiveDb.js'
import { log } from './log.js'

/** 已判定历史默认保留天数。 */
export const RETENTION_DAYS = 30
/** 同一路径默认保留多少个归档批次。 */
export const KEEP_BATCHES = 20
/** 幂等操作表默认保留多少条（该表无时间列，按 rowid 保留最近的）。 */
export const KEEP_OPS = 500
/** 真删前备份文件名后缀。 */
const BACKUP_SUFFIX = '.before-purge.bak'

/** 清理选项；缺省值即产品默认。 */
export interface ArchivePurgeOptions {
  /** 保留天数（缺省 {@link RETENTION_DAYS}）。 */
  retentionDays?: number
  /** 每路径保留批次数（缺省 {@link KEEP_BATCHES}）。 */
  keepBatches?: number
  /** 幂等表保留条数（缺省 {@link KEEP_OPS}）。 */
  keepOps?: number
  /** true 只报数不删。 */
  dryRun?: boolean
  /** 删除后 VACUUM（缺省 true）。 */
  vacuum?: boolean
}

/** 一次清理的结果。 */
export interface ArchivePurgeOutcome {
  /** 超期候选批次数（与 overCap 可能重叠）。 */
  expired: number
  /** 超每文件上限的候选批次数。 */
  overCap: number
  /** 因为还有未判定内容而跳过的批次数。 */
  keptPending: number
  /** 实际删除的行数。 */
  removed: { records: number; batches: number; history: number }
  /** VACUUM 耗时毫秒；未执行时为 undefined。 */
  vacuumMs?: number
}

/** 数据库行。 */
type Row = Record<string, string | number | null>

/**
 * @author ddj 2026-11-24
 * @description: 挑出要删的批次：先按保留期，再按每路径上限，未判完的整批跳过。
 * @param db 工作区归档库连接
 * @param options 清理选项
 * @returns 候选批次 id 与两个统计口径
 */
function pickCandidates(db: ReturnType<typeof dbFor>, options: ArchivePurgeOptions): {
  ids: number[]; expired: number; overCap: number; keptPending: number
} {
  const retentionDays = options.retentionDays ?? RETENTION_DAYS
  const keepBatches = options.keepBatches ?? KEEP_BATCHES
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  // 批次按路径分组、组内按时间倒序：靠前的就是留下的
  const rows = db.prepare(`SELECT b.id, b.path, b.at, b.pending,
      (SELECT COUNT(*) FROM records r WHERE r.batch_id = b.id AND r.pending > 0) AS open_records
    FROM batches b ORDER BY b.path, b.at DESC, b.id DESC`).all() as Row[]
  const seen = new Map<string, number>()
  const picked = new Set<number>()
  let expired = 0
  let overCap = 0
  let keptPending = 0
  for (const row of rows) {
    const id = Number(row.id)
    const path = String(row.path)
    const order = (seen.get(path) ?? 0) + 1
    seen.set(path, order)
    const at = Date.parse(String(row.at))
    const isExpired = Number.isFinite(at) && at < cutoff
    const isOverCap = order > keepBatches
    if (!isExpired && !isOverCap) continue
    if (isExpired) expired += 1
    if (isOverCap) overCap += 1
    // 还有未判定内容的批次一律保留：删了就再也判不了
    if (Number(row.pending) > 0 || Number(row.open_records) > 0) {
      keptPending += 1
      continue
    }
    picked.add(id)
  }
  return { ids: [...picked], expired, overCap, keptPending }
}

/**
 * @author ddj 2026年11月25号
 * @description: 截断幂等表：撤销栈已改成「一条路径一行」，不再按步裁剪。
 * @param db 工作区归档库连接
 * @param keepOps 幂等表保留条数
 * @returns 删除的历史行数（恒为 0，保留字段只为回执口径不变）
 */
function trimPendingTables(db: ReturnType<typeof dbFor>, keepOps: number): number {
  db.prepare(`DELETE FROM pending_ops WHERE rowid NOT IN (
      SELECT rowid FROM pending_ops ORDER BY rowid DESC LIMIT ?)`).run(keepOps)
  return 0
}

/**
 * @author ddj 2026-11-24
 * @description: 真删：单事务内按「撤销意图 → 记录 → 批次」顺序清，备份在事务之前做。
 * @param db 工作区归档库连接
 * @param ids 候选批次 id
 * @returns 删除的记录数与批次数
 */
function removeBatches(db: ReturnType<typeof dbFor>, ids: number[]): { records: number; batches: number } {
  const callIds = db.prepare('SELECT call_id FROM records WHERE batch_id = ?')
  const dropIntent = db.prepare('DELETE FROM revert_intents WHERE call_id = ?')
  const dropRecords = db.prepare('DELETE FROM records WHERE batch_id = ?')
  const dropBatch = db.prepare('DELETE FROM batches WHERE id = ?')
  let records = 0
  let batches = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const id of ids) {
      for (const row of callIds.all(id) as Row[]) dropIntent.run(String(row.call_id))
      records += Number(dropRecords.run(id).changes)
      batches += Number(dropBatch.run(id).changes)
    }
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
  return { records, batches }
}

/**
 * @public
 * @author ddj 2026-11-24
 * @description: 归档库清理入口：保留期 + 每文件上限 + 撤销栈截断，可选 VACUUM。
 * @param cwd 工作区
 * @param options 清理选项
 * @returns 三个统计口径与实际删除行数
 * @throws 归档库不可用或事务失败
 */
export function purgeArchiveDb(cwd: string, options: ArchivePurgeOptions = {}): ArchivePurgeOutcome {
  const db = dbFor(cwd)
  const { ids, expired, overCap, keptPending } = pickCandidates(db, options)
  const dryRun = options.dryRun !== false
  const keepOps = options.keepOps ?? KEEP_OPS
  if (dryRun) {
    return { expired, overCap, keptPending, removed: { records: 0, batches: 0, history: 0 } }
  }
  // 没有要删的批次就不备份、不动库：每日扫描绝大多数时候是空跑
  if (ids.length) backupBeforePurge(db, cwd)
  const removedBatches = removeBatches(db, ids)
  const history = activeReady(cwd) ? trimPendingTables(db, keepOps) : 0
  const outcome: ArchivePurgeOutcome = {
    expired, overCap, keptPending,
    removed: { ...removedBatches, history },
  }
  if (options.vacuum !== false && (removedBatches.batches || history)) {
    outcome.vacuumMs = vacuumOf(db)
  }
  return outcome
}

/**
 * @private
 * @author ddj 2026-11-24
 * @description: 回收已删行占用的页；失败只记日志，不影响已完成的删除。
 * @param db 工作区归档库连接
 * @returns 耗时毫秒
 */
function vacuumOf(db: ReturnType<typeof dbFor>): number {
  const started = Date.now()
  try {
    db.exec('VACUUM')
  } catch (error) {
    log.warn('归档库 VACUUM 失败：' + String(error))
  }
  return Date.now() - started
}

/**
 * @private
 * @author ddj 2026-11-24
 * @description: 真删前留一份备份；同名覆盖，每个工作区只占一份。
 * @param db 工作区归档库连接
 * @param cwd 工作区
 * @returns 无
 */
function backupBeforePurge(db: ReturnType<typeof dbFor>, cwd: string): void {
  const target = archiveDbFile(cwd) + BACKUP_SUFFIX
  try {
    rmSync(target, { force: true })
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  } catch (error) {
    log.warn('归档库清理前备份失败（继续执行）：' + String(error))
  }
}

// --region 每日扫描

/** 启动后首次扫描的延迟：避开启动高峰。 */
export const SWEEP_FIRST_DELAY_MS = 90_000
/** 扫描间隔：每天一次。 */
export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 扫描选项（测试可注入节奏、执行体与 home）。 */
export interface ArchiveSweepOptions {
  /** 首次扫描延迟毫秒。 */
  delayMs?: number
  /** 重复扫描间隔毫秒。 */
  intervalMs?: number
  /** 单个工作区的执行体（缺省 {@link purgeArchiveDb}）。 */
  run?: (cwd: string, options: ArchivePurgeOptions) => ArchivePurgeOutcome
  /** 覆盖 DSH home（测试注入）。 */
  home?: string
  /** 覆盖「重写库文件」的执行体（测试注入；缺省起子进程做 VACUUM）。 */
  rewrite?: (jobs: RewriteJob[]) => void
}

/** 交给子进程的重写任务：备份 + 回收页，两件都是整库 IO，必须离开宿主事件循环。 */
export interface RewriteJob {
  /** 库文件绝对路径。 */
  file: string
  /** 清理前备份路径；空串表示不备份。 */
  backup: string
}

/**
 * @public
 * @author ddj 2026-11-24
 * @description: 列出本机所有归档库对应的工作区：读每个库里的 metadata.cwd，
 * 不依赖有没有活跃会话。读不出来的库跳过并记日志。
 * @param home DSH home
 * @returns 工作区绝对路径清单
 */
export function listArchiveWorkspaces(home = dshHome()): string[] {
  let names: string[] = []
  try {
    names = readdirSync(join(home, PLUGIN_ID, 'data', 'archive')).filter((name) => name.endsWith('.sqlite'))
  } catch {
    return []
  }
  const found: string[] = []
  for (const name of names) {
    const file = join(home, PLUGIN_ID, 'data', 'archive', name)
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(file, { readOnly: true })
      const row = db.prepare("SELECT value FROM metadata WHERE name='cwd'").get() as { value?: unknown } | undefined
      if (row?.value) found.push(String(row.value))
    } catch (error) {
      log.debug('跳过不可读归档库：' + file + ' ' + String(error))
    } finally {
      try { db?.close() } catch { /* 关闭失败不影响扫描 */ }
    }
  }
  return found
}

/**
 * @public
 * @author ddj 2026-11-24 / 2026年11月25号
 * @description: 对所有工作区归档库跑一遍清理；删除在进程内做完（快），整库重写交给子进程。
 * 单个库失败只记日志，不影响其他库。
 * @param options 扫描选项
 * @returns 扫描到的库数与删除的行数合计
 */
export function sweepArchives(options: ArchiveSweepOptions = {}): { workspaces: number; removed: number; rewrites: number } {
  const run = options.run ?? purgeArchiveDb
  const workspaces = listArchiveWorkspaces(options.home)
  const jobs: RewriteJob[] = []
  let removed = 0
  for (const cwd of workspaces) {
    try {
      // vacuum:false 先在进程内删行；备份与 VACUUM 一律留到最后统一交给子进程
      const outcome = run(cwd, { dryRun: false, vacuum: false })
      removed += outcome.removed.batches + outcome.removed.history
      if (!outcome.removed.batches && !outcome.removed.history) continue
      jobs.push({ file: archiveDbFile(cwd, options.home), backup: archiveDbFile(cwd, options.home) + BACKUP_SUFFIX })
      log.debug(`归档库清理：${cwd} 批次 ${outcome.removed.batches}，历史 ${outcome.removed.history}`)
    } catch (error) {
      log.debug('归档库清理跳过：' + cwd + ' ' + String(error))
    }
  }
  if (jobs.length) {
    const rewrite = options.rewrite ?? rewriteInChild
    try { rewrite(jobs) } catch (error) { log.warn('归档库重写调度失败（库已删行，未回收空间）：' + String(error)) }
  }
  return { workspaces: workspaces.length, removed, rewrites: jobs.length }
}

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 起一个独立 Node 子进程做备份与 VACUUM。这两步是整库读写，留在宿主里会把
 * 事件循环堵住十几秒，所有 RPC（含文件读取、差异渲染）都会一起卡住。
 * 子进程只认「文件 + 备份路径」，不含任何业务规则，规则仍只有 {@link purgeArchiveDb} 一份。
 * @param jobs 重写任务
 * @returns 无（不等待完成）
 */
function rewriteInChild(jobs: RewriteJob[]): void {
  // 子进程要独占写库：先把本进程缓存的连接关掉，否则它会在 busy_timeout 里空转
  try { closeArchiveDbs() } catch { /* 关闭失败仍交给子进程重试 */ }
  const script = [
    "const { DatabaseSync } = require('node:sqlite')",
    "const { rmSync } = require('node:fs')",
    'const jobs = JSON.parse(process.argv[1])',
    'for (const job of jobs) {',
    '  let db',
    '  try {',
    '    db = new DatabaseSync(job.file, { timeout: 15000 })',
    "    db.exec('PRAGMA busy_timeout=15000')",
    '    if (job.backup) {',
    '      try { rmSync(job.backup, { force: true }) } catch (e) { /* 备份覆盖失败不阻断 */ }',
    "      db.exec(\"VACUUM INTO '\" + job.backup.replace(/'/g, \"''\") + \"'\")",
    '    }',
    "    db.exec('VACUUM')",
    '  } catch (error) {',
    '    console.error(String(error))',
    '    process.exitCode = 1',
    '  } finally {',
    '    try { db && db.close() } catch (e) { /* 已关闭 */ }',
    '  }',
    '}',
  ].join('\n')
  const child = spawn(process.execPath, ['-e', script, JSON.stringify(jobs)], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  child.on('error', (error) => log.warn('归档库重写子进程启动失败：' + String(error)))
  child.on('exit', (code) => {
    if (code === 0) log.debug('归档库重写完成：' + jobs.length + ' 个库')
    else log.warn('归档库重写子进程退出码 ' + String(code) + '：' + stderr.slice(0, 300))
  })
  if (typeof child.unref === 'function') child.unref()
}

/**
 * @public
 * @author ddj 2026年11月25号
 * @description: 单个工作区库的备份与回收页交给子进程；RPC 层删完行后调它，不再原地 VACUUM。
 * @param cwd 工作区
 * @param home DSH home（测试可注入）
 * @returns 无
 */
export function scheduleArchiveRewrite(cwd: string, home = dshHome()): void {
  const file = archiveDbFile(cwd, home)
  try { rewriteInChild([{ file, backup: file + BACKUP_SUFFIX }]) } catch (error) {
    log.warn('归档库重写调度失败（库已删行，未回收空间）：' + String(error))
  }
}

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 今日是否已经扫过：两个宿主（桌面端与 Web 端）共用同一份 home，避免一天扫两遍。
 * @param home DSH home
 * @returns 已扫过返回 true
 */
function sweptToday(home: string): boolean {
  const stamp = join(home, PLUGIN_ID, 'data', 'archive', '.sweep-' + new Date().toISOString().slice(0, 10))
  try {
    if (existsSync(stamp)) return true
    mkdirSync(dirname(stamp), { recursive: true })
    writeFileSync(stamp, new Date().toISOString(), 'utf8')
    return false
  } catch {
    return false
  }
}

/**
 * @public
 * @author ddj 2026-11-24
 * @description: 每日自动清理：启动后延迟跑一次，之后每 24 小时一次；返回可释放的句柄。
 * @param options 扫描选项
 * @returns 可释放句柄
 */
export function startArchiveSweep(options: ArchiveSweepOptions = {}): { dispose(): void } {
  let stopped = false
  const run = (): void => {
    if (stopped) return
    if (sweptToday(options.home ?? dshHome())) return
    try { sweepArchives(options) } catch (error) { log.warn('归档库每日清理失败：' + String(error)) }
  }
  const first = setTimeout(run, options.delayMs ?? SWEEP_FIRST_DELAY_MS)
  const timer = setInterval(run, options.intervalMs ?? SWEEP_INTERVAL_MS)
  if (typeof first.unref === 'function') first.unref()
  if (typeof timer.unref === 'function') timer.unref()
  return {
    dispose(): void {
      stopped = true
      clearTimeout(first)
      clearInterval(timer)
    },
  }
}

// --endregion
