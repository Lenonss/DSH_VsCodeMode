/**
 * dsh-vscode-mode host — 纯域逻辑（无 ctx/fs/IO 依赖，可直接单测）。
 * 迁移自原 src/index.ts 的纯函数部分，语义一字不改。
 * 作者 ddj 2026-08-20
 */
import type { Decision, DiffRecord, Hunk, RecordSummary } from './shared/types.js'
import { applyLocations, fingerprint, isNoopHunk, locateHunks, preciseHunk } from './shared/diff.js'

/** 工作区记录桶上限（超过后按 at 最旧剔除）。 */
export const MAX_RECORDS = 200

/**
 * 归一化一条持久化记录（容忍旧版/损坏字段）。
 * @author ddj 2026年08月20号
 * @param raw 反序列化的原始记录
 * @returns 合法记录或 null
 */
export function normalizeRecord(raw: unknown): DiffRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.callId !== 'string' || typeof r.path !== 'string') return null
  const hunks: Hunk[] = Array.isArray(r.hunks)
    ? (r.hunks as unknown[]).filter((h) => h && typeof (h as { newText?: unknown }).newText === 'string').map((h) => {
      const item = h as Record<string, unknown>
      return {
        oldText: typeof item.oldText === 'string' ? item.oldText : null,
        newText: item.newText as string,
        ...(Number.isInteger(item.afterStart) ? { afterStart: item.afterStart as number } : {}),
        ...(Number.isInteger(item.afterEnd) ? { afterEnd: item.afterEnd as number } : {}),
        ...(Number.isInteger(item.beforeStart) ? { beforeStart: item.beforeStart as number } : {}),
        ...(Number.isInteger(item.beforeEnd) ? { beforeEnd: item.beforeEnd as number } : {}),
      }
    })
    : []
  const toolName: DiffRecord['toolName'] = r.toolName === 'write' ? 'write' : 'edit'
  const rawDecisions = r.decisions && typeof r.decisions === 'object' ? r.decisions as Record<string, unknown> : {}
  const call = rawDecisions.call === 'accepted' || rawDecisions.call === 'rejected' ? rawDecisions.call : 'pending'
  const rawPerHunk = Array.isArray(rawDecisions.perHunk) ? rawDecisions.perHunk : []
  const perHunk = hunks.map((_, i) => {
    const value = rawPerHunk[i]
    if (value === 'accepted' || value === 'rejected') return value
    return call === 'accepted' || call === 'rejected' ? call : 'pending'
  })
  const before = typeof r.before === 'string' ? r.before : null
  const hasAfter = Object.prototype.hasOwnProperty.call(r, 'after')
  const after = typeof r.after === 'string' ? r.after : null
  return {
    callId: r.callId,
    toolName,
    path: r.path,
    before,
    after,
    baseFingerprint: typeof r.baseFingerprint === 'string' ? r.baseFingerprint : fingerprint(before),
    afterFingerprint: typeof r.afterFingerprint === 'string' ? r.afterFingerprint : fingerprint(after),
    legacy: !hasAfter,
    conflict: r.conflict === true,
    create: r.create === true,
    callHunk: r.callHunk && typeof (r.callHunk as { oldText?: unknown }).oldText === 'string' && typeof (r.callHunk as { newText?: unknown }).newText === 'string'
      ? { oldText: (r.callHunk as { oldText: string }).oldText, newText: (r.callHunk as { newText: string }).newText }
      : null,
    hunks,
    decisions: { call: call as Decision, perHunk },
    note: typeof r.note === 'string' ? r.note : null,
    superseded: r.superseded === true,
    archived: r.archived === true,
    batch: Number.isInteger(r.batch) ? (r.batch as number) : 0,
    at: typeof r.at === 'string' ? r.at : new Date().toISOString(),
  }
}

/**
 * 写决策到记录（scope=call 整体 / hunk 单个块）。
 * @author ddj 2026年08月20号
 * @param record 记录
 * @param scope 作用域
 * @param idx hunk 下标（仅 scope=hunk 时生效）
 * @param value 决策值
 * @returns 更新后的记录（原对象就地修改）
 */
export function markDecision(record: DiffRecord, scope: string, idx: number | undefined, value: Decision): DiffRecord {
  const dec = record.decisions
  if (scope === 'hunk' && Array.isArray(dec.perHunk) && Number.isInteger(idx)) {
    const i = idx as number
    if (i >= 0 && i < dec.perHunk.length) dec.perHunk[i] = value
  } else {
    dec.call = value
    if (Array.isArray(dec.perHunk)) dec.perHunk = dec.perHunk.map(() => value)
  }
  record.at = new Date().toISOString()
  return record
}

/** 记录是否已无任何待决策差异（superseded 或全部已决策）。 */
export function recordResolved(record: DiffRecord): boolean {
  if (record.superseded === true) return true
  const hunks = Array.isArray(record.hunks) ? record.hunks : []
  const perHunk = Array.isArray(record.decisions.perHunk) ? record.decisions.perHunk : []
  const count = Math.max(hunks.length, perHunk.length)
  if (!count) return record.decisions.call === 'accepted' || record.decisions.call === 'rejected'
  for (let idx = 0; idx < count; idx++) {
    const precise = preciseHunk(record, idx)
    const value = perHunk[idx] ?? record.decisions.call
    if (isNoopHunk(precise) && value === 'pending') return false
    if (value !== 'accepted' && value !== 'rejected') return false
  }
  return true
}

