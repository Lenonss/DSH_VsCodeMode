/**
 * dsh-vscode-mode host — 存储层（sidecar 读写合并 + 归档持久化 + stale 检测）。
 * 迁移自原 src/index.ts 的 fs/ctx IO 部分，语义一字不改。
 * 作者 ddj 2026-08-20
 */
import type { ArchiveBatch, DiffRecord, SidecarData } from './shared/types.js'
import type { ReadState } from './shared/diff.js'
import { fingerprint, isNoopHunk, locateHunks, normalizeForCompare, normalizeHunk, preciseHunk } from './shared/diff.js'
import { archiveEntryFor, normalizeRecord } from './model.js'
import { SIDECAR, SIDECAR_ARCHIVE } from './paths.js'
import { log } from './log.js'
import { debugRecord } from './debugLog.js'
import { activeReady, appendArchive, checkActiveSource, commitActive, committedRecord, migrateActive, restoreReverts, type ActiveChange } from './archiveDb.js'

export { SIDECAR, SIDECAR_ARCHIVE }
export const READ_CAP = 8 * 1024 * 1024
/** 二进制预览/写回上限（PDF 等整文件 base64 传输；文本侧仍用 READ_CAP）。 */
export const BINARY_READ_CAP = 32 * 1024 * 1024
/** 旧文件首次全量指纹核验后，每次操作优先检查 DSH fs stat 身份。 */
const sourceStats = new Map<string, string>()

/** DSH 上下文与会话类型较宽松：本地无 dsh 类型声明，显式 any + 文档约束。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Ctx = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Session = any

/** 会话沙箱策略（policyOf）：可能不存在，调用方需容忍 undefined。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function policyOf(ctx: Ctx, session: Session | undefined): any {
  const svc = ctx.get('sandboxPolicy')
  if (!svc) return undefined
  return session ? svc.resolve({ session }) : svc.resolve()
}

/** 按会话 cwd 解析目标路径。 */
export async function resolveTarget(ctx: Ctx, session: Session | undefined, path: string): Promise<string> {
  const fs = ctx.get('fs')
  const cwd = session?.header?.cwd
  return fs.resolve(path, cwd ? { cwd } : {})
}

/** 读取工作区主 sidecar 文本（缺失/失败 → null）。 */
async function readSidecarText(ctx: Ctx, cwd: string | null): Promise<string | null> {
  const fs = ctx.get('fs')
  if (!fs || !cwd) return null
  try {
    return await fs.readText(await fs.resolve(SIDECAR, { cwd }))
  } catch (error) {
    return null
  }
}

/**
 * 解析主 sidecar：v2 直接返回；v1 迁移为 v2 结构（按会话 cwd 分桶）。
 * @author ddj 2026年08月20号
 * @param text sidecar 文本
 * @returns v2 数据或 null
 */
export function parseSidecar(text: string | null): SidecarData | null {
  if (!text) return null
  try {
    const data = JSON.parse(text)
    if (data && typeof data === 'object' && data.version === 2 && data.workspaces && typeof data.workspaces === 'object') {
      return data as SidecarData
    }
    if (data && data.version === 1 && data.sessions && typeof data.sessions === 'object') {
      const workspaces: SidecarData['workspaces'] = {}
      for (const bucket of Object.values(data.sessions)) {
        const b = bucket as { cwd?: unknown; records?: unknown; at?: unknown }
        if (typeof b.cwd === 'string' && b.records) {
          workspaces[b.cwd] = { at: typeof b.at === 'number' ? b.at : Date.now(), records: b.records as Record<string, DiffRecord> }
        }
      }
      return { version: 2, updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(), workspaces }
    }
    return null
  } catch (error) {
    return null
  }
}

/**
 * 严格读取旧 sidecar：仅确认确实不存在时才允许从空记录迁移。
 * @author ddj 2026年09月30号
 * @param ctx DSH 上下文
 * @param cwd 工作区
 * @returns 旧文件内容或确认缺失
 */
