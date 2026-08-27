/**
 * dsh-vscode-mode host — DSH 会话性能管理（会话卫生 + 体积 stat + 侧车摘要）。
 * 职责：
 * - 盘点 ~/.dsh/sessions 全部工作区会话（每会话仅 stat 日志文件，不解压，轻量）；
 * - 移出/恢复/清除：会话目录在 ~/.dsh/sessions 与 ~/.dsh/sessions-archive 间可逆搬迁；
 * - 当前会话体积 stat（对话头部指示器用，纯 stat）；
 * - 侧车摘要：agent/脚本取关键字段，避免整份读 .dsh-edit-review.json 进对话。
 * 纯函数可单测（路径编码/移出规划）；fs 操作 best-effort 返回逐项结果不抛。
 * 作者 ddj 2026-09-02
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { parseSidecar } from './store.js'
import { recSummary } from './model.js'
import { SIDECAR, SIDECAR_ARCHIVE, dshHome, sessionIdSegment, sessionWorkspaceKey, sessionsRoot } from './paths.js'
import type { PerfMoveFailure, PerfMoveItem, PerfSession, PerfTotals, PerfWorkspace, SidecarPerfSummary } from './shared/rpc.js'
import type { Ctx } from './store.js'

/** 会话日志文件名（zstd 优先，降级纯 jsonl）。 */
const LOG_NAMES = ['session.jsonl.zstd', 'session.jsonl']

/** 归档根（~/.dsh/sessions-archive，与 sessions 同级，可逆移出的落点）。 */
export function sessionsArchiveRoot(home = dshHome()): string {
  return join(home, 'sessions-archive')
}

/** 会话盘点结果（工作区聚合 + 会话明细 + 汇总）。 */
export interface SessionInventory {
  workspaces: PerfWorkspace[]
  sessions: PerfSession[]
  totals: PerfTotals
}

/** 移出规划条件：显式集合或规则（minBytes / olderThanDays）。 */
export interface MoveCriteria {
  workspaceKey?: string
  sessionIds?: string[]
  minBytes?: number
  olderThanDays?: number
}

/** 路径段校验：非空、非 . / ..、不含分隔符与 Windows 非法字符（防 join 逃逸）。 */
export function validDirName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && !/[/\\]/.test(name) && !/[:*?"<>|]/.test(name)
}

/** target 必须落在 root 内（自身或其子路径），防路径穿越。 */
export function withinDir(target: string, root: string): boolean {
  const rel = resolve(target)
  const base = resolve(root)
  return rel === base || rel.startsWith(base + sep)
}

/** stat 一个会话目录里的日志文件（首个存在的），缺失 → null。 */
export async function statSessionLog(sessionDir: string): Promise<{ size: number; mtimeMs: number } | null> {
  for (const name of LOG_NAMES) {
    try {
      const info = await stat(join(sessionDir, name))
      if (info.isFile()) return { size: info.size, mtimeMs: info.mtimeMs }
    } catch (error) { /* 尝试下一个日志名 */ }
  }
  return null
}

/**
 * 盘点 ~/.dsh/sessions：按工作区分组，每会话仅 stat 日志文件体积与 mtime。
 * 不解压日志（V8 展开成本高），活跃标记由调用方传入后置。
 * @author ddj 2026年09月02号
 * @param home DSH home（测试可注入）
 * @param archive 归档根（默认 sessions-archive；测试可注入）
 * @returns 工作区聚合（按体积降序）+ 会话明细（按体积降序）+ 汇总
 */
