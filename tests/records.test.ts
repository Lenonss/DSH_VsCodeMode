/**
 * client state/records.ts 纯函数测试。
 * 覆盖：summarize / pendingCount / isRecPending / noopHunk / statusAt / callIdAttr。
 * 作者 ddj 2026-08-20
 */
import { describe, expect, it } from 'vitest'
import type { RecordView } from '../src/shared/types.js'
import {
  callIdAttr,
  isRecPending,
  noopHunk,
  pendingCount,
  statusAt,
  summarize,
} from '../src/client/state/records.js'

function rec(partial: Partial<RecordView>): RecordView {
  return {
    callId: 'c1',
    toolName: 'edit',
    path: '/ws/a.ts',
    beforeLen: 3,
    create: false,
    callHunk: null,
    hunks: [{ oldText: 'a', newText: 'b' }],
    decisions: { call: 'pending', perHunk: ['pending'] },
    note: null,
    superseded: false,
    at: '2026-08-20T00:00:00.000Z',
    ...partial,
  }
}

describe('statusAt / noopHunk / callIdAttr', () => {
  it('statusAt 取 perHunk 或 call', () => {
    expect(statusAt(rec({ decisions: { call: 'pending', perHunk: ['rejected'] } }), 0)).toBe('rejected')
    expect(statusAt(rec({ decisions: { call: 'accepted', perHunk: [] } }), 0)).toBe('accepted')
    expect(statusAt(undefined, 0)).toBe('pending')
  })
  it('noopHunk 识别空差异', () => {
    expect(noopHunk(rec(), { oldText: 'x', newText: 'x' })).toBe(true)
    expect(noopHunk(rec(), { oldText: 'x', newText: 'y' })).toBe(false)
    expect(noopHunk(rec({ create: true }), { oldText: 'x', newText: 'x' })).toBe(false)
  })
  it('callIdAttr 拼接', () => {
    expect(callIdAttr('abc', 2)).toBe('abc:2')
  })
})

describe('isRecPending / pendingCount', () => {
  it('superseded 不再 pending', () => {
    expect(isRecPending(rec({ superseded: true }))).toBe(false)
  })
  it('全部决策后不再 pending', () => {
    expect(isRecPending(rec({ decisions: { call: 'pending', perHunk: ['accepted'] } }))).toBe(false)
  })
  it('空差异不算 pending 处数', () => {
    const r = rec({ hunks: [{ oldText: 'x', newText: 'x' }], decisions: { call: 'pending', perHunk: ['pending'] } })
    expect(pendingCount([r])).toBe(0)
  })
  it('待处理按 hunk 计数', () => {
    const r = rec({ hunks: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }], decisions: { call: 'pending', perHunk: ['pending', 'accepted'] } })
    expect(pendingCount([r])).toBe(1)
  })
})

describe('summarize', () => {
  it('同一文件保留多条活动记录', () => {
    const result = summarize([
      rec({ callId: 'one', at: '2026-08-20T00:00:00.000Z' }),
      rec({ callId: 'two', at: '2026-08-20T00:01:00.000Z' }),
    ])
    expect(result.files).toHaveLength(1)
    expect(result.files[0].recs).toHaveLength(2)
    expect(result.files[0].pending).toBe(2)
  })

  it('按文件分组并过滤已处理', () => {
    const s = summarize([
      rec({ path: '/a', decisions: { call: 'pending', perHunk: ['pending'] } }),
      rec({ path: '/a', decisions: { call: 'pending', perHunk: ['accepted'] } }),
      rec({ path: '/b', decisions: { call: 'accepted', perHunk: ['accepted'] } }),
    ])
    expect(s.files).toHaveLength(2)
    expect(s.pendingFiles.map((f) => f.path)).toEqual(['/a'])
    expect(s.totalFiles).toBe(1)
    expect(s.pendingFiles[0].pending).toBe(1)
  })
})
