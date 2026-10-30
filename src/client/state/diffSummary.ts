/** Source-aware metadata projection; official patches never become legacy hunks. @author ddj 2026年10月26号 */
import { PENDING_PREFIX } from '../../shared/pendingReview.js'
import type { ReviewPage } from '../../shared/review.js'
import type { RecordView } from '../../shared/types.js'
import type { FileSummary, Summary } from './records.js'
import { summarize } from './records.js'

export interface DiffFile extends FileSummary {
  sourceKind: 'official' | 'legacy' | 'pending'
  /** 待审行的增删行数；官方汇总行可能缺省。 */
  added?: number
  /** 待审行的删除行数。 */
  deleted?: number
}
export interface DiffSummary extends Summary { files: DiffFile[]; pendingFiles: DiffFile[] }

/** @public @author ddj 2026年10月26号 @param path Functional local or remote identity. @returns Comparison key without rewriting remote case. */
export function diffPathKey(path: string): string {
  if (/^[a-z]+:\/\//i.test(path)) return path
  const normalized = path.replace(/\\/g, '/')
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized
}

/** @public @author ddj 2026年10月26号 @param path Current editor file. @param page Authoritative metadata, including decided paths. @returns Whether legacy actions must be hidden for this file. */
export function officialPath(path: string, page: ReviewPage | null): boolean {
  const key = diffPathKey(path)
  return !!page?.overview?.coveredPaths.some((candidate) => diffPathKey(candidate) === key)
}

/**
 * @author ddj 2026年10月30号
 * @description: 取出本页待审条目（id 带待审前缀）并折算成文件行。
 * @param page 审查页
 * @returns 待审文件行与它们覆盖的路径键
 */
function pendingRowsOf(page: ReviewPage | null): { rows: DiffFile[]; covered: Set<string> } {
  const rows: DiffFile[] = []
  const covered = new Set<string>()
  for (const item of page?.items ?? []) {
    if (!item.id.startsWith(PENDING_PREFIX)) continue
    const path = item.currentPath || item.path
    covered.add(diffPathKey(path))
    rows.push({
      path,
      label: item.display || path,
      recs: [],
      pending: item.decision === 'pending' ? 1 : 0,
      added: item.added,
      deleted: item.deleted,
      sourceKind: 'pending',
    })
  }
  return { rows, covered }
}

/** @public @author ddj 2026年10月26号 @param records Tool-call history. @param page Official file navigation, never only its first 50 rows. @returns Pending first, then official; legacy paths remain explicitly labelled. */
export function diffSummary(records: RecordView[], page: ReviewPage | null): DiffSummary {
  const pending = pendingRowsOf(page)
  // 同一路径只留一个权威：待审接管后，官方汇总行与历史留痕行都让位。
  const legacy = summarize(records.filter((record) => !pending.covered.has(diffPathKey(record.path)) && !officialPath(record.path, page)))
  const files: DiffFile[] = [...pending.rows]
  for (const file of page?.overview?.files ?? []) {
    if (pending.covered.has(diffPathKey(file.path))) continue
    files.push({ ...file, recs: [] })
  }
  for (const file of legacy.files) files.push({ ...file, sourceKind: 'legacy' })
  const pendingFiles = files.filter((file) => file.pending > 0)
  return { files, pendingFiles, totalFiles: pendingFiles.length }
}
