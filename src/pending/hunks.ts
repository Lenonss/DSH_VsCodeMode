/**
 * 待审差异构造：把两侧全文变成官方视图复用的 hunk，并提供块级 Keep/Revert 的文本合成。
 * @author ddj 2026年10月29号
 */
import type { OfficialDiff, ReviewHunk } from '../shared/review.js'
import type { ReviewBlock } from '../shared/reviewRegions.js'
import { logicalLines } from '../shared/lineEndings.js'

/** 每个 hunk 的上下文行数。 */
const CONTEXT = 3
/** LCS 单元格上限：超过后退化为整段替换，避免大文件卡死。 */
const CELL_LIMIT = 1_000_000

/** 一行差异操作。 */
type LineOp = { kind: ' ' | '-' | '+'; text: string }

/**
 * @author ddj 2026年10月29号
 * @description: 构造可直接交给官方渲染器的差异；两侧完全相同时返回空 hunk 列表。
 * @param path 相对路径
 * @param display 展示名
 * @param oldText 基线全文
 * @param newText 当前全文
 * @returns 文本差异
 */
export function textDiff(path: string, display: string, oldText: string, newText: string): OfficialDiff {
  const hunks = buildHunks(logicalLines(oldText), logicalLines(newText))
  return { kind: 'text', path, display, before: true, after: true, hunks, coarse: hunks.length > 0 && isCoarse(oldText, newText) }
}

/**
 * @author ddj 2026年10月29号
 * @description: 块级 Keep：把该块的新内容写进基线，返回推进后的基线。
 * @param oldText 当前基线
 * @param block 目标块
 * @returns 新基线；块在当前基线中无法唯一定位时返回 null
 */
export function keepBlock(oldText: string, block: ReviewBlock): string | null {
  return spliceBlock(oldText, block.oldLines, block.newLines, block)
}

/**
 * @author ddj 2026年10月29号
 * @description: 块级 Revert：把该块在最新内容里换回基线内容，返回换回后的内容。
 * @param newText 当前内容
 * @param block 目标块
 * @returns 新内容；块无法唯一定位时返回 null
 */
export function revertBlock(newText: string, block: ReviewBlock): string | null {
  return spliceBlock(newText, block.newLines, block.oldLines, block)
}

/**
 * @author ddj 2026年10月29号
 * @description: 按"上下文 + 目标行"唯一定位后做一次整块替换，定位不唯一就不动。
 * @param content 目标全文
 * @param from 要被替换的块内行
 * @param to 替换成的块内行
 * @param block 来源块，提供上下文；缺上下文时退化为只看块内行
 * @returns 新全文或 null
 */
function spliceBlock(content: string, from: string[], to: string[], block: ReviewBlock): string | null {
  if (from.length === 0 && to.length === 0) return null
  const lines = logicalLines(content)
  const withContext = locateSpan(lines, [...block.contextBefore, ...from, ...block.contextAfter])
  if (withContext !== null) {
    const start = withContext + block.contextBefore.length
    return spliceAt(lines, start, from.length, to)
  }
  const bare = locateSpan(lines, from)
  return bare === null ? null : spliceAt(lines, bare, from.length, to)
}

/**
 * @author ddj 2026年10月29号
 * @description: 在指定偏移处把连续若干行换成另一组行。
 * @param lines 目标行集合
 * @param start 起始偏移
 * @param count 被替换行数
 * @param to 替换成的行
 * @returns 新全文
 */
function spliceAt(lines: string[], start: number, count: number, to: string[]): string {
  return [...lines.slice(0, start), ...to, ...lines.slice(start + count)].join('\n')
}

/**
 * @author ddj 2026年10月29号
 * @description: 唯一定位一段行；出现多处命中即视为不可定位。
 * @param lines 目标行集合
 * @param pattern 待定位行
 * @returns 唯一偏移或 null
 */
function locateSpan(lines: string[], pattern: string[]): number | null {
  if (pattern.length === 0) return null
  let at = -1
  for (let offset = 0; offset + pattern.length <= lines.length; offset++) {
    if (!pattern.every((text, index) => lines[offset + index] === text)) continue
    if (at >= 0) return null
    at = offset
  }
  return at >= 0 ? at : null
}

/**
 * @author ddj 2026年10月29号
 * @description: 生成带上下文的标准 hunk 列表。
 * @param oldLines 基线行
 * @param newLines 当前行
 * @returns hunk 列表
 */
