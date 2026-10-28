/** Official patch parsing shared by review decisions and editor display. @author ddj 2026年10月27号 */
import type { OfficialDiff, ReviewDecision } from './review.js'
import { logicalLine, logicalLines } from './lineEndings.js'

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
  staleReason?: 'no-content' | 'missing' | 'ambiguous'
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
      const marker = line[0], text = logicalLine(line.slice(1))
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

/** @private @author ddj 2026年10月28号 @param lines Current logical lines. @param pattern Full block context and new lines. @returns At most two matching offsets, enough to reject ambiguity. */
function scan(lines: string[], pattern: string[]): number[] {
  const matches: number[] = []
  for (let offset = 0; offset + pattern.length <= lines.length; offset++) {
    if (pattern.every((text, index) => lines[offset + index] === text)) matches.push(offset)
    if (matches.length === 2) break
  }
  return matches
}

/** @private @author ddj 2026年10月28号 @param line Logical line. @returns Line retaining indentation but ignoring trailing whitespace for the fallback pass. */
function trimTail(line: string): string { return line.trimEnd() }

/** @private @author ddj 2026年10月28号 @param lines Current logical lines. @param pattern Full block context and new lines. @returns Unique offset or a classified failure; historical coordinates never resolve ambiguity. */
function locate(lines: string[], pattern: string[]): { offset: number } | { reason: 'missing' | 'ambiguous' } {
  if (!pattern.length) return { reason: 'missing' }
  let matches = scan(lines, pattern)

  // Only strict absence allows whitespace tolerance; blank-only patterns cannot invent a location.
  if (matches.length === 0 && pattern.some((line) => line.trimEnd().length > 0)) {
    matches = scan(lines.map(trimTail), pattern.map(trimTail))
  }
  if (matches.length === 1) return { offset: matches[0] }
  return { reason: matches.length > 1 ? 'ambiguous' : 'missing' }
}

/** @public @author ddj 2026年10月28号 @param diff Source patch. @param recordId Official record, not a tool call. @param states Persisted per-block decisions. @param content Current editor text; null has no current-file location. @returns Regions only located by unique full contextual matches, never by guessed history line numbers. */
export function reviewRegions(diff: OfficialDiff, recordId: string, states: ReviewBlockState[], content: string | null): ReviewRegion[] {
  const lines = content === null ? null : logicalLines(content)
  /** @private @author ddj 2026年10月28号 @param block Immutable logical block. @param idx Block order. @returns Decision and current location without mutating stored evidence. */
  function placeRegion(block: ReviewBlock, idx: number): ReviewRegion {
    const status = states.find((state) => state.id === block.id)?.decision ?? 'pending'
    const region: ReviewRegion = { ...block, sourceKind: 'official', recordId, idx, status, stale: true }
    if (lines === null) return { ...region, staleReason: 'no-content' }

    const location = locate(lines, [...block.contextBefore, ...block.newLines, ...block.contextAfter])
    if ('reason' in location) return { ...region, staleReason: location.reason }
    region.start = location.offset + block.contextBefore.length + 1
    region.end = region.start + block.newLines.length
    region.stale = false
    return region
  }
  return reviewBlocks(diff).map(placeRegion)
}
