/** Raw UTF-8 evidence and patch correspondence; never reconstructs a historical file from disk. @author ddj 2026年10月27号 */
import { createHash } from 'node:crypto'
import { reviewBlocks } from './shared/reviewRegions.js'
import type { OfficialDiff } from './shared/review.js'

export interface RawReviewFile { present: boolean; bytes: string; hash: string }
export interface ReviewEvidence { before: RawReviewFile; after: RawReviewFile }
export interface RawReviewBlock { id: string; before: string; after: string; offset: number }

/** @public @author ddj 2026年10月27号 @param bytes File bytes, or null for confirmed absence. @returns Existence-sensitive immutable digest and base64. */
export function rawReviewFile(bytes: Uint8Array | null): RawReviewFile {
  const payload = bytes === null ? Buffer.alloc(0) : Buffer.from(bytes)
  return { present: bytes !== null, bytes: payload.toString('base64'), hash: createHash('sha256')
    .update(bytes === null ? 'absent:' : 'present:').update(payload).digest('hex') }
}

/** @private @author ddj 2026年10月27号 @param file Persisted raw image. @returns UTF-8 storage text preserving BOM and terminators. @throws Binary, invalid encoding or corrupt hash. */
function rawText(file: RawReviewFile): string {
  const bytes = Buffer.from(file.bytes, 'base64')
  if (bytes.length > 8 * 1024 * 1024 || bytes.includes(0)) throw new Error('回滚证据不是受支持的 UTF-8 文本')
  if (rawReviewFile(file.present ? bytes : null).hash !== file.hash) throw new Error('回滚证据哈希不匹配')
  // ignoreBOM=true retains the BOM codepoint, allowing byte-identical writeText.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('回滚证据无法字节往返')
  return text
}

/** @private @author ddj 2026年10月27号 @param text Storage text. @returns Physical lines, retaining each original line ending and excluding BOM. */
function rawLines(text: string): string[] {
  const body = text.replace(/^\uFEFF/, '')
  return body.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter((line, index, lines) => line !== '' || index !== lines.length - 1) ?? []
}

/** @private @author ddj 2026年10月27号 @param lines Physical storage lines. @returns Official logical-line comparison basis. */
function logical(lines: string[]): string[] { return lines.map((line) => line.replace(/(?:\r\n|\r|\n)$/, '')) }

/** @public @author ddj 2026年10月27号 @param diff Official source. @param evidence Independent raw captures. @returns Exact raw segments only when every official hunk reproduces the entire captured result. @throws Incomplete chain, coarse patch or mismatched context/content. */
export function evidenceBlocks(diff: OfficialDiff, evidence: ReviewEvidence): RawReviewBlock[] {
  if (diff.kind !== 'text' || diff.coarse) throw new Error('该官方差异没有可靠文本基线')
  if (diff.before !== evidence.before.present || diff.after !== evidence.after.present) throw new Error('文件存在性证据不一致')
  const beforeText = rawText(evidence.before), afterText = rawText(evidence.after)
  const before = rawLines(beforeText), after = rawLines(afterText)
  const expected = logical(before)
  let delta = 0
  for (const hunk of diff.hunks) {
    const old = hunk.lines.filter((line) => line[0] === ' ' || line[0] === '-').map((line) => line.slice(1))
    const next = hunk.lines.filter((line) => line[0] === ' ' || line[0] === '+').map((line) => line.slice(1))
    if (old.length !== hunk.oldLines || next.length !== hunk.newLines) throw new Error('官方差异行数不一致')
    const position = Math.max(0, hunk.oldStart - 1) + delta
    if (JSON.stringify(expected.slice(position, position + old.length)) !== JSON.stringify(old)) throw new Error('原始基线与官方上下文不一致')
    expected.splice(position, old.length, ...next)
    delta += next.length - old.length
  }
  if (JSON.stringify(expected) !== JSON.stringify(logical(after))) throw new Error('采集链未覆盖全部官方变更')
  if (!diff.hunks.length && beforeText !== afterText) throw new Error('官方没有提供可撤销的变更块')
  const blocks = reviewBlocks(diff)
  const segments = blocks.map((block) => ({ id: block.id,
    before: before.slice(block.oldStart - 1, block.oldStart - 1 + block.oldLines.length).join(''),
    after: after.slice(block.newStart - 1, block.newStart - 1 + block.newLines.length).join(''),
    offset: (afterText.startsWith('\uFEFF') ? 1 : 0) + after.slice(0, block.newStart - 1).join('').length }))
  let reversed = afterText
  for (const segment of [...segments].reverse()) reversed = reversed.slice(0, segment.offset) + segment.before + reversed.slice(segment.offset + segment.after.length)
  if (reversed !== beforeText) throw new Error('官方变更外的 BOM、行尾或末尾换行发生变化，证据不足')
  return segments
}

/** @public @author ddj 2026年10月27号 @param evidence Raw original images. @returns Exact before and after UTF-8 storage text for guarded writes. */
export function evidenceText(evidence: ReviewEvidence): { before: string; after: string } {
  return { before: rawText(evidence.before), after: rawText(evidence.after) }
}