async function migrationText(ctx: Ctx, cwd: string): Promise<string | null> {
  const fs = ctx.get('fs')
  if (!fs) throw new Error('无法迁移差异记录：缺少 fs')
  const target = await fs.resolve(SIDECAR, { cwd })
  const info = await fs.stat(target)
  if (!info) return null
  if (info.type !== 'file') throw new Error('旧活跃 sidecar 非文件')
  return fs.readText(target)
}

/**
 * 读取旧 sidecar 文件的版本身份；缺少可靠版本令牌时返回 null 走全文核验。
 * @author ddj 2026年09月30号
 * @param ctx DSH 上下文
 * @param cwd 工作区
 * @returns 文件身份或 null
 */
async function sourceStat(ctx: Ctx, cwd: string): Promise<string | null> {
  const fs = ctx.get('fs')
  if (!fs) throw new Error('无法核验旧 sidecar：缺少 fs')
  const info = await fs.stat(await fs.resolve(SIDECAR, { cwd }))
  if (!info) return 'absent'
  const version = info.version ?? info.rev
  return typeof version === 'string' && version.length ? version : null
}

/**
 * 首次读取旧文件全文确认数据库来源，后续只在 stat 版本变动时重新核验。
 * @author ddj 2026年09月30号
 * @param ctx DSH 上下文
 * @param cwd 工作区
 */
async function checkSource(ctx: Ctx, cwd: string): Promise<void> {
  const now = await sourceStat(ctx, cwd)
  if (now !== null && sourceStats.get(cwd) === now) return
  checkActiveSource(cwd, await migrationText(ctx, cwd))
  if (now !== null) sourceStats.set(cwd, now)
}

/** 加载某工作区的记录桶（内存 Map；首次在隔离切换窗口严格迁移）。 */
export async function loadBucket(ctx: Ctx, cwd: string): Promise<Map<string, DiffRecord>> {
  const source = await migrationText(ctx, cwd)
  const map = await migrateActive(cwd, source, () => migrationText(ctx, cwd))
  await checkSource(ctx, cwd)
  for (const rec of map.values()) {
    if (rec.archived) continue
    const previous = JSON.stringify(rec)
    restoreReverts(cwd, rec)
    const committed = committedRecord(cwd, rec.callId, rec.path, rec.batch ?? null)
    if (committed) {
      rec.decisions = committed.decisions
      rec.superseded = committed.superseded
      rec.archived = true
    }
    if (JSON.stringify(rec) !== previous) commitActive(cwd, { upserts: [rec], removed: [] })
  }
  return map
}

/**
 * 仅把明确变动的记录行写入 SQLite；旧 sidecar 不再写入。
 * @author ddj 2026年09月30号
 * @param ctx DSH 上下文
 * @param cwd 工作区
 * @param recsMap 供当前调用点核对的记录桶
 * @param session 会话（保留旧 API）
 * @param changes 明确的更新和删除集合
 */
export async function saveBucket(ctx: Ctx, cwd: string, recsMap: Map<string, DiffRecord>, session?: Session, changes?: ActiveChange): Promise<void> {
  if (!changes) throw new Error('增量保存缺少变更集合')
  for (const rec of changes.upserts) if (recsMap.get(rec.callId) !== rec) throw new Error('增量记录不在工作区桶内')
  try {
    await checkSource(ctx, cwd)
    commitActive(cwd, changes)
  } catch (error) { log.error('saveBucket failed: ' + String(error)); throw error }
}

/**
 * 读取记录目标文件内容（按 path 缓存一次；缺失/过大/失败 → null/'' 占位）。
 * @author ddj 2026年08月20号
 * @param cache path → 内容（null=缺失/读取失败，''=过大跳过）
 */
export async function readForCache(ctx: Ctx, session: Session, cache: Map<string, ReadState>, path: string): Promise<ReadState> {
  const cached = cache.get(path)
  if (cached) return cached
  const fs = ctx.get('fs')
  if (!fs) { const state: ReadState = { kind: 'unavailable' }; cache.set(path, state); return state }
  try {
    const target = await resolveTarget(ctx, session, path)
    const info = await fs.stat(target)
    if (!info || info.type !== 'file') { const state: ReadState = { kind: 'missing' }; cache.set(path, state); return state }
    if ((info.size ?? 0) > READ_CAP) { const state: ReadState = { kind: 'unavailable' }; cache.set(path, state); return state }
    const state: ReadState = { kind: 'content', content: await fs.readText(target) }
    cache.set(path, state)
    return state
  } catch (error) {
    const state: ReadState = { kind: 'unavailable' }
    cache.set(path, state)
    return state
  }
}

