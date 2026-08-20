/**
 * dsh-vscode-mode shared contract — the single source of truth for the
 * host↔client data shapes that cross the /edrv/rpc boundary.
 *
 * Purity rule: this module MUST NOT import node or react (or anything that
 * pulls them). It is consumed by the host (tsc/tsdown node build) and bundled
 * into the browser client (type-only imports are erased at build time).
 * 作者 ddj 2026-08-20
 */

/** 单条差异块的决策状态。 */
export type Decision = 'pending' | 'accepted' | 'rejected'

/** 一条 hunk：oldText=null 表示纯新增（create/写入场景）。 */
export interface Hunk {
  oldText: string | null
  newText: string
}

/** 单条 edit 调用的精确 old/new 串（edit 工具参数原样）。 */
export interface CallHunk {
  oldText: string
  newText: string
}

/** 记录级 + 逐 hunk 决策。 */
export interface Decisions {
  call: Decision
  perHunk: Decision[]
}

/** 审查记录（host 内部存储与传给 client 的视图共用核心字段）。 */
export interface RecordBase {
  callId: string
  toolName: 'edit' | 'write'
  path: string
  create: boolean
  callHunk: CallHunk | null
  hunks: Hunk[]
  decisions: Decisions
  note: string | null
  superseded: boolean
  at: string
}

/** host 内部完整记录（含持久化专用字段）。 */
export interface DiffRecord extends RecordBase {
  before: string | null
  archived: boolean
  batch: number
}

/** 发往 client 的记录视图（不含 before 全文，仅长度）。 */
export interface RecordView extends RecordBase {
  beforeLen: number
}

/** 归档条目内单条记录的存档视图。 */
export interface ArchiveRecord extends RecordBase {
  before: string | null
  batch: number | null
  summary: RecordSummary
}

/** 单条记录的决策摘要。 */
export interface RecordSummary {
  accepted: number
  rejected: number
  pending: number
  superseded: boolean
}

/** 归档批次聚合摘要（archiveList 轻量视图用；superseded 为被覆盖条目计数）。 */
export interface ArchiveSummary {
  accepted: number
  rejected: number
  pending: number
  superseded: number
}

/** 归档批次（sidecar .dsh-edit-review-archive.json 内一条）。 */
export interface ArchiveBatch {
  at: string
  lastAt?: string
  cwd: string
  path: string
  batch: number | null
  reason: string
  records: ArchiveRecord[]
}

/** 归档列表条目（edrv.archiveList 返回的轻量视图）。 */
export interface ArchiveEntry {
  at: string
  lastAt: string
  path: string
  batch: number | null
  reason: string | null
  nRecords: number
  summary: ArchiveSummary
}

/** edrv.original 重建结果中的 stale 差异定位。 */
export interface StaleHunk {
  callId: string
  idx: number
}

/** sidecar 主文件 v2 结构（.dsh-edit-review.json）。 */
export interface SidecarData {
  version: 2
  updatedAt: string
  workspaces: Record<string, { at: number; records: Record<string, DiffRecord> }>
}

/** 归档 sidecar v1 结构（.dsh-edit-review-archive.json）。 */
export interface ArchiveData {
  version: 1
  updatedAt: string
  batches: ArchiveBatch[]
}