export async function scanSessionInventory(home = dshHome(), archive = sessionsArchiveRoot(home)): Promise<SessionInventory> {
  void archive
  const root = sessionsRoot(home)
  const workspaces: PerfWorkspace[] = []
  const sessions: PerfSession[] = []
  let totalBytes = 0
  let totalCount = 0
  const wsDirs = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const ws of wsDirs) {
    if (!ws.isDirectory() || !validDirName(ws.name)) continue
    const wsDir = join(root, ws.name)
    const wsSessions: PerfSession[] = []
    let wsBytes = 0
    let minMtime = Number.POSITIVE_INFINITY
    let maxMtime = 0
    const sessionDirs = await readdir(wsDir, { withFileTypes: true }).catch(() => [])
    for (const sd of sessionDirs) {
      if (!sd.isDirectory()) continue
      const info = await statSessionLog(join(wsDir, sd.name))
      if (!info) continue
      const row: PerfSession = { sessionId: sd.name, workspaceKey: ws.name, bytes: info.size, mtime: info.mtimeMs, active: false }
      wsSessions.push(row)
      wsBytes += info.size
      totalBytes += info.size
      totalCount += 1
      if (info.mtimeMs < minMtime) minMtime = info.mtimeMs
      if (info.mtimeMs > maxMtime) maxMtime = info.mtimeMs
    }
    wsSessions.sort((a, b) => b.bytes - a.bytes)
    sessions.push(...wsSessions)
    workspaces.push({
      workspaceKey: ws.name,
      sessionCount: wsSessions.length,
      totalBytes: wsBytes,
      minMtime: Number.isFinite(minMtime) ? minMtime : 0,
      maxMtime,
    })
  }
  workspaces.sort((a, b) => b.totalBytes - a.totalBytes)
  return { workspaces, sessions, totals: { workspaces: workspaces.length, sessions: totalCount, totalBytes } }
}

/** 标记活跃会话（live id 与目录段名双向匹配，兼容编码差异）。 */
export function markActiveSessions(sessions: PerfSession[], activeIds: Iterable<string>): void {
  const raw = new Set(activeIds)
  const encoded = new Set<string>()
  for (const id of raw) encoded.add(sessionIdSegment(id))
  for (const s of sessions) {
    if (raw.has(s.sessionId) || encoded.has(s.sessionId)) s.active = true
  }
}

/**
 * 移出规划（纯函数）：从盘点中按「显式集合」或「规则（minBytes / olderThanDays）」
 * 圈选可移出会话。活跃会话一律排除；无显式集合且无规则时不选（防误移）。
 * @author ddj 2026年09月02号
 * @param inventory 盘点结果
 * @param criteria 圈选条件
 * @returns 待移出清单与释放字节
 */
export function planMoveOut(inventory: SessionInventory, criteria: MoveCriteria): { items: PerfMoveItem[]; reclaimedBytes: number } {
  const items: PerfMoveItem[] = []
  const explicit = Array.isArray(criteria.sessionIds) && criteria.sessionIds.length > 0
  const cutoff = criteria.olderThanDays ? Date.now() - criteria.olderThanDays * 24 * 60 * 60 * 1000 : 0
  for (const s of inventory.sessions) {
    if (s.active) continue
    if (criteria.workspaceKey && s.workspaceKey !== criteria.workspaceKey) continue
    if (explicit) {
      if (!criteria.sessionIds!.includes(s.sessionId)) continue
    } else {
      if (criteria.minBytes && s.bytes < criteria.minBytes) continue
      if (criteria.olderThanDays && s.mtime > cutoff) continue
      if (!criteria.minBytes && !criteria.olderThanDays) continue
    }
    items.push({ workspaceKey: s.workspaceKey, sessionId: s.sessionId, bytes: s.bytes })
  }
  return { items, reclaimedBytes: items.reduce((sum, i) => sum + i.bytes, 0) }
}

/** 移出执行结果。 */
export interface MoveOutResult {
  moved: PerfMoveItem[]
  failures: PerfMoveFailure[]
  reclaimedBytes: number
}

/**
 * 移出会话目录到归档区（同卷 rename，可逆）。活跃会话拒绝；路径越界拒绝；
 * 逐项 best-effort，成功项写归档 manifest。默认不 dry-run（dryRun 时只校验不搬迁）。
 * @author ddj 2026年09月02号
 * @param home DSH home
 * @param archive 归档根
 * @param items 待移出清单（来自 planMoveOut 或用户确认）
 * @param activeIds 活跃会话 id 集合（执行期再校验一次）
 * @param dryRun 仅校验不搬迁
 */
