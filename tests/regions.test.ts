/**
 * client state/regions.ts 纯函数测试。
 * 覆盖：diffRegions（create/普通 edit/stale）+ trimCommonLines + countLinesBefore。
 * 作者 ddj 2026-08-20
 */
import { describe, expect, it } from 'vitest'
import type { RecordView } from '../src/shared/types.js'
import { annotateHunks, fingerprint } from '../src/shared/diff.js'
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
    // stale 区域仍是 pending：需纳入单文件 Keep/Undo 的作用域，否则永久留在待处理列表
    expect(regs[0].status).toBe('pending')
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
  it('CRLF content 中 LF hunk 归一化后仍能定位（不误标 stale）', () => {
    const r = rec({ hunks: [{ oldText: 'x', newText: 'AAA' }], decisions: { call: 'pending', perHunk: ['pending'] } })
    const regs = diffRegions([r], 'line1\r\nAAA\r\nline3')
    expect(regs[0].stale).toBeUndefined()
    expect(regs[0].start).toBe(2)
    expect(regs[0].newLines).toEqual(['AAA'])
  })
  it('BOM + CRLF content 归一化后定位与行号正确', () => {
    const r = rec({ hunks: [{ oldText: 'x', newText: 'AAA' }], decisions: { call: 'pending', perHunk: ['pending'] } })
    const regs = diffRegions([r], '\uFEFFline1\r\nAAA\r\nline3')
    expect(regs[0].stale).toBeUndefined()
    expect(regs[0].start).toBe(2)
  })
  it('CRLF create 记录整文件区域行号基于归一化文本', () => {
    const r = rec({ create: true, hunks: [{ oldText: null, newText: 'line1\nline2' }], decisions: { call: 'pending', perHunk: ['pending'] } })
    const regs = diffRegions([r], 'line1\r\nline2')
    expect(regs[0].whole).toBe(true)
    expect(regs[0].end).toBe(3)
    expect(regs[0].newLines).toEqual(['line1', 'line2'])
  })
  it('多块分散于 CRLF/BOM 文件时保持归一化行号', () => {
    const r = rec({ hunks: [
      { oldText: 'old1', newText: 'MARK1' },
      { oldText: 'old2', newText: 'MARK2' },
      { oldText: 'old3', newText: 'MARK3' },
    ], decisions: { call: 'pending', perHunk: ['pending', 'pending', 'pending'] } })
    const regs = diffRegions([r], '\uFEFFfirst\r\nMARK1\r\nthird\r\nMARK2\r\nfifth\r\nMARK3')
    expect(regs.map(({ start, stale }) => [start, stale])).toEqual([[2, undefined], [4, undefined], [6, undefined]])
  })
  it('旧记录无快照时不把当前行号伪装成旧号', () => {
    expect(diffRegions([rec({})], 'first\nb')[0].oldStart).toBeUndefined()
  })
  it('原快照复原并计入前块行数变化和公共前缀，当前文件插行不影响原号', () => {
    const before = 'head\nold1\nold2\ncontext\nold3\ntail'
    const after = 'head\nnew1\ncontext\nnew3\ntail'
    const hunks = annotateHunks([
      { oldText: 'old1\nold2', newText: 'new1' },
      { oldText: 'context\nold3', newText: 'context\nnew3' },
    ], before, after)
    const regs = diffRegions([rec({ after, hunks, baseFingerprint: fingerprint(before) })], 'inserted\n' + after)
    expect(regs.map((r) => [r.start, r.oldStart])).toEqual([[3, 2], [5, 5]])
  })
  it('纯删除保留精确删除点，不制造空新增行；原号来自反向验证', () => {
    const before = 'head\ngone\ntail'
    const after = 'head\ntail'
    const hunks = annotateHunks([{ oldText: 'gone\n', newText: '' }], before, after)
    const regs = diffRegions([rec({ after, hunks, baseFingerprint: fingerprint(before) })], after)
    expect(regs[0]).toMatchObject({ start: 2, end: 2, oldStart: 2, newLines: [] })
    expect(regs[0].stale).toBeUndefined()
  })
  it('BOM/CRLF 纯删除坐标归一化，旧行号仍正确', () => {
    const before = '\uFEFFhead\r\ngone\r\ntail'
    const after = '\uFEFFhead\r\ntail'
    const hunks = annotateHunks([{ oldText: 'gone\r\n', newText: '' }], before, after)
    const regs = diffRegions([rec({ after, hunks, baseFingerprint: fingerprint(before) })], after)
    expect(regs[0]).toMatchObject({ start: 2, oldStart: 2, newLines: [] })
    expect(regs[0].oldLines).toEqual(['gone'])
  })
  it('指纹冲突/不完整快照不显示猜测旧号', () => {
    const before = 'a'
    const after = 'b'
    const hunks = annotateHunks([{ oldText: before, newText: after }], before, after)
    expect(diffRegions([rec({ after, hunks, baseFingerprint: fingerprint('wrong') })], after)[0].oldStart).toBeUndefined()
    expect(diffRegions([rec({ after: 'missing', hunks })], after)[0].oldStart).toBeUndefined()
  })
  it('没有原指纹时只接受每块均验证过的精确坐标', () => {
    const after = 'head\nb'
    const hunks = annotateHunks([{ oldText: 'a', newText: 'b' }], 'head\na', after)
    expect(diffRegions([rec({ after, hunks })], after)[0].oldStart).toBe(2)
    expect(diffRegions([rec({ after })], after)[0].oldStart).toBeUndefined()
  })
  it('纯删除快照改变后不复用可能错位的旧删除点', () => {
    const before = 'head\ngone\ntail'
    const after = 'head\ntail'
    const hunks = annotateHunks([{ oldText: 'gone\n', newText: '' }], before, after)
    const regs = diffRegions([rec({ after, hunks })], 'inserted\n' + after)
    expect(regs[0].stale).toBe(true)
  })
  it('content 为 null 返回空', () => {
    expect(diffRegions([rec()], null)).toHaveLength(0)
  })
})
