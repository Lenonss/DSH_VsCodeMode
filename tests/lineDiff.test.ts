/**
 * 行差异引擎测试：千行文件精准性、多 hunk 行号、重建不变式、退化边界与性能冒烟。
 * @author ddj 2026年11月11号
 */
import { describe, expect, it } from 'vitest'
import type { ReviewHunk } from '../src/shared/review.js'
import { reviewBlocks } from '../src/shared/reviewRegions.js'
import { lineHunks } from '../src/pending/lineDiff.js'
import { keepBlock, revertBlock, textDiff } from '../src/pending/hunks.js'
import { diffOf } from '../src/pending/decide.js'
import { entryFromNew } from '../src/pending/kernel.js'

/**
 * @author ddj 2026年11月11号
 * @description: 生成带重复 `end` 与空行的 Lua 风格行，模拟真实千行文件的行分布。
 * @param count 行数
 * @returns 行列表
 */
function luaSample(count: number): string[] {
  const lines: string[] = []
  for (let index = 0; index < count; index++) {
    if (index % 7 === 0) lines.push('    end')
    else if (index % 11 === 0) lines.push('')
    else lines.push(`    this:HandleEvent_${index}(arg${index})`)
  }
  return lines
}

/**
 * @author ddj 2026年11月11号
 * @description: 按 hunk 坐标把差异应用到旧行（与 reviewEvidence 同口径），并顺带校验行数。
 * @param lines 旧行列表
 * @param hunks hunk 列表
 * @returns 重建后的行列表
 */
function applyHunks(lines: string[], hunks: ReviewHunk[]): string[] {
  const result = lines.slice()
  let delta = 0
  for (const hunk of hunks) {
    const old = hunk.lines.filter((line) => line[0] === ' ' || line[0] === '-').map((line) => line.slice(1))
    const next = hunk.lines.filter((line) => line[0] === ' ' || line[0] === '+').map((line) => line.slice(1))
    expect(old.length).toBe(hunk.oldLines)
    expect(next.length).toBe(hunk.newLines)
    const at = Math.max(0, hunk.oldStart - 1) + delta
    expect(result.slice(at, at + old.length)).toEqual(old)
    result.splice(at, old.length, ...next)
    delta += next.length - old.length
  }
  return result
}

/**
 * @author ddj 2026年11月11号
 * @description: 统计 hunk 中增删行数。
 * @param hunks hunk 列表
 * @returns 增删行数
 */
function countOps(hunks: ReviewHunk[]): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line[0] === '+') added++
      else if (line[0] === '-') deleted++
    }
  }
  return { added, deleted }
}

/**
 * @author ddj 2026年11月11号
 * @description: 按旧实现口径计算裁剪公共前后缀后的中段单元格数，用于锁定回归门槛。
 * @param oldLines 旧行
 * @param newLines 新行
 * @returns 中段旧行数 × 中段新行数
 */