function buildHunks(oldLines: string[], newLines: string[]): ReviewHunk[] {
  const ops = diffLines(oldLines, newLines)
  const hunks: ReviewHunk[] = []
  let index = 0
  let oldLine = 0
  let newLine = 0
  while (index < ops.length) {
    if (ops[index].kind === ' ') {
      oldLine++
      newLine++
      index++
      continue
    }
    const head = ops.slice(Math.max(0, index - CONTEXT), index)
    const collected: LineOp[] = []
    let probe = index
    while (probe < ops.length) {
      const op = ops[probe]
      if (op.kind !== ' ') { collected.push(op); probe++; continue }
      const rest = ops.slice(probe, probe + CONTEXT * 2 + 1)
      if (rest.some((item) => item.kind !== ' ')) { collected.push(op); probe++; continue }
      break
    }
    const tail = ops.slice(probe, probe + CONTEXT)
    const oldStartLine = oldLine - head.length + 1
    const newStartLine = newLine - head.length + 1
    hunks.push(makeHunk([...head, ...collected, ...tail], oldStartLine, newStartLine))
    for (const op of collected) {
      if (op.kind !== '+') oldLine++
      if (op.kind !== '-') newLine++
    }
    oldLine += head.length + tail.length
    newLine += head.length + tail.length
    index = probe + tail.length
  }
  return hunks
}

/**
 * @author ddj 2026年10月29号
 * @description: 由一段操作装配 hunk。
 * @param ops 该 hunk 的操作
 * @param oldStart 基线起始行
 * @param newStart 当前起始行
 * @returns hunk
 */
function makeHunk(ops: LineOp[], oldStart: number, newStart: number): ReviewHunk {
  const oldCount = ops.filter((op) => op.kind !== '+').length
  const newCount = ops.filter((op) => op.kind !== '-').length
  return { oldStart, oldLines: oldCount, newStart, newLines: newCount, lines: ops.map((op) => op.kind + op.text) }
}

/**
 * @author ddj 2026年10月29号
 * @description: 行级差异：先剪公共前后缀，剩余部分在限额内做 LCS，超限按整段替换。
 * @param oldLines 基线行
 * @param newLines 当前行
 * @returns 顺序完整的操作列表
 */
function diffLines(oldLines: string[], newLines: string[]): LineOp[] {
  let head = 0
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++
  let tail = 0
  while (tail < oldLines.length - head && tail < newLines.length - head
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++
  const left = oldLines.slice(head, oldLines.length - tail)
  const right = newLines.slice(head, newLines.length - tail)
  const middle = left.length * right.length > CELL_LIMIT ? coarseOps(left, right) : lcsOps(left, right)
  return [
    ...oldLines.slice(0, head).map((text) => ({ kind: ' ' as const, text })),
    ...middle,
    ...oldLines.slice(oldLines.length - tail).map((text) => ({ kind: ' ' as const, text })),
  ]
}

/**
 * @author ddj 2026年10月29号
 * @description: 超限时的退化口径：整段删除再整段新增，绝不谎报逐行对应。
 * @param left 基线剩余行
 * @param right 当前剩余行
 * @returns 操作列表
 */
function coarseOps(left: string[], right: string[]): LineOp[] {
  return [
    ...left.map((text) => ({ kind: '-' as const, text })),
    ...right.map((text) => ({ kind: '+' as const, text })),
  ]
}

/**
 * @author ddj 2026年10月29号
 * @description: 限额内的 LCS 行差异。
 * @param left 基线剩余行
 * @param right 当前剩余行
 * @returns 操作列表
 */
function lcsOps(left: string[], right: string[]): LineOp[] {
  const rows = left.length + 1
  const cols = right.length + 1
  const table = new Uint32Array(rows * cols)
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i * cols + j] = left[i] === right[j]
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1])
    }
  }
  const ops: LineOp[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { ops.push({ kind: ' ', text: left[i] }); i++; j++; continue }
    if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) { ops.push({ kind: '-', text: left[i] }); i++ }
    else { ops.push({ kind: '+', text: right[j] }); j++ }
  }
  while (i < left.length) ops.push({ kind: '-', text: left[i++] })
  while (j < right.length) ops.push({ kind: '+', text: right[j++] })
  return ops
}

/**
 * @author ddj 2026年10月29号
 * @description: 判断这次差异是否触发了大文件退化口径。
 * @param oldText 基线全文
 * @param newText 当前全文
 * @returns 是否粗粒度
 */
function isCoarse(oldText: string, newText: string): boolean {
  return logicalLines(oldText).length * logicalLines(newText).length > CELL_LIMIT
}
