/**
 * dsh-vscode-mode host — 纯域逻辑（无 ctx/fs/IO 依赖，可直接单测）。
 * 迁移自原 src/index.ts 的纯函数部分，语义一字不改。
 * 作者 ddj 2026-08-20
 */
import type { Decision, DiffRecord, Hunk, RecordSummary } from './shared/types.js'
import { applyLocations, fingerprint, isNoopHunk, locateHunks, normalizeForCompare, normalizeHunk, preciseHunk } from './shared/diff.js'

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
  // 白名单保留已知工具名，未知/缺失回退 'edit'（旧 sidecar 语义不变）
  const toolName: DiffRecord['toolName'] = r.toolName === 'write' || r.toolName === 'remote_ssh_write' ? r.toolName : 'edit'
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

// #region 过程抵消

/**
 * @public
 * @author ddj 2026年10月10号
 * 判断记录是否完全未决策；缺少逐块状态时沿用 pending 的 call 状态。
 * @param record 审查记录
 * @returns 未归档、未覆盖且没有用户决策时为 true
 */
export function fullyPending(record: DiffRecord): boolean {
  return !record.archived && !record.superseded && record.decisions.call === 'pending'
    && record.decisions.perHunk.every((value) => value === 'pending')
}

/**
 * @public
 * @author ddj 2026年10月10号
 * 比较整组 hunk 是否逐块精确逆反；不把新建或纯 no-op 当作抵消。
 * @param prior 先前修改的差异块
 * @param later 后续修改的差异块
 * @returns 文本归一化后整组逆反且包含真实修改时为 true
 */
export function hunksInverse(prior: Hunk[], later: Hunk[]): boolean {
  if (!prior.length || prior.length !== later.length) return false
  let changed = false
  for (let idx = 0; idx < prior.length; idx++) {
    const a = normalizeHunk(prior[idx])
    const b = normalizeHunk(later[idx])
    if (a.oldText !== b.newText || a.newText !== b.oldText) return false
    if (!isNoopHunk(a)) changed = true
  }
  return changed
}

/**
 * @private
 * @author ddj 2026年10月10号
 * 同路径优先按捕获批次排序；旧记录仅使用有效时间，不拿 callId 伪造先后证据。
 * @param a 第一条记录
 * @param b 第二条记录
 * @returns 负数表示 a 更早，零表示先后无法区分
 */
function recordOrder(a: DiffRecord, b: DiffRecord): number {
  if (a.path !== b.path) return a.path.localeCompare(b.path)
  if (Number.isInteger(a.batch) && Number.isInteger(b.batch)
    && a.batch > 0 && b.batch > 0 && a.batch !== b.batch) return a.batch - b.batch
  const delta = Date.parse(a.at) - Date.parse(b.at)
  return Number.isFinite(delta) ? delta : 0
}

/**
 * @private
 * @author ddj 2026年10月10号
 * 确认完整文件快照往返，防止相同文本在不同位置的反向修改被误隐藏。
 * @param prior 先前记录
 * @param later 后续记录
 * @returns 两端快照互换且文件存在性未变化时为 true；缺少证据时保留审查
 */
function snapshotsRestore(prior: DiffRecord, later: DiffRecord): boolean {
  if (prior.create || later.create) return false
  if (typeof prior.before !== 'string' || typeof prior.after !== 'string'
    || typeof later.before !== 'string' || typeof later.after !== 'string') return false
  return normalizeForCompare(prior.before) === normalizeForCompare(later.after)
    && normalizeForCompare(prior.after) === normalizeForCompare(later.before)
}

/**
 * @public
 * @author ddj 2026年10月10号
 * 查找最近一条未决的整记录逆反；必须有文件快照证明原内容确实恢复。
 * @param records 工作区记录（不修改输入）
 * @param record 新记录
 * @returns 可安全配对的先前记录，证据不足或部分撤销时为 null
 */
export function findInversePrior(records: DiffRecord[], record: DiffRecord): DiffRecord | null {
  if (!fullyPending(record)) return null
  let found: DiffRecord | null = null
  for (const prior of records) {
    if (prior.callId === record.callId || prior.path !== record.path || !fullyPending(prior)) continue
    if (recordOrder(prior, record) >= 0 || !hunksInverse(prior.hunks, record.hunks)) continue
    if (!snapshotsRestore(prior, record)) continue
    if (!found || recordOrder(found, prior) < 0) found = prior
  }
  return found
}

/**
 * @public
 * @author ddj 2026年10月10号
 * 按捕获顺序贪心配对历史抵消记录，每条最多使用一次；桶上限为 200。
 * @param records 工作区记录（不修改输入或记录状态）
 * @returns 可以整对归档的记录对
 */
export function findCanceledPairs(records: DiffRecord[]): Array<[DiffRecord, DiffRecord]> {
  const available: DiffRecord[] = []
  const pairs: Array<[DiffRecord, DiffRecord]> = []
  const ordered = [...records].sort(recordOrder)
  for (const record of ordered) {
    const prior = findInversePrior(available, record)
    if (!prior) {
      if (fullyPending(record)) available.push(record)
      continue
    }
    pairs.push([prior, record])
    available.splice(available.indexOf(prior), 1)
  }
  return pairs
}

// #endregion

/** 文件当前最大批次号（无记录为 0）。 */
export function fileMaxBatch(records: Map<string, DiffRecord>, path: string): number {
  let m = 0
  for (const r of records.values()) {
    if (r.path === path && Number.isInteger(r.batch) && r.batch > m) m = r.batch
  }
  return m
}

/** @public @author ddj 2026年10月26号 @param map Legacy records. @param max Cache target, never a pending retention limit. */
export function prune(map: Map<string, DiffRecord>, max = MAX_RECORDS): void {
  if (map.size <= max) return
  const sorted = [...map.values()].filter((record) => record.archived && recordResolved(record))
    .sort((a, b) => (a.at < b.at ? -1 : 1))
  for (const record of sorted) {
    if (map.size <= max) break
    map.delete(record.callId)
  }
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
