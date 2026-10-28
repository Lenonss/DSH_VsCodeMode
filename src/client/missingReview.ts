import type { MissingReview } from '../shared/types.js'
import { splitLines } from '../shared/diff.js'

/** @public @author ddj 2026年10月28号 @param review Frozen complete snapshot. @returns One whole-file deletion, including empty files; no invented current lines. */
export function missingRegion(review: MissingReview) {
  return {
    callId: review.callIds[0], idx: 0, start: 1, end: 1, oldStart: 1,
    oldLines: splitLines(review.content.replace(/\r\n/g, '\n')), newLines: [], whole: true,
    status: 'pending', create: false, superseded: false, sourceKind: 'missing',
  }
}

interface MissingBatchApi {
  query(path: string): Promise<{ ok: true; review: MissingReview | null } | { ok: false; error: string }>
  decide(review: MissingReview, operationId: string): Promise<{ ok: true; callIds: string[] } | { ok: false; error: string }>
  guard(): void
  operation(review: MissingReview): string
  committed(review: MissingReview, callIds: string[]): void
}

/** @public @author ddj 2026年10月28号 @param paths Batch paths. @param api Guarded Host access. @returns Missing paths handled once; a partial failure stops before legacy hunk writes. @throws Missing evidence, changed lifecycle or Host decision failure. */
export async function missingBatch(paths: string[], api: MissingBatchApi): Promise<Set<string>> {
  const candidates: MissingReview[] = []
  for (const path of new Set(paths)) {
    api.guard()
    const result = await api.query(path)
    if (!result.ok) throw new Error(result.error)
    if (result.review) candidates.push(result.review)
  }

  const completed = new Set<string>()
  for (const review of candidates) {
    api.guard()
    const result = await api.decide(review, api.operation(review))
    if (!result.ok) throw new Error(`已处理 ${completed.size} 个删除文件，其余未处理。${result.error}`)
    completed.add(review.path)
    api.committed(review, result.callIds)
  }
  return completed
}
