/** Source-aware metadata projection; official patches never become legacy hunks. @author ddj 2026年10月26号 */
import type { ReviewPage } from '../../shared/review.js'
import type { RecordView } from '../../shared/types.js'
import type { FileSummary, Summary } from './records.js'
import { summarize } from './records.js'

export interface DiffFile extends FileSummary { sourceKind: 'official' | 'legacy' }
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

/** @public @author ddj 2026年10月26号 @param records Tool-call history. @param page Official file navigation, never only its first 50 rows. @returns Official-first file counts; legacy paths remain explicitly labelled. */
export function diffSummary(records: RecordView[], page: ReviewPage | null): DiffSummary {
  const legacy = summarize(records.filter((record) => !officialPath(record.path, page)))
  const files: DiffFile[] = (page?.overview?.files ?? []).map((file) => ({ ...file, recs: [] }))
  for (const file of legacy.files) files.push({ ...file, sourceKind: 'legacy' })
  const pendingFiles = files.filter((file) => file.pending > 0)
  return { files, pendingFiles, totalFiles: pendingFiles.length }
}