/**
 * 判断记录是否已无任何可操作差异（stale）：待决策 hunk 的新文本在磁盘均找不到，
 * 或新建文件已不存在，或全为空差异。满足则应由 host 自动归档。
 * @author ddj 2026年08月20号
 */
export async function recordIsStale(ctx: Ctx, session: Session, cache: Map<string, ReadState>, rec: DiffRecord): Promise<boolean> {
  if (rec.superseded === true) return true
  if (!Array.isArray(rec.hunks) || !rec.hunks.length) return true
  const state = await readForCache(ctx, session, cache, rec.path)
  if (state.kind === 'unavailable') return false
  if (state.kind === 'missing') return true
  if (rec.create === true) return false
  const pending = rec.hunks.map((_, idx) => ({ idx, hunk: preciseHunk(rec, idx), status: rec.decisions.perHunk[idx] ?? rec.decisions.call }))
    .filter((item) => item.status === 'pending' && item.hunk && !isNoopHunk(item.hunk))
  if (!pending.length) return true
  const currentFingerprint = fingerprint(state.content)
  if (rec.afterFingerprint && currentFingerprint === rec.afterFingerprint) { rec.conflict = false; return false }
  // 归一化口径对比：外部工具可能改变 BOM/行尾，内容语义未变不应判冲突
  const normalizedContent = normalizeForCompare(state.content)
  if (rec.after != null && fingerprint(normalizeForCompare(rec.after)) === fingerprint(normalizedContent)) { rec.conflict = false; return false }
  const locations = locateHunks(normalizedContent, pending.map((item) => normalizeHunk(item.hunk!)))
  if (locations.some((location) => location.matched)) { rec.conflict = false; return false }
  rec.conflict = true
  return false
}

/**
 * edrv.list 全量轮询时自动清理 stale 记录：标记 superseded 并归档，
 * 防止"幽灵差异"长期留在审查列表且无法操作。
 * @author ddj 2026年08月20号
 * @returns 自动归档条数
 */
export async function autoArchiveStale(ctx: Ctx, session: Session, cwd: string, bucket: Map<string, DiffRecord>): Promise<number> {
  const fs = ctx.get('fs')
  if (!fs) return 0
  const cache = new Map<string, ReadState>()
  const stale: DiffRecord[] = []
  for (const rec of bucket.values()) {
    if (rec.archived || rec.superseded === true) continue
    if (await recordIsStale(ctx, session, cache, rec)) stale.push(rec)
  }
  if (!stale.length) return 0
  const original = stale.map((rec) => ({ rec, at: rec.at, superseded: rec.superseded }))
  for (const r of stale) { r.superseded = true; r.at = new Date().toISOString() }
  try {
    await archiveRecords(ctx, session, cwd, bucket, stale, '差异无法定位（已被后续修改覆盖），自动归档')
  } catch (error) {
    for (const item of original) {
      if (item.rec.archived) continue
      item.rec.superseded = item.superseded
      item.rec.at = item.at
    }
    throw error
  }
  return stale.length
}

/** 读取归档 sidecar 文本（缺失/失败 → null）。 */
export async function readArchiveText(ctx: Ctx, cwd: string | null): Promise<string | null> {
  const fs = ctx.get('fs')
  if (!fs || !cwd) return null
  try {
    return await fs.readText(await fs.resolve(SIDECAR_ARCHIVE, { cwd }))
  } catch (error) {
    return null
  }
}

/** 解析归档 sidecar（损坏 → 空数组）。 */
export function parseArchive(text: string | null): ArchiveBatch[] {
  if (!text) return []
  try {
    const data = JSON.parse(text)
    if (data && typeof data === 'object' && Array.isArray(data.batches)) return data.batches as ArchiveBatch[]
  } catch (error) { /* 忽略损坏 */ }
  return []
}

