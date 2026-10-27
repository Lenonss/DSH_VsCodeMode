import { describe, expect, it } from 'vitest'
import { diffSummary, officialPath } from '../src/client/state/diffSummary.js'
import type { ReviewPage } from '../src/shared/review.js'
import type { RecordView } from '../src/shared/types.js'

/** @private @author ddj 2026年10月26号 @param path Tool identity. @returns Pending legacy fixture. */
function legacy(path: string): RecordView {
  return { callId: path, path, toolName: 'edit', create: false, callHunk: null,
    hunks: [{ oldText: 'a', newText: 'b' }], decisions: { call: 'pending', perHunk: ['pending'] },
    note: null, superseded: false, archived: false, batch: 1, at: '' }
}
const page: ReviewPage = { items: [], pending: 70, nextCursor: 50, gaps: [],
  overview: { coveredPaths: ['C:\\ws\\a.lua', 'C:\\ws\\done.lua'], files: [
    { sourceKind: 'official', path: 'C:\\ws\\a.lua', label: 'a.lua', pending: 70 },
  ] } }

describe('source-aware diff file projection', () => {
  it('counts files independently of record pagination, never constructs legacy hunks from official data', () => {
    const summary = diffSummary([legacy('c:/WS/a.lua'), legacy('c:/ws/done.lua'), legacy('/old.lua')], page)
    expect(summary.totalFiles).toBe(2)
    expect(summary.files[0]).toMatchObject({ sourceKind: 'official', pending: 70, recs: [] })
    expect(summary.files[1]).toMatchObject({ sourceKind: 'legacy', path: '/old.lua', pending: 1 })
  })
  it('decided official history still suppresses old actions and remote path case stays significant', () => {
    expect(officialPath('c:/ws/DONE.lua', page)).toBe(true)
    expect(officialPath('ssh://host/A', { ...page, overview: { files: [], coveredPaths: ['ssh://host/a'] } })).toBe(false)
    expect(diffSummary([legacy('/old.lua')], null).files[0].sourceKind).toBe('legacy')
  })
})
