import type { MissingReview } from '../shared/types.js'
import { splitLines } from '../shared/diff.js'

/** 缺失文件终态：文件已在磁盘删除，且没有可展示的整文件预览。 */
export interface GoneState {
  title: string
  message: string
  /** 该文件还有官方待审改动：Keep 可在差异栏结案，Undo 不可用。 */
  official: boolean
}

/**
 * @public
 * @author ddj 2026年10月31号
 * @description: 把 missingReview 的失败归并成「文件已删除」终态。只有确认删除的拒绝码才是终态；
 * 会话缺失、权限、文件重新出现等失败返回 null，调用方继续走通用加载失败（可重试、保留跨端提示）。
 * @param failure RPC 失败结果（error 必填，code 可选）
 * @returns 终态信息或 null
 */
export function goneStateOf(failure: { error?: unknown; code?: unknown } | null | undefined): GoneState | null {
  const code = failure?.code
  const official = code === 'official-covered'
  if (!official && code !== 'official-decided' && code !== 'no-records' && code !== 'no-evidence' && code !== 'too-large') return null
  const message = String(failure?.error ?? '文件已在磁盘删除').replace(/^Error:\s*/, '')
  return { title: official ? '文件已在磁盘删除 · 有官方待审改动' : '文件已在磁盘删除', message, official }
}

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
