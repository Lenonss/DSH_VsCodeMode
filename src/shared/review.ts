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
/**
 * @author ddj 2026年11月11号
 * @description: 文本差异；coarse 表示比较中有区域退化为整段替换——官方来源是宿主比较超时，
 * 待审来源是行差异引擎在无唯一行锚点时退化。为 true 时不作块级 Undo 依据。
 */
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
  /** 待审条目的来源徽标（如「watch · agent」）；官方行为空。 */
  sourceLabel?: string
}
export interface ReviewDetail {
  item: ReviewItem
  diff: OfficialDiff
  capturedAt: string
  blocks: import('./reviewRegions.js').ReviewBlockState[]
  /** live 缺省视为未知：只有 host 明确给出 false 时才代表会话不在本端活跃。 */
  capability: { keep: boolean; undo: boolean; reason: string; live?: boolean; confirmUndo?: boolean }
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
  /**
   * 已被待审窗口接管过的路径（含已关窗条目，路径与身份两种写法）：
   * 客户端据此压住同路径的官方概览行与旧工具记录，保证关窗后不再复活。
   */
  pendingCoveredPaths?: string[]
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
/** 批量 Keep 的一条目标：seq/revision 只参与操作幂等与审计，写入条件以库内此刻状态为准。 */
export interface KeepAllItem {
  id: string
  display: string
  seq: number
  revision: number
}
/** 批量 Keep 中被跳过的条目：跳过不是失败，条目仍留在待审列表里。 */
export interface KeepAllSkip {
  id: string
  display: string
  reason: string
}
/** 批量 Keep 的结果：completed/paths 只计真正落库的条目，error 只记录段级异常。 */
export interface KeepAllResult {
  completed: number
  total: number
  paths: string[]
  skipped: KeepAllSkip[]
  error: string
}
/** 批量 Undo 的一条目标：与单条 decide 同口径，operationId 由客户端按批次派生。 */
export interface UndoAllItem {
  id: string
  display: string
  seq: number
  revision: number
  operationId: string
}
/** 批量 Undo 的结果：遇冲突即停止并如实记录，不声称原子回滚。 */
export interface UndoAllResult {
  completed: number
  total: number
  paths: string[]
  /** 因需要显式确认而没有执行的条数（非 0 时客户端应确认后重试）。 */
  needsConfirm?: number
  error: string
}
