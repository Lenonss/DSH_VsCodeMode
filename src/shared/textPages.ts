/** Bounded, read-only text paging protocol. @author ddj 2026年10月22号 */
export const TEXT_PAGE_BYTES = 256 * 1024
export const TEXT_VIEW_BYTES = 8 * 1024 * 1024
export const TEXT_VIEW_LINES = 50_000

export interface TextPageArgs {
  sessionId?: string
  path: string
  cursor?: string
}

export type TextPageResult = {
  ok: true
  text: string
  version: string
  /** Absolute byte offset following this page, including the initial BOM. */
  offset: number
  size: number
  eof: boolean
  nextCursor: string | null
  encoding: 'utf-8'
  /** True when this non-final page ends in the middle of a logical line. */
  partialLine: boolean
} | {
  ok: false
  reason: 'unsupported' | 'invalid-cursor' | 'stale' | 'not-text' | 'read-failed'
  error: string
}
