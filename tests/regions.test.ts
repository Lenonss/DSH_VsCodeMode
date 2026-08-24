/**
 * client state/regions.ts 纯函数测试。
 * 覆盖：diffRegions（create/普通 edit/stale）+ trimCommonLines + countLinesBefore。
 * 作者 ddj 2026-08-20
 */
import { describe, expect, it } from 'vitest'
import type { RecordView } from '../src/shared/types.js'
import { countLinesBefore, diffRegions, trimCommonLines } from '../src/client/state/regions.js'

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

describe('trimCommonLines', () => {
  it('裁剪公共前缀与后缀', () => {
    const out = trimCommonLines(['same', 'old', 'same'], ['same', 'new', 'same'])
    expect(out).toEqual({ oldLines: ['old'], newLines: ['new'], shift: 1 })
  })
  it('无公共部分返回全量', () => {
    const out = trimCommonLines(['a'], ['b'])
    expect(out.shift).toBe(0)
    expect(out.oldLines).toEqual(['a'])
  })
})

describe('countLinesBefore', () => {
  it('统计换行数', () => {
    expect(countLinesBefore('ab\ncd', 3)).toBe(1)
    expect(countLinesBefore('abc', 2)).toBe(0)
  })
})

describe('diffRegions', () => {
  it('create 记录产出整文件区域', () => {
    const r = rec({ create: true, hunks: [{ oldText: null, newText: 'line1\nline2' }], decisions: { call: 'pending', perHunk: ['pending'] } })
    const regs = diffRegions([r], 'line1\nline2')
    expect(regs).toHaveLength(1)
    expect(regs[0].whole).toBe(true)
    expect(regs[0].start).toBe(1)
    expect(regs[0].end).toBe(3) // 开区间 end = start + 行数，覆盖含尾行的全部行
    expect(regs[0].create).toBe(true)
    expect(regs[0].newLines).toEqual(['line1', 'line2'])
  })
  it('空文件 create 产出仅占位、无新增行', () => {
    const r = rec({ create: true, hunks: [{ oldText: null, newText: '' }], decisions: { call: 'pending', perHunk: ['pending'] } })
    const regs = diffRegions([r], '')
    expect(regs).toHaveLength(1)
    expect(regs[0].whole).toBe(true)
    expect(regs[0].start).toBe(1)
    expect(regs[0].end).toBe(1)
    expect(regs[0].newLines).toEqual([])
  })
  it('edit 命中 newText 计算行范围', () => {
    const r = rec({ hunks: [{ oldText: 'x', newText: 'AAA' }], decisions: { call: 'pending', perHunk: ['pending'] } })
    const regs = diffRegions([r], 'line1\nAAA\nline3')
    expect(regs[0].start).toBe(2)
    expect(regs[0].end).toBe(3) // end = start + newLines.length（原语义）
    expect(regs[0].oldLines).toEqual(['x'])
    expect(regs[0].newLines).toEqual(['AAA'])
  })
  it('newText 找不到 → stale 区域', () => {
    const r = rec({ hunks: [{ oldText: 'x', newText: 'ZZZ' }], decisions: { call: 'pending', perHunk: ['pending'] } })
    const regs = diffRegions([r], 'line1\nline2')
    expect(regs[0].stale).toBe(true)
  })
  it('重复 newText 的多个 hunk 分别定位', () => {
    const r = rec({ hunks: [{ oldText: 'old1', newText: 'same' }, { oldText: 'old2', newText: 'same' }], decisions: { call: 'pending', perHunk: ['pending', 'pending'] } })
    const regs = diffRegions([r], 'same\nkeep\nsame')
    expect(regs).toHaveLength(2)
    expect(regs.map((item) => item.start)).toEqual([1, 3])
  })
  it('纯删除 hunk 不制造首行新增区域', () => {
    const r = rec({ hunks: [{ oldText: 'gone', newText: '' }], decisions: { call: 'pending', perHunk: ['pending'] } })
    const regs = diffRegions([r], 'keep')
    expect(regs[0].stale).toBe(true)
    expect(regs[0].newLines).toEqual([])
  })
  it('空差异跳过', () => {
    const r = rec({ hunks: [{ oldText: 'x', newText: 'x' }], decisions: { call: 'pending', perHunk: ['pending'] } })
    expect(diffRegions([r], 'x')).toHaveLength(0)
  })
  it('content 为 null 返回空', () => {
    expect(diffRegions([rec()], null)).toHaveLength(0)
  })
})