export async function moveOutSessions(home: string, archive: string, items: PerfMoveItem[], activeIds: Iterable<string>, dryRun = false): Promise<MoveOutResult> {
  const root = sessionsRoot(home)
  const rawActive = new Set(activeIds)
  const encodedActive = new Set<string>()
  for (const id of rawActive) encodedActive.add(sessionIdSegment(id))
  const isActive = (id: string): boolean => rawActive.has(id) || encodedActive.has(id)
  const moved: PerfMoveItem[] = []
  const failures: PerfMoveFailure[] = []
  for (const item of items) {
    if (!validDirName(item.workspaceKey)) {
      failures.push({ workspaceKey: item.workspaceKey, sessionId: item.sessionId, error: '工作区键不合法' })
      continue
    }
    if (isActive(item.sessionId)) {
      failures.push({ workspaceKey: item.workspaceKey, sessionId: item.sessionId, error: '活跃会话，拒绝移出' })
      continue
    }
    const seg = sessionIdSegment(item.sessionId)
    const src = join(root, item.workspaceKey, seg)
    const dst = join(archive, item.workspaceKey, seg)
    if (!withinDir(src, root) || !withinDir(dst, archive)) {
      failures.push({ workspaceKey: item.workspaceKey, sessionId: item.sessionId, error: '路径越界，拒绝执行' })
      continue
    }
    if (dryRun) {
      try {
        const info = await stat(src)
        if (info.isDirectory()) moved.push({ ...item, bytes: (await statSessionLog(src))?.size ?? item.bytes })
        else failures.push({ workspaceKey: item.workspaceKey, sessionId: item.sessionId, error: '源目录不存在' })
      } catch (error) {
        failures.push({ workspaceKey: item.workspaceKey, sessionId: item.sessionId, error: '源目录不存在' })
      }
      continue
    }
    try {
      await mkdir(dirname(dst), { recursive: true })
      await rename(src, dst)
      const bytes = (await statSessionLog(dst))?.size ?? item.bytes
      moved.push({ ...item, bytes })
    } catch (error) {
      failures.push({ workspaceKey: item.workspaceKey, sessionId: item.sessionId, error: String(error) })
    }
  }
  if (moved.length && !dryRun) await appendMoveManifest(archive, moved)
  return { moved, failures, reclaimedBytes: moved.reduce((sum, i) => sum + i.bytes, 0) }
}

