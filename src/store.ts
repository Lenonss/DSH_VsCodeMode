/**
 * dsh-vscode-mode host — 存储层（sidecar 读写合并 + 归档持久化 + stale 检测）。
 * 迁移自原 src/index.ts 的 fs/ctx IO 部分，语义一字不改。
 * 作者 ddj 2026-08-20
 */
import type { ArchiveBatch, ArchiveData, DiffRecord, SidecarData } from './shared/types.js'
import type { ReadState } from './shared/diff.js'
import { fingerprint, isNoopHunk, locateHunks, preciseHunk } from './shared/diff.js'
import { archiveEntryFor, groupByBatch, normalizeRecord } from './model.js'
import { SIDECAR, SIDECAR_ARCHIVE } from './paths.js'

export { SIDECAR, SIDECAR_ARCHIVE }
export const READ_CAP = 8 * 1024 * 1024

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

/** 加载某工作区的记录桶（内存 Map；缺失 → 空）。 */
export async function loadBucket(ctx: Ctx, cwd: string): Promise<Map<string, DiffRecord>> {
  const text = await readSidecarText(ctx, cwd)
  const data = parseSidecar(text)
  const map = new Map<string, DiffRecord>()
  if (data && data.workspaces[cwd] && typeof data.workspaces[cwd].records === 'object') {
    for (const rec of Object.values(data.workspaces[cwd].records)) {
      const n = normalizeRecord(rec)
      if (n) map.set(n.callId, n)
    }
  }
  return map
}

/** 保存某工作区的记录桶（写前合并，不覆盖其他工作区）。 */
export async function saveBucket(ctx: Ctx, cwd: string, recsMap: Map<string, DiffRecord>, session?: Session): Promise<void> {
  const fs = ctx.get('fs')
  if (!fs || !cwd) return
  try {
    const target = await fs.resolve(SIDECAR, { cwd })
    const existing = parseSidecar(await readSidecarText(ctx, cwd)) ?? { version: 2, updatedAt: '', workspaces: {} } as SidecarData
    existing.workspaces[cwd] = { at: Date.now(), records: Object.fromEntries(recsMap) }
    existing.updatedAt = new Date().toISOString()
    await fs.writeText(target, JSON.stringify(existing), void 0, void 0, policyOf(ctx, session))
  } catch (error) {
    console.error('edrv saveBucket failed', error)
  }
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
  const locations = locateHunks(state.content, pending.map((item) => item.hunk!))
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
  for (const r of stale) { r.superseded = true; r.at = new Date().toISOString() }
  await archiveRecords(ctx, session, cwd, bucket, stale, '差异无法定位（已被后续修改覆盖），自动归档')
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

/** 追加归档条目（按 cwd+path+batch 合并，同 callId 去重）。 */
export async function appendArchiveEntries(ctx: Ctx, cwd: string, entries: Array<ReturnType<typeof archiveEntryFor>>, session?: Session): Promise<void> {
  const fs = ctx.get('fs')
  if (!fs || !cwd) return
  try {
    const target = await fs.resolve(SIDECAR_ARCHIVE, { cwd })
    const existing = parseArchive(await readArchiveText(ctx, cwd))
    for (const e of entries) {
      const idx = existing.findIndex((x) => x.cwd === e.cwd && x.path === e.path && x.batch === e.batch)
      if (idx >= 0) {
        const exist = existing[idx]
        const seen = new Set((exist.records || []).map((r) => r.callId))
        for (const rec of e.records) {
          if (!seen.has(String(rec.callId))) {
            exist.records.push(rec as unknown as ArchiveBatch['records'][number])
            seen.add(String(rec.callId))
          }
        }
        exist.lastAt = e.at
        exist.reason = e.reason
      } else {
        existing.push(e as unknown as ArchiveBatch)
      }
    }
    const data: ArchiveData = { version: 1, updatedAt: new Date().toISOString(), batches: existing }
    await fs.writeText(target, JSON.stringify(data), void 0, void 0, policyOf(ctx, session))
  } catch (error) {
    console.error('edrv appendArchiveEntries failed', error)
  }
}

/**
 * 归档记录：标记 archived、按批次写入归档、落盘工作区桶。
 * @param opts.deferSave 为 true 时只写归档、不落盘桶（由批量调用方统一 saveBucket 一次）
 */
export async function archiveRecords(
  ctx: Ctx,
  session: Session,
  cwd: string,
  bucket: Map<string, DiffRecord>,
  recs: DiffRecord[],
  reason: string,
  opts?: { deferSave?: boolean },
): Promise<void> {
  if (!recs.length) return
  const fresh = recs.filter((r) => !r.archived)
  for (const r of recs) r.archived = true
  const entries: Array<ReturnType<typeof archiveEntryFor>> = []
  for (const list of groupByBatch(recs).values()) entries.push(archiveEntryFor(list, cwd, reason))
  await appendArchiveEntries(ctx, cwd, entries, session)
  if (fresh.length && !opts?.deferSave) await saveBucket(ctx, cwd, bucket, session)
}
