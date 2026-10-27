/** Official facts are immutable; review decisions never imply a disk version. @author ddj 2026年10月26号 */
export interface ChangedFile {
  path: string
  display: string
  added: number
  deleted: number
  binary?: true
  oversized?: true
}
export interface ReviewHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}
export type OfficialDiff = { kind: 'text'; path: string; display: string; before: boolean; after: boolean; hunks: ReviewHunk[]; coarse: boolean }
  | { kind: 'binary' | 'oversized'; path: string; display: string }
export interface OfficialSummary {
  turn: number
  cwd: string
  files: ChangedFile[]
  total: number
  added: number
  deleted: number
  snapshot?: { before: string; after: string }
}
export interface ReviewSnapshot {
  sourceKind: 'official'
  sessionId: string
  turn: number
  seq: number
  capturedAt: string
  summary: OfficialSummary
  files: { identity: string; diff: OfficialDiff }[]
}
export type ReviewDecision = 'pending' | 'accepted' | 'rejected'
export type ReviewFileDecision = ReviewDecision | 'mixed'
export interface ReviewItem {
  id: string
  sessionId: string
  turn: number
  seq: number
  path: string
  currentPath: string
  display: string
  added: number
  deleted: number
  kind: OfficialDiff['kind']
  decision: ReviewFileDecision
  revision: number
  current: boolean
}
export interface ReviewDetail {
  item: ReviewItem
  diff: OfficialDiff
  capturedAt: string
  blocks: import('./reviewRegions.js').ReviewBlockState[]
  capability: { keep: boolean; undo: boolean; reason: string }
}
export interface CaptureGap {
  sessionId: string
  turn: number
  seq: number
  error: string
}
export interface ReviewFile {
  sourceKind: 'official'
  path: string
  label: string
  pending: number
}
export interface ReviewOverview {
  files: ReviewFile[]
  /** Every official identity, including decided files: never revive legacy actions for them. */
  coveredPaths: string[]
}
export interface ReviewPage {
  overview?: ReviewOverview
  items: ReviewItem[]
  pending: number
  nextCursor: number | null
  gaps: CaptureGap[]
}
export interface ReviewRequest { sessionId: string }
export interface DecideReview extends ReviewRequest {
  id: string
  seq: number
  revision: number
  operationId: string
  scope?: 'file' | 'hunk'
  blockId?: string
  decision: 'accepted' | 'rejected'
}
export type ReviewResult<T> = ({ ok: true } & T) | { ok: false; error: string }
