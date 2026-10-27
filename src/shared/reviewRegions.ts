/** Official patch parsing shared by review decisions and editor display. @author ddj 2026年10月27号 */
import type { OfficialDiff, ReviewDecision } from './review.js'

export interface ReviewBlock {
  id: string
  hunkIndex: number
  oldStart: number
  newStart: number
  oldLines: string[]
  newLines: string[]
  contextBefore: string[]
  contextAfter: string[]
}
export interface ReviewBlockState { id: string; decision: ReviewDecision }
export interface ReviewRegion extends ReviewBlock {
  sourceKind: 'official'
  recordId: string
  idx: number
  status: ReviewDecision
  stale: boolean
  start?: number
  end?: number
}

/** @public @author ddj 2026年10月27号 @param diff Immutable official patch. @returns Contiguous change runs with stable source-coordinate identities. */
export function reviewBlocks(diff: OfficialDiff): ReviewBlock[] {
  if (diff.kind !== 'text') return []
  const blocks: ReviewBlock[] = []
  for (const [hunkIndex, hunk] of diff.hunks.entries()) {
    let oldLine = hunk.oldStart, newLine = hunk.newStart
    let before: string[] = []
    let current: ReviewBlock | undefined
    for (const line of hunk.lines) {
      const marker = line[0], text = line.slice(1)
      if (marker === ' ') {
        if (current) { current.contextAfter.push(text); current = undefined }
        else if (blocks.at(-1)?.hunkIndex === hunkIndex) blocks.at(-1)!.contextAfter.push(text)
        before.push(text); oldLine++; newLine++
        continue
      }
      if (marker !== '+' && marker !== '-') continue
      if (!current) {
        current = { id: `${hunkIndex}:${oldLine}:${newLine}`, hunkIndex, oldStart: oldLine, newStart: newLine,
          oldLines: [], newLines: [], contextBefore: before.slice(-3), contextAfter: [] }
        blocks.push(current); before = []
      }
      if (marker === '-') { current.oldLines.push(text); oldLine++ }
      else { current.newLines.push(text); newLine++ }
    }
  }
  return blocks
}

/** @public @author ddj 2026年10月27号 @param diff Source patch. @param recordId Official record, not a tool call. @param states Persisted per-block decisions. @param content Current editor text; null has no current-file location. @returns Regions only located by unique full contextual matches, never by guessed history line numbers. */
export function reviewRegions(diff: OfficialDiff, recordId: string, states: ReviewBlockState[], content: string | null): ReviewRegion[] {
  const lines = content === null ? null : content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
  return reviewBlocks(diff).map((block, idx) => {
    const status = states.find((state) => state.id === block.id)?.decision ?? 'pending'
    const region: ReviewRegion = { ...block, sourceKind: 'official', recordId, idx, status, stale: true }
    if (!lines) return region
    const pattern = [...block.contextBefore, ...block.newLines, ...block.contextAfter]
    if (!pattern.length) return region
    const matches: number[] = []
    for (let offset = 0; offset + pattern.length <= lines.length; offset++) {
      if (pattern.every((text, index) => lines[offset + index] === text)) matches.push(offset)
      if (matches.length > 1) break
    }
    if (matches.length !== 1) return region
    region.start = matches[0] + block.contextBefore.length + 1
    region.end = region.start + block.newLines.length
    region.stale = false
    return region
  })
}
