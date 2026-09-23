/**
 * dsh-vscode-mode client — 记录/差异状态纯函数（可单测）。
 * 迁移自原 src/client/index.ts 前段，语义一字不改。
 * 作者 ddj 2026-08-20
 */
import type { CallHunk, Hunk, RecordView } from '../../shared/types.js'
import { preciseHunk } from '../../shared/diff.js'

/** 差异决策状态。 */
export const ST = { PENDING: 'pending', ACCEPTED: 'accepted', REJECTED: 'rejected' } as const
export type Status = 'pending' | 'accepted' | 'rejected'

/** 记录视图摘要（按文件分组）。 */
export interface FileSummary {
  /** 功能路径（分组/打开口径，恒为记录 path）。 */
  path: string
  /** 展示标签：远程工作区为远端路径，其余等于 path（issue #7）。 */
  label: string
  recs: RecordView[]
  pending: number
}
export interface Summary {
  files: FileSummary[]
  pendingFiles: FileSummary[]
  totalFiles: number
}

/** hunk 的 DOM 定位 key（callId:idx）。 */
export function callIdAttr(callId: string, idx: number): string {
  return String(callId) + ':' + String(idx)
}

/** 某 hunk 的当前决策状态（缺省 pending）。 */
export function statusAt(rec: RecordView | undefined, idx: number): Status {
  if (!rec) return ST.PENDING
  if (Array.isArray(rec.decisions?.perHunk) && rec.decisions.perHunk[idx] !== undefined) return rec.decisions.perHunk[idx] as Status
  return (rec.decisions?.call as Status) ?? ST.PENDING
}

/** hunk 是否为空差异（old===new，无实际内容变化，不可操作）。create 记录不视为空差异。 */
export function noopHunk(rec: RecordView | undefined, h: Hunk | CallHunk | null | undefined): boolean {
  if (!rec || rec.create === true) return false
  const precise = rec && h && rec.hunks.indexOf(h as Hunk) >= 0
    ? preciseHunk(rec, rec.hunks.indexOf(h as Hunk))
    : h
  const oldText = precise?.oldText ?? null
  const newText = precise?.newText ?? null
  return oldText !== null && oldText === newText
}

/** 记录是否仍有待处理差异（superseded / 全部已决策 = false）。 */
export function isRecPending(rec: RecordView): boolean {
  if (!rec || rec.superseded === true) return false
  const perHunk = Array.isArray(rec.decisions?.perHunk) ? rec.decisions.perHunk : []
  if (perHunk.length) {
    // 只认存在至少一个"非空差异且未决策"的 hunk
    for (let i = 0; i < perHunk.length; i++) {
      if (perHunk[i] !== 'accepted' && perHunk[i] !== 'rejected' && !noopHunk(rec, (rec.hunks || [])[i])) return true
    }
    return false
  }
  return rec.decisions.call === 'pending' || rec.decisions.call === undefined
}

/** 记录待处理差异"处"数（按 hunk，跳过空差异）。 */
export function pendingCount(recs: RecordView[]): number {
  let n = 0
  for (const rec of recs) {
    if (!isRecPending(rec)) continue
    const perHunk = Array.isArray(rec.decisions?.perHunk) ? rec.decisions.perHunk : []
    if (perHunk.length) {
      for (let i = 0; i < perHunk.length; i++) {
        if (perHunk[i] === 'pending' && !noopHunk(rec, (rec.hunks || [])[i])) n++
      }
    } else {
      const hunks = Array.isArray(rec.hunks) ? rec.hunks : []
      for (const h of hunks) if (!noopHunk(rec, h)) n++
      if (!hunks.length && !noopHunk(rec, rec.callHunk)) n = Math.max(n, 1)
    }
  }
  return n
}

/** 按文件分组的差异摘要（角标/Launcher 用）。 */
export function summarize(records: RecordView[]): Summary {
  const byPath = new Map<string, RecordView[]>()
  for (const r of records) {
    if (!byPath.has(r.path)) byPath.set(r.path, [])
    byPath.get(r.path)!.push(r)
  }
  const files: FileSummary[] = []
  for (const [path, recs] of byPath) {
    const label = recs.find((r) => !!r.displayPath)?.displayPath ?? path
    files.push({ path, label, recs, pending: pendingCount(recs) })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1))
  const pendingFiles = files.filter((f) => f.pending > 0)
  return { files, pendingFiles, totalFiles: pendingFiles.length }
}