/**
 * 追加归档条目（按 cwd+path+batch 合并，同 callId 去重）。
 * @author ddj 2026年09月30号
 * @param ctx DSH 上下文
 * @param cwd 工作区
 * @param entries 待归档批次
 * @param session 会话
 * @param traceId 可选诊断追踪标识；有值时输出分段耗时
 */
export async function appendArchiveEntries(ctx: Ctx, cwd: string, entries: Array<ReturnType<typeof archiveEntryFor>>, session?: Session, traceId?: string): Promise<void> {
  if (!cwd || !entries.length) return
  // #region debug log
  const started = traceId ? performance.now() : 0
  // #endregion
  try {
    await checkSource(ctx, cwd)
    const added = appendArchive(cwd, entries as unknown as ArchiveBatch[])
    // #region debug log
    try {
      if (traceId) debugRecord(ctx, cwd, `[DEBUG diffArchive] trace=${traceId} stage=done mode=sqlite entries=${entries.length} insertedBatches=${added} dbMs=${(performance.now() - started).toFixed(1)} totalMs=${(performance.now() - started).toFixed(1)}`)
    } catch { /* 诊断不可影响归档 */ }
    // #endregion
  } catch (error) {
    // #region debug log
    try {
      if (traceId) debugRecord(ctx, cwd, `[DEBUG diffArchive] trace=${traceId} stage=error mode=sqlite totalMs=${(performance.now() - started).toFixed(1)}`)
    } catch { /* 诊断不可影响归档 */ }
    // #endregion
    log.error('appendArchiveEntries failed: ' + String(error))
    throw error
  }
}

/**
 * 归档记录：标记 archived、按批次写入归档、落盘工作区桶。
 * @author ddj 2026年09月30号
 * @param ctx DSH 上下文
 * @param session 会话
 * @param cwd 工作区
 * @param bucket 当前工作区记录桶
 * @param recs 待归档记录
 * @param reason 归档原因
 * @param opts deferSave 为 true 时只写归档、不落盘桶；traceId 用于可选分段计时
 */
export async function archiveRecords(
  ctx: Ctx,
  session: Session,
  cwd: string,
  bucket: Map<string, DiffRecord>,
  recs: DiffRecord[],
  reason: string,
  opts?: { deferSave?: boolean; traceId?: string; changed?: DiffRecord[] },
): Promise<void> {
  if (!recs.length) return
  const fresh = recs.filter((r) => !r.archived)
  const byFile = new Map<string, DiffRecord[]>()
  for (const rec of recs) {
    const key = JSON.stringify([rec.path, Number.isInteger(rec.batch) ? rec.batch : null])
    const list = byFile.get(key) ?? []
    list.push(rec)
    byFile.set(key, list)
  }
  const entries = [...byFile.values()].map((list) => archiveEntryFor(list, cwd, reason))
  const changed = new Map((opts?.changed ?? []).map((rec) => [rec.callId, rec]))
  for (const rec of recs) changed.set(rec.callId, rec)
  const start = opts?.traceId ? performance.now() : 0
  await checkSource(ctx, cwd)
  const original = recs.map((rec) => rec.archived)
  for (const rec of recs) rec.archived = true
  try {
    const added = commitActive(cwd, { upserts: [...changed.values()], removed: [] }, entries as unknown as ArchiveBatch[])
    // #region debug log
    try {
      if (opts?.traceId) debugRecord(ctx, cwd, `[DEBUG diffArchive] trace=${opts.traceId} stage=done mode=sqlite entries=${entries.length} insertedBatches=${added} dbMs=${(performance.now() - start).toFixed(1)} totalMs=${(performance.now() - start).toFixed(1)}`)
    } catch { /* 诊断不可影响归档 */ }
    // #endregion
  } catch (error) {
    recs.forEach((rec, idx) => { rec.archived = original[idx] })
    throw error
  }
  if (fresh.length && !opts?.deferSave) return
}
