import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { diffSummary, reviewPathOf } from '../src/client/state/diffSummary.js'
import { dockInLayout } from '../src/client/diffDockStore.js'
import type { ReviewDetail, ReviewPage } from '../src/shared/review.js'
import { emptyTextReview } from '../src/client/reviewBar.js'
import { textDiff } from '../src/pending/hunks.js'
import { reviewBlocks } from '../src/shared/reviewRegions.js'

const paths = ['Data/DataConfig.lua', 'Enum/ECommon.lua', 'View/CommonTaskNotificationView.lua']
/** @private @author ddj 2026年11月5号 @description 构造无官方历史的累计待审元数据。 @param count 待审文件数 @returns 隔离审查页 */
function pendingPage(count: number): ReviewPage {
  return { items: paths.slice(0, count).map((path) => ({
    id: `pending:D:\\ws\\${path.replaceAll('/', '\\')}`, sessionId: 'test', turn: 0, seq: 0,
    path, currentPath: path, display: path, added: 1, deleted: 0, kind: 'text',
    decision: 'pending', revision: 0, current: true,
  })), pending: count, nextCursor: null, gaps: [], overview: { coveredPaths: [], files: [] } }
}

/** @private @author ddj 2026年11月5号 @description 构造真实差异生成器产出的权威详情。 @param currentText 当前文本 @returns 审查详情 */
function reviewOf(currentText: string): ReviewDetail {
  const diff = textDiff(paths[0], paths[0], 'first\nsecond\n', currentText)
  return { item: { ...pendingPage(1).items[0], added: 0, deleted: 0 }, diff,
    capturedAt: '', blocks: reviewBlocks(diff).map((block) => ({ id: block.id, decision: 'pending' })),
    capability: { keep: true, undo: true, reason: '' } }
}

describe('empty text review convergence', () => {
  it('settles CRLF-only changes but preserves real text changes and final newline changes', () => {
    expect(emptyTextReview(reviewOf('first\r\nsecond\r\n'))).toBe(true)
    expect(emptyTextReview(reviewOf('first\nchanged\n'))).toBe(false)
    expect(emptyTextReview(reviewOf('first\nsecond'))).toBe(false)
  })
  it('does not settle missing details, disabled capabilities, non-text or inconsistent metadata', () => {
    const detail = reviewOf('first\r\nsecond\r\n')
    expect(emptyTextReview(null)).toBe(false)
    expect(emptyTextReview({ ...detail, capability: { ...detail.capability, keep: false } })).toBe(false)
    expect(emptyTextReview({ ...detail, item: { ...detail.item, added: 1 } })).toBe(false)
    expect(emptyTextReview({ ...detail, diff: { ...detail.diff, kind: 'binary' } } as ReviewDetail)).toBe(false)
  })
})

describe('pending-only editor dock projection', () => {
  it('uses the same resolver for detail requests and toolbar routing', () => {
    const editor = readFileSync(new URL('../src/client/ui/EditorView.ts', import.meta.url), 'utf8')
    expect(editor).toContain('const reviewPath = reviewPathOf(active, review.page, sameFile)')
    expect(editor).toContain('const officialFile = reviewPathOf(active, review.page, sameFile)')
    expect(editor).not.toContain('const officialFile = review.page?.overview?.coveredPaths.find')
  })
  it('resolves pending identity without official history and does not cross directories', () => {
    const page = pendingPage(3)
    expect(reviewPathOf(paths[0], page)).toBe(paths[0])
    expect(reviewPathOf('d:/WS/Data/DataConfig.lua', page)).toBe(paths[0])
    expect(reviewPathOf('other/DataConfig.lua', page)).toBeNull()
    expect(reviewPathOf(paths[0], null)).toBeNull()
    expect(reviewPathOf(null, page)).toBeNull()
  })
  it('retains decided official coverage and respects remote case', () => {
    const page = { ...pendingPage(0), overview: { files: [], coveredPaths: ['ssh://host/A'] } }
    expect(reviewPathOf('ssh://host/A', page)).toBe('ssh://host/A')
    expect(reviewPathOf('ssh://host/a', page)).toBeNull()
  })
  it.each(['side', 'tab'] as const)('%s hides only after all three settle and restores for new pending', (layout) => {
    for (const count of [3, 2, 1, 0, 1]) {
      const page = pendingPage(count)
      const summary = diffSummary([], page)
      expect(summary.totalFiles).toBe(count)
      expect(dockInLayout({ mode: 'editor', layout, activePath: paths[2],
        fileTotal: summary.totalFiles, allPendingCount: page.pending,
        diffTotal: 0, pendingRegions: [], staleRegions: [],
      }, layout)).toBe(count > 0)
    }
  })
})