/** 恢复单个会话：归档 → sessions。目标已存在则拒绝（不覆盖）。 */
export async function restoreSession(home: string, archive: string, workspaceKey: string, sessionId: string): Promise<{ ok: boolean; error?: string }> {
  if (!validDirName(workspaceKey)) return { ok: false, error: '工作区键不合法' }
  const seg = sessionIdSegment(sessionId)
  const root = sessionsRoot(home)
  const src = join(archive, workspaceKey, seg)
  const dst = join(root, workspaceKey, seg)
  if (!withinDir(src, archive) || !withinDir(dst, root)) return { ok: false, error: '路径越界，拒绝执行' }
  try {
    await stat(src)
  } catch (error) {
    return { ok: false, error: '归档中不存在该会话' }
  }
  try {
    await stat(dst)
    return { ok: false, error: '目标位置已存在同名会话' }
  } catch (error) { /* 目标不存在，可恢复 */ }
  try {
    await mkdir(dirname(dst), { recursive: true })
    await rename(src, dst)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/** 清除归档区早于 N 天的会话（破坏性，仅限归档区）。 */
export async function purgeArchive(archive: string, olderThanDays: number): Promise<{ removed: number; reclaimedBytes: number }> {
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000
  let removed = 0
  let reclaimedBytes = 0
  const wsDirs = await readdir(archive, { withFileTypes: true }).catch(() => [])
  for (const ws of wsDirs) {
    if (!ws.isDirectory()) continue
    const wsDir = join(archive, ws.name)
    const sessionDirs = await readdir(wsDir, { withFileTypes: true }).catch(() => [])
    for (const sd of sessionDirs) {
      if (!sd.isDirectory()) continue
      const info = await statSessionLog(join(wsDir, sd.name))
      if (!info || info.mtimeMs > cutoff) continue
      try {
        await rm(join(wsDir, sd.name), { recursive: true, force: true })
        removed += 1
        reclaimedBytes += info.size
      } catch (error) { /* 删除失败跳过 */ }
    }
  }
  return { removed, reclaimedBytes }
}

/** 当前会话持久化体积（对话头部指示器用）：仅 stat，近零成本。 */
export async function sessionSizeOf(home: string, cwd: string, sessionId: string): Promise<{ bytes: number; exists: boolean }> {
  const dir = join(sessionsRoot(home), sessionWorkspaceKey(cwd), sessionIdSegment(sessionId))
  for (const name of LOG_NAMES) {
    try {
      const info = await stat(join(dir, name))
      if (info.isFile()) return { bytes: info.size, exists: true }
    } catch (error) { /* 尝试下一个日志名 */ }
  }
  return { bytes: 0, exists: false }
}

/**
 * 侧车摘要：返回活跃记录数、每文件 pending 计数、归档体积。
 * agent/脚本取关键字段即可，不必整份读 .dsh-edit-review.json（避免大对象进对话）。
 * @author ddj 2026年09月02号
 * @param ctx DSH host 上下文（fs 服务）
 * @param cwd 工作区路径（null 时返回空摘要）
 */
export async function sidecarSummaryOf(ctx: Ctx, cwd: string | null): Promise<SidecarPerfSummary> {
  const fs = ctx.get('fs')
  const summary: SidecarPerfSummary = { active: 0, pendingByFile: [], archiveBytes: 0 }
  if (!fs || !cwd) return summary
  try {
    const text = await fs.readText(await fs.resolve(SIDECAR, { cwd }))
    const data = parseSidecar(text)
    const recs = data?.workspaces?.[cwd]?.records
    if (recs) {
      const byFile = new Map<string, number>()
      let active = 0
      for (const rec of Object.values(recs)) {
        if (rec.archived) continue
        active += 1
        const sm = recSummary(rec)
        if (sm.pending > 0 && rec.path) byFile.set(rec.path, (byFile.get(rec.path) ?? 0) + sm.pending)
      }
      summary.active = active
      summary.pendingByFile = [...byFile.entries()].map(([path, pending]) => ({ path, pending })).sort((a, b) => b.pending - a.pending)
    }
    try {
      const info = await fs.stat(await fs.resolve(SIDECAR_ARCHIVE, { cwd }))
      summary.archiveBytes = info?.size ?? 0
    } catch (error) { /* 归档缺失忽略 */ }
  } catch (error) { /* sidecar 不可读返回空摘要 */ }
  return summary
}

/** 归档 manifest 条目。 */
interface MoveManifestEntry { at: string; workspaceKey: string; sessionId: string }

/** 归档 manifest（可逆移出的索引，供恢复/审计）。 */
interface MoveManifest { version: 1; items: MoveManifestEntry[] }

/** 解析归档 manifest（损坏/缺失 → 空）。 */
function parseMoveManifest(text: string | null): MoveManifest {
  if (!text) return { version: 1, items: [] }
  try {
    const data = JSON.parse(text) as MoveManifest
    return { version: 1, items: Array.isArray(data.items) ? data.items : [] }
  } catch (error) {
    return { version: 1, items: [] }
  }
}

/** 追加移出记录到归档 manifest（best-effort，失败不影响主流程）。 */
async function appendMoveManifest(archive: string, items: PerfMoveItem[]): Promise<void> {
  try {
    const file = join(archive, '.manifest.json')
    const prev = parseMoveManifest(await readFile(file, 'utf8').catch(() => null))
    const at = new Date().toISOString()
    for (const item of items) prev.items.push({ at, workspaceKey: item.workspaceKey, sessionId: item.sessionId })
    await mkdir(archive, { recursive: true })
    await writeFile(file, JSON.stringify(prev, null, 2), 'utf8')
  } catch (error) { /* manifest 写失败静默 */ }
}