function middleCells(oldLines: string[], newLines: string[]): number {
  let head = 0
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++
  let tail = 0
  while (tail < oldLines.length - head && tail < newLines.length - head
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++
  return (oldLines.length - head - tail) * (newLines.length - head - tail)
}

describe('line diff precision', () => {
  it('千行文件顶部插入 + 中部改行只产出真实改动', () => {
    const oldLines = luaSample(1200)
    const newLines = oldLines.slice()
    newLines.splice(15, 0, '    this:InsertedTop()')
    newLines[1000] = `${newLines[1000]} -- changed`
    newLines.splice(newLines.length - 20, 0, '    this:InsertedBottom()')

    expect(middleCells(oldLines, newLines)).toBeGreaterThan(1_000_000)
    const diff = lineHunks(oldLines, newLines)
    const counts = countOps(diff.hunks)
    expect(diff.degraded).toBe(false)
    expect(diff.hunks).toHaveLength(3)
    expect(counts.deleted).toBeLessThanOrEqual(2)
    expect(counts.added).toBeLessThanOrEqual(4)
    expect(applyHunks(oldLines, diff.hunks)).toEqual(newLines)
  })

  it('真实历史形状（2365 → 2509 行、5.2M 单元格）不再整段替换', () => {
    const oldLines = luaSample(2365)
    const prefix = oldLines.slice(0, 25)
    const suffix = oldLines.slice(-120)
    const middle = oldLines.slice(25, oldLines.length - 120)
    const nextMiddle: string[] = []
    for (let index = 0; index < middle.length; index++) {
      nextMiddle.push(middle[index])
      if (index % 15 === 0) nextMiddle.push(`    this:Extra_${index}()`)
    }
    const dropped = new Set([50, 300, 700, 1200, 1700, 2000])
    const newLines = [...prefix, ...nextMiddle.filter((_, index) => !dropped.has(index)), ...suffix]

    // 真实历史上最坏状态：前缀 25、后缀 120、中段 2220 × 2364。
    expect(middleCells(oldLines, newLines)).toBeGreaterThan(4_000_000)
    const diff = lineHunks(oldLines, newLines)
    const counts = countOps(diff.hunks)
    expect(diff.degraded).toBe(false)
    expect(counts.deleted).toBeLessThanOrEqual(10)
    expect(counts.added).toBeGreaterThan(100)
    expect(counts.added).toBeLessThan(200)
    expect(applyHunks(oldLines, diff.hunks)).toEqual(newLines)
  })

  it('多 hunk 行号按真实消费行推进，不再每块多偏移一个上下文长度', () => {
    const oldLines = Array.from({ length: 30 }, (_, index) => `line_${index + 1}`)
    const newLines = oldLines.slice()
    newLines[4] = 'changed_5'
    newLines[19] = 'changed_20'

    const diff = lineHunks(oldLines, newLines)
    expect(diff.hunks.map((hunk) => [hunk.oldStart, hunk.newStart])).toEqual([[2, 2], [17, 17]])
    const deletedAt = diff.hunks.map((hunk) => hunk.oldStart + hunk.lines.findIndex((line) => line[0] === '-'))
    expect(deletedAt).toEqual([5, 20])
    expect(applyHunks(oldLines, diff.hunks)).toEqual(newLines)
  })

  it('分散改动逐处成块，每块只含一处真实改动', () => {
    const oldLines = luaSample(2600)
    const newLines = oldLines.slice()
    let edits = 0
    for (let index = 50; index < 2600; index += 100) {
      newLines[index] = `${newLines[index]} -- edit`
      edits++
    }

    const diff = lineHunks(oldLines, newLines)
    expect(edits).toBe(26)
    expect(diff.hunks).toHaveLength(edits)
    for (const hunk of diff.hunks) {
      const counts = countOps([hunk])
      expect([counts.deleted, counts.added]).toEqual([1, 1])
    }
    expect(applyHunks(oldLines, diff.hunks)).toEqual(newLines)
  })

  it('完全无公共行时才退化为整段替换', () => {
    const oldLines = Array.from({ length: 5000 }, (_, index) => `old_${index}`)
    const newLines = Array.from({ length: 5000 }, (_, index) => `new_${index}`)

    const diff = lineHunks(oldLines, newLines)
    expect(diff.degraded).toBe(true)
    expect(diff.hunks).toHaveLength(1)
    expect([diff.hunks[0].oldLines, diff.hunks[0].newLines]).toEqual([5000, 5000])
    expect(diff.hunks[0].lines).toHaveLength(10000)
    expect(applyHunks(oldLines, diff.hunks)).toEqual(newLines)
  })

  it('相同文件不产出 hunk，新建文件保持全新增口径', () => {
    const lines = luaSample(200)
    expect(lineHunks(lines, lines.slice())).toEqual({ hunks: [], degraded: false })

    const create = textDiff('f.ts', 'f.ts', '', 'x\n')
    expect(create.hunks).toHaveLength(1)
    expect(create.hunks[0].lines[0]).toBe('+x')

    const entry = entryFromNew({
      id: 'f.ts', path: 'f.ts', sessionId: 's1', earlierVersion: 'none', oldText: '', newText: 'x\n', updatedAt: 1,
    })
    const emptyBase = diffOf(entry, true)
    expect(emptyBase.hunks[0].oldLines).toBe(0)
    expect(emptyBase.hunks[0].lines.some((line) => line[0] === '-')).toBe(false)
  })

  it('CRLF 与 BOM 不改变差异形状', () => {
    const lf = textDiff('f.ts', 'f.ts', 'a\nb\nc\n', 'a\nB\nc\n')
    const crlf = textDiff('f.ts', 'f.ts', 'a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n')
    const bom = textDiff('f.ts', 'f.ts', '\uFEFFa\nb\nc\n', 'a\nB\nc\n')
    expect(crlf.hunks).toEqual(lf.hunks)
    expect(bom.hunks).toEqual(lf.hunks)
  })

  it('千行文件的块级 Keep / Undo 只替换真实改动行', () => {
    const oldLines = luaSample(2600)
    const newLines = oldLines.slice()
    newLines[2000] = `${newLines[2000]} -- changed`
    const oldText = oldLines.join('\n')
    const newText = newLines.join('\n')

    const blocks = reviewBlocks(textDiff('f.lua', 'f.lua', oldText, newText))
    expect(blocks).toHaveLength(1)
    expect(keepBlock(oldText, blocks[0])).toBe(newText)
    expect(revertBlock(newText, blocks[0])).toBe(oldText)
  })

  it('两万行分散改动保持精准（性能冒烟，不断言时间）', () => {
    const oldLines = luaSample(20000)
    const newLines = oldLines.slice()
    for (let index = 200; index < 20000; index += 400) newLines[index] = `${newLines[index]} -- touched`
    newLines.splice(50, 0, '    this:InsertedLine()')

    const start = performance.now()
    const diff = lineHunks(oldLines, newLines)
    const duration = performance.now() - start
    expect(diff.degraded).toBe(false)
    expect(applyHunks(oldLines, diff.hunks)).toEqual(newLines)
    console.log(`lineDiff 20k lines: hunks=${diff.hunks.length} ms=${duration.toFixed(1)}`)
  })
})
