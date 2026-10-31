/**
 * 差异总览列表口径：待审接管路径后，官方汇总行与历史留痕行都让位，同一路径只出现一次。
 * @author ddj 2026年10月30号
 */
import { describe, expect, it } from 'vitest'
import { diffSummary } from '../src/client/state/diffSummary.js'
import type { ReviewPage } from '../src/shared/review.js'
import type { RecordView } from '../src/shared/types.js'

const target = 'D:\\Work\\demo\\src\\a.ts'

/** 造一条官方页：待审条目 + 同路径官方汇总行 + 另一条纯官方行。 */
function pageOf(): ReviewPage {
  return {
    pending: 1,
    nextCursor: null,
    gaps: [],
    items: [
      {
        id: 'pending:' + target,
        sessionId: 'session-1',
        turn: 0,
        seq: 11,
        path: target,
        currentPath: target,
        display: 'src/a.ts',
        added: 3,
        deleted: 1,
        kind: 'text',
        decision: 'pending',
        revision: 1,
        current: true,
      },
    ],
    overview: {
      coveredPaths: [target],
      files: [{ sourceKind: 'official', path: target, label: 'src/a.ts', pending: 2 }],
    } as ReviewPage['overview'],
  }
}

describe('diffSummary 待审口径', () => {
  it('待审路径只出现一次，且标记为待审来源', () => {
    const summary = diffSummary([], pageOf())
    const rows = summary.files.filter((file) => file.path === target)
    expect(rows).toHaveLength(1)
    expect(rows[0].sourceKind).toBe('pending')
    expect(summary.pendingFiles.map((file) => file.path)).toEqual([target])
    expect(summary.totalFiles).toBe(1)
  })

  it('历史留痕行被待审路径压掉，不再重复计数', () => {
    const record = { path: target, callId: 'call-1', at: new Date().toISOString(), hunks: [], decisions: {} } as unknown as RecordView
    const summary = diffSummary([record], pageOf())
    expect(summary.files.filter((file) => file.path === target)).toHaveLength(1)
  })

  it('待审行是相对路径、官方行是绝对身份时，同一文件仍只算一次', () => {
    // 生产里待审条目存的是写入时的相对写法，官方导航用绝对身份：只按 path 建覆盖集会把一份改动算成两条
    const page = pageOf()
    page.items = [{ ...page.items[0]!, path: 'src/a.ts', currentPath: 'src/a.ts' }]
    const summary = diffSummary([], page)
    expect(summary.files).toHaveLength(1)
    expect(summary.files[0]!.sourceKind).toBe('pending')
    expect(summary.totalFiles).toBe(1)
  })

  it('无待审时保持原口径：官方汇总行照常出现', () => {
    const page = pageOf()
    page.items = []
    const summary = diffSummary([], page)
    expect(summary.files.map((file) => file.sourceKind)).toEqual(['official'])
    expect(summary.pendingFiles).toHaveLength(1)
  })
})