/**
 * 记录决策摘要（采纳/拒绝/待处理计数，superseded 标记）。
 * @author ddj 2026年08月20号
 * @param record 记录
 * @returns 摘要
 */
export function recSummary(record: DiffRecord): RecordSummary {
  const hunks = Array.isArray(record.hunks) ? record.hunks : []
  const perHunk = Array.isArray(record.decisions.perHunk) ? record.decisions.perHunk : []
  const n = Math.max(1, hunks.length, perHunk.length)
  let accepted = 0
  let rejected = 0
  let pending = 0
  for (let i = 0; i < n; i++) {
    const hunk = preciseHunk(record, i)
    const value = perHunk[i] ?? record.decisions.call
    if (i < hunks.length && isNoopHunk(hunk) && value === 'pending') continue
    if (value === 'accepted') accepted++
    else if (value === 'rejected') rejected++
    else pending++
  }
  return { accepted, rejected, pending, superseded: record.superseded === true }
}

/**
 * 重建"本批次修改前"内容：把仍待处理（pending）的差异块按 新→旧 顺序从当前内容反解
 * （newText → oldText）。已采纳/已拒绝的块跳过。反解失败的块标记为 stale。
 * @author ddj 2026年08月20号
 * @param records 该文件的活动记录
 * @param content 当前磁盘内容
 * @returns 重建内容与 stale 定位
 */
export function reconstructOriginal(records: DiffRecord[], content: string): { content: string; stale: Array<{ callId: string; idx: number }> } {
  const pending: Array<{ rec: DiffRecord; idx: number; hunk: Hunk }> = []
  for (const rec of records) {
    for (let i = 0; i < rec.hunks.length; i++) {
      const st = rec.decisions.perHunk[i] ?? rec.decisions.call
      const hunk = preciseHunk(rec, i)
      if (st === 'pending' && hunk && !isNoopHunk(hunk)) pending.push({ rec, idx: i, hunk })
    }
  }
  pending.sort((a, b) => (a.rec.at < b.rec.at ? 1 : a.rec.at > b.rec.at ? -1 : 0))
  const locations = locateHunks(content, pending.map((item) => item.hunk))
  const rebuilt = applyLocations(content, locations, true)
  return {
    content: rebuilt.content,
    stale: rebuilt.stale.map((idx) => ({ callId: pending[idx].rec.callId, idx: pending[idx].idx })),
  }
}

/** 文件当前最大批次号（无记录为 0）。 */
export function fileMaxBatch(records: Map<string, DiffRecord>, path: string): number {
  let m = 0
  for (const r of records.values()) {
    if (r.path === path && Number.isInteger(r.batch) && r.batch > m) m = r.batch
  }
  return m
}

/** 记录桶裁剪：超出 MAX_RECORDS 时剔除最旧的。 */
export function prune(map: Map<string, DiffRecord>, max = MAX_RECORDS): void {
  if (map.size <= max) return
  const sorted = [...map.values()].sort((a, b) => (a.at < b.at ? -1 : 1))
  for (let i = 0; i < sorted.length - max; i++) map.delete(sorted[i].callId)
}

/** 按批次分组记录。 */
export function groupByBatch(recs: DiffRecord[]): Map<number | null, DiffRecord[]> {
  const map = new Map<number | null, DiffRecord[]>()
  for (const r of recs) {
    const k = Number.isInteger(r.batch) ? r.batch : null
    if (!map.has(k)) map.set(k, [])
    map.get(k)!.push(r)
  }
  return map
}

/**
 * 归档条目构造（一条批次一条）。
 * @author ddj 2026年08月20号
 * @param recs 同批次记录（非空）
 * @param cwd 工作区
 * @param reason 归档原因
 */
export function archiveEntryFor(recs: DiffRecord[], cwd: string, reason: string): {
  at: string
  cwd: string
  path: string
  batch: number | null
  reason: string
  records: Array<Record<string, unknown>>
} {
  const first = recs[0]
  return {
    at: new Date().toISOString(),
    cwd,
    path: first.path,
    batch: Number.isInteger(first.batch) ? first.batch : null,
    reason,
    records: recs.map((r) => ({
      callId: r.callId,
      toolName: r.toolName,
      path: r.path,
      create: r.create === true,
      callHunk: r.callHunk,
      hunks: r.hunks,
      decisions: r.decisions,
      note: r.note ?? null,
      before: typeof r.before === 'string' ? r.before : null,
      after: typeof r.after === 'string' ? r.after : null,
      baseFingerprint: r.baseFingerprint ?? null,
      afterFingerprint: r.afterFingerprint ?? null,
      conflict: r.conflict === true,
      legacy: r.legacy === true,
      superseded: r.superseded === true,
      batch: Number.isInteger(r.batch) ? r.batch : null,
      at: r.at,
      summary: recSummary(r),
    })),
  }
}
