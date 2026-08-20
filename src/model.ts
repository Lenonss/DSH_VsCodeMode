/**
 * dsh-vscode-mode host — 纯域逻辑（无 ctx/fs/IO 依赖，可直接单测）。
 * 迁移自原 src/index.ts 的纯函数部分，语义一字不改。
 * 作者 ddj 2026-08-20
 */
import type { Decision, DiffRecord, Hunk, RecordSummary } from './shared/types.js'

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
    ? (r.hunks as unknown[]).filter((h) => h && typeof (h as { newText?: unknown }).newText === 'string') as Hunk[]
    : []
  const toolName: DiffRecord['toolName'] = r.toolName === 'write' ? 'write' : 'edit'
  return {
    callId: r.callId,
    toolName,
    path: r.path,
    before: typeof r.before === 'string' ? r.before : null,
    create: r.create === true,
    callHunk: r.callHunk && typeof (r.callHunk as { oldText?: unknown }).oldText === 'string'
      ? { oldText: (r.callHunk as { oldText: string }).oldText, newText: (r.callHunk as { newText: string }).newText }
      : null,
    hunks: hunks.map((h) => ({ oldText: typeof h.oldText === 'string' ? h.oldText : null, newText: h.newText })),
    decisions: r.decisions && typeof r.decisions === 'object'
      ? r.decisions as DiffRecord['decisions']
      : { call: 'pending', perHunk: hunks.map(() => 'pending' as Decision) },
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
  const perHunk = Array.isArray(record.decisions.perHunk) ? record.decisions.perHunk : []
  if (perHunk.length) return perHunk.every((v) => v === 'accepted' || v === 'rejected')
  return record.decisions.call === 'accepted' || record.decisions.call === 'rejected'
}

/**
 * 记录决策摘要（采纳/拒绝/待处理计数，superseded 标记）。
 * @author ddj 2026年08月20号
 * @param record 记录
 * @returns 摘要
 */
export function recSummary(record: DiffRecord): RecordSummary {
  const perHunk = Array.isArray(record.decisions.perHunk) ? record.decisions.perHunk : []
  const n = Math.max(1, Array.isArray(record.hunks) ? record.hunks.length : 1)
  let accepted = 0
  let rejected = 0
  let pending = 0
  if (perHunk.length) {
    for (const v of perHunk) {
      if (v === 'accepted') accepted++
      else if (v === 'rejected') rejected++
      else pending++
    }
  } else if (record.decisions.call === 'accepted') accepted = n
  else if (record.decisions.call === 'rejected') rejected = n
  else pending = n
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
  const pending: Array<{ rec: DiffRecord; idx: number }> = []
  for (const rec of records) {
    const perHunk = Array.isArray(rec.decisions.perHunk) ? rec.decisions.perHunk : []
    for (let i = 0; i < rec.hunks.length; i++) {
      const st = perHunk.length ? perHunk[i] : rec.decisions.call
      if (st === 'pending') pending.push({ rec, idx: i })
    }
  }
  pending.sort((a, b) => (a.rec.at < b.rec.at ? 1 : a.rec.at > b.rec.at ? -1 : 0))
  let out = content
  const stale: Array<{ callId: string; idx: number }> = []
  for (const p of pending) {
    const h = p.rec.hunks[p.idx]
    const precise = p.rec.toolName === 'edit' && p.rec.hunks.length <= 1 && p.rec.callHunk ? p.rec.callHunk : h
    const newText = precise.newText ?? ''
    const at = out.indexOf(newText)
    if (at < 0) { stale.push({ callId: p.rec.callId, idx: p.idx }); continue }
    const oldText = precise.oldText === null ? '' : precise.oldText
    out = out.slice(0, at) + oldText + out.slice(at + newText.length)
  }
  return { content: out, stale }
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
      superseded: r.superseded === true,
      batch: Number.isInteger(r.batch) ? r.batch : null,
      at: r.at,
      summary: recSummary(r),
    })),
  }
}
