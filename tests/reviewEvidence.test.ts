import { describe, expect, it } from 'vitest'
import { evidenceBlocks, evidenceText, rawReviewFile } from '../src/reviewEvidence.js'
import type { OfficialDiff } from '../src/shared/review.js'
const diff: OfficialDiff = { kind: 'text', path: 'a', display: 'a', before: true, after: true, coarse: false,
  hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' head', '-old', '+new', ' tail'] }] }
/** @private @author ddj 2026年10月27号 @param before Before bytes as UTF-8. @param after Result bytes as UTF-8. @returns Isolated raw capture pair. */
function evidence(before: string, after: string) { return { before: rawReviewFile(Buffer.from(before)), after: rawReviewFile(Buffer.from(after)) } }
describe('raw official review evidence', () => {
  it('retains BOM, mixed endings and missing EOF newline byte-for-byte', () => {
    const pair = evidence('\uFEFFhead\r\nold\ntail', '\uFEFFhead\r\nnew\ntail')
    expect(evidenceText(pair).before).toBe('\uFEFFhead\r\nold\ntail')
    expect(evidenceBlocks(diff, pair)).toEqual([{ id: '0:2:2', before: 'old\n', after: 'new\n', offset: 7 }])
  })
  it('rejects hidden line-ending changes outside official blocks and incomplete baselines', () => {
    expect(() => evidenceBlocks(diff, evidence('head\r\nold\ntail', 'head\nnew\ntail'))).toThrow('行尾')
    expect(() => evidenceBlocks(diff, evidence('head\nother\ntail', 'head\nnew\ntail'))).toThrow('基线')
    expect(() => evidenceBlocks(diff, evidence('head\nold\ntail', 'head\nnew\ntail\nextra'))).toThrow('全部')
  })
  it('keeps absence distinct from empty and rejects corrupt or invalid UTF-8 data', () => {
    expect(rawReviewFile(null).hash).not.toBe(rawReviewFile(Buffer.alloc(0)).hash)
    const pair = evidence('head\nold\ntail', 'head\nnew\ntail')
    pair.before.hash = 'wrong'
    expect(() => evidenceBlocks(diff, pair)).toThrow('哈希')
    expect(() => evidenceText({ before: rawReviewFile(Buffer.from([0xff])), after: rawReviewFile(null) })).toThrow()
  })
})
