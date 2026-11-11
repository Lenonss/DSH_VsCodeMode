/**
 * 行级差异引擎：先裁公共前后缀，再按唯一行锚点切分，最后在小窗口内做 LCS。
 * 千行文件上的少量/分散改动不再因单元格上限退化成整段替换；只有确实找不到
 * 可匹配行的区域才按整段替换处理并标记 degraded。
 * @author ddj 2026年11月11号
 */
import type { ReviewHunk } from '../shared/review.js'

// #region 类型与常量
/** 一行差异操作。 */
export type LineOp = { kind: ' ' | '-' | '+'; text: string }

/** 一次行差异：hunk 列表与是否发生整段替换退化。 */
export interface LineDiff { hunks: ReviewHunk[]; degraded: boolean }

/** 两侧都唯一出现一次的相同行配对，用于把窗口切成更小的子窗口。 */
interface Anchor { oldIndex: number; newIndex: number }

/** 一次差异的累计预算与退化标记，按引用在递归间共享。 */
interface WorkState { cells: number; degraded: boolean }

/** 单窗口 LCS 单元格上限：超过先找锚点；4 MB 表实测约 7 ms。 */
const LCS_CELLS = 1_000_000

/** 一次差异的 LCS 总预算：防止病态输入拖慢 Host，约 80 ms 量级封顶。 */
const WORK_CELLS = 12_000_000

/** 锚点递归深度上限：超过即把该窗口按整段替换处理。 */
const MAX_DEPTH = 64

/** 每个 hunk 的上下文行数。 */
const CONTEXT = 3
// #endregion

// #region 差异引擎
/**
 * @public
 * @author ddj 2026年11月11号
 * @description: 计算两侧逻辑行的差异并装配 hunk；相同输入不产出 hunk。
 * @param oldLines 基线行
 * @param newLines 当前行
 * @returns hunk 列表与退化标记
 */
export function lineHunks(oldLines: string[], newLines: string[]): LineDiff {
  if (sameLines(oldLines, newLines)) return { hunks: [], degraded: false }

  const work: WorkState = { cells: 0, degraded: false }
  const ops: LineOp[] = []
  diffWindows(oldLines, 0, oldLines.length, newLines, 0, newLines.length, 0, work, ops)
  return { hunks: buildHunks(ops), degraded: work.degraded }
}

/**
 * @private
 * @author ddj 2026年11月11号
 * @description: 判断两组行是否逐行相同，避免为完全相同的文件生成整页上下文。
 * @param oldLines 基线行
 * @param newLines 当前行
 * @returns 是否逐行相同
 */
function sameLines(oldLines: string[], newLines: string[]): boolean {
  if (oldLines.length !== newLines.length) return false
  return oldLines.every((text, index) => text === newLines[index])
}

/**
 * @private
 * @author ddj 2026年11月11号
 * @description: 先裁当前窗口的公共前后缀并发成上下文行，再让中段进入核心比较。
 * @param oldLines 基线行
 * @param oldStart 基线窗口起点
 * @param oldCount 基线窗口行数
 * @param newLines 当前行
 * @param newStart 当前窗口起点
 * @param newCount 当前窗口行数
 * @param depth 递归深度
 * @param work 共享预算
 * @param ops 输出操作
 * @returns 无
 */
function diffWindows(
  oldLines: string[], oldStart: number, oldCount: number,
  newLines: string[], newStart: number, newCount: number,
  depth: number, work: WorkState, ops: LineOp[],
): void {
  let prefix = 0
  while (prefix < oldCount && prefix < newCount && oldLines[oldStart + prefix] === newLines[newStart + prefix]) prefix++
  let suffix = 0
  while (suffix < oldCount - prefix && suffix < newCount - prefix
    && oldLines[oldStart + oldCount - 1 - suffix] === newLines[newStart + newCount - 1 - suffix]) suffix++

  for (let index = 0; index < prefix; index++) ops.push({ kind: ' ', text: oldLines[oldStart + index] })
  diffCore(oldLines, oldStart + prefix, oldCount - prefix - suffix,
    newLines, newStart + prefix, newCount - prefix - suffix, depth, work, ops)
  for (let index = 0; index < suffix; index++) ops.push({ kind: ' ', text: oldLines[oldStart + oldCount - suffix + index] })
}

/**
 * @private
 * @author ddj 2026年11月11号
 * @description: 核心比较：小窗口做最优 LCS，大窗口按唯一行锚点递归切分，无锚点才整段替换。
 * @param oldLines 基线行
 * @param oldStart 基线窗口起点
 * @param oldCount 基线窗口行数
 * @param newLines 当前行
 * @param newStart 当前窗口起点
 * @param newCount 当前窗口行数
 * @param depth 递归深度
 * @param work 共享预算
 * @param ops 输出操作
 * @returns 无
 */
function diffCore(
  oldLines: string[], oldStart: number, oldCount: number,
  newLines: string[], newStart: number, newCount: number,
  depth: number, work: WorkState, ops: LineOp[],
): void {
  if (oldCount === 0) {
    for (let index = 0; index < newCount; index++) ops.push({ kind: '+', text: newLines[newStart + index] })
    return
  }
  if (newCount === 0) {
    for (let index = 0; index < oldCount; index++) ops.push({ kind: '-', text: oldLines[oldStart + index] })
    return
  }

  const cells = oldCount * newCount
  if (cells <= LCS_CELLS && work.cells + cells <= WORK_CELLS) {
    runLcs(oldLines, oldStart, oldCount, newLines, newStart, newCount, work, ops)
    return
  }
  if (depth >= MAX_DEPTH || work.cells >= WORK_CELLS) {
    appendReplace(oldLines, oldStart, oldCount, newLines, newStart, newCount, ops)
    work.degraded = true
    return
  }

  const anchors = pickAnchors(oldLines, oldStart, oldCount, newLines, newStart, newCount)
  if (anchors.length === 0) {
    appendReplace(oldLines, oldStart, oldCount, newLines, newStart, newCount, ops)
    work.degraded = true
    return
  }

  let oldOffset = 0
  let newOffset = 0
  for (const anchor of anchors) {
    diffWindows(oldLines, oldStart + oldOffset, anchor.oldIndex - oldOffset,
      newLines, newStart + newOffset, anchor.newIndex - newOffset, depth + 1, work, ops)
    ops.push({ kind: ' ', text: oldLines[oldStart + anchor.oldIndex] })
    oldOffset = anchor.oldIndex + 1
    newOffset = anchor.newIndex + 1
  }
  diffWindows(oldLines, oldStart + oldOffset, oldCount - oldOffset,
    newLines, newStart + newOffset, newCount - newOffset, depth + 1, work, ops)
}

/**
 * @private
 * @author ddj 2026年11月11号
 * @description: 在窗口内做最优 LCS；平局优先删行，保持与历史实现一致的 hunk 形状。
 * @param oldLines 基线行
 * @param oldStart 基线窗口起点
 * @param oldCount 基线窗口行数
 * @param newLines 当前行
 * @param newStart 当前窗口起点
 * @param newCount 当前窗口行数
 * @param work 共享预算
 * @param ops 输出操作
 * @returns 无
 */
function runLcs(
  oldLines: string[], oldStart: number, oldCount: number,
  newLines: string[], newStart: number, newCount: number,
  work: WorkState, ops: LineOp[],
): void {
  work.cells += oldCount * newCount
  const cols = newCount + 1
  const table = new Uint32Array((oldCount + 1) * cols)
  for (let oldIndex = oldCount - 1; oldIndex >= 0; oldIndex--) {
    const row = oldIndex * cols
    const nextRow = row + cols
    for (let newIndex = newCount - 1; newIndex >= 0; newIndex--) {
      table[row + newIndex] = oldLines[oldStart + oldIndex] === newLines[newStart + newIndex]
        ? table[nextRow + newIndex + 1] + 1
        : Math.max(table[nextRow + newIndex], table[row + newIndex + 1])
    }
  }

  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldCount && newIndex < newCount) {
    if (oldLines[oldStart + oldIndex] === newLines[newStart + newIndex]) {
      ops.push({ kind: ' ', text: oldLines[oldStart + oldIndex] })
      oldIndex++
      newIndex++
      continue
    }
    if (table[(oldIndex + 1) * cols + newIndex] >= table[oldIndex * cols + newIndex + 1]) {
      ops.push({ kind: '-', text: oldLines[oldStart + oldIndex] })
      oldIndex++
    } else {
      ops.push({ kind: '+', text: newLines[newStart + newIndex] })
      newIndex++
    }
  }
  while (oldIndex < oldCount) ops.push({ kind: '-', text: oldLines[oldStart + oldIndex++] })
  while (newIndex < newCount) ops.push({ kind: '+', text: newLines[newStart + newIndex++] })
}

/**
 * @private
 * @author ddj 2026年11月11号
 * @description: 退化口径：整段删除再整段新增，绝不谎报逐行对应。
 * @param oldLines 基线行
 * @param oldStart 基线窗口起点
 * @param oldCount 基线窗口行数
 * @param newLines 当前行
 * @param newStart 当前窗口起点
 * @param newCount 当前窗口行数
 * @param ops 输出操作
 * @returns 无
 */
function appendReplace(
  oldLines: string[], oldStart: number, oldCount: number,
  newLines: string[], newStart: number, newCount: number, ops: LineOp[],
): void {
  for (let index = 0; index < oldCount; index++) ops.push({ kind: '-', text: oldLines[oldStart + index] })
  for (let index = 0; index < newCount; index++) ops.push({ kind: '+', text: newLines[newStart + index] })
}

/**
 * @private
 * @author ddj 2026年11月11号
 * @description: 取两侧都恰好出现一次的相同行做锚点，并按出现顺序取最长递增链，避免交叉配对。
 * @param oldLines 基线行
 * @param oldStart 基线窗口起点
 * @param oldCount 基线窗口行数
 * @param newLines 当前行
 * @param newStart 当前窗口起点
 * @param newCount 当前窗口行数
 * @returns 顺序递增的锚点列表
 */
function pickAnchors(
  oldLines: string[], oldStart: number, oldCount: number,
  newLines: string[], newStart: number, newCount: number,
): Anchor[] {
  const oldCounts = countRange(oldLines, oldStart, oldCount)
  const newCounts = countRange(newLines, newStart, newCount)
  const newIndexes = new Map<string, number>()
  for (let index = 0; index < newCount; index++) {
    const text = newLines[newStart + index]
    if (newCounts.get(text) === 1) newIndexes.set(text, index)
  }

  const pairs: Anchor[] = []
  for (let index = 0; index < oldCount; index++) {
    const text = oldLines[oldStart + index]
    if (oldCounts.get(text) !== 1) continue
    const newIndex = newIndexes.get(text)
    if (newIndex === undefined) continue
    pairs.push({ oldIndex: index, newIndex })
  }
  return longestChain(pairs)
}

/**
 * @private
 * @author ddj 2026年11月11号
 * @description: 统计窗口内每一行文本的出现次数。
 * @param lines 行集合
 * @param start 窗口起点
 * @param count 窗口行数
 * @returns 行文本到出现次数的映射
 */
function countRange(lines: string[], start: number, count: number): Map<string, number> {
  const counts = new Map<string, number>()
  for (let index = 0; index < count; index++) {
    const text = lines[start + index]
    counts.set(text, (counts.get(text) ?? 0) + 1)
  }
  return counts
}

/**
 * @private
 * @author ddj 2026年11月11号
 * @description: 按右侧下标做最长递增子序列（耐心排序 O(n log n)），保持锚点不交叉。
 * @param pairs 已按左侧下标升序的候选锚点
 * @returns 顺序递增的锚点子序列
 */
function longestChain(pairs: Anchor[]): Anchor[] {
  const tails: number[] = []
  const previous = new Array<number>(pairs.length).fill(-1)
  for (let index = 0; index < pairs.length; index++) {
    const value = pairs[index].newIndex
    let left = 0
    let right = tails.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (pairs[tails[middle]].newIndex < value) left = middle + 1
      else right = middle
    }
    if (left > 0) previous[index] = tails[left - 1]
    tails[left] = index
  }

  const ordered: Anchor[] = []
  let cursor = tails.length ? tails[tails.length - 1] : -1
  while (cursor >= 0) {
    ordered.push(pairs[cursor])
    cursor = previous[cursor]
  }
  return ordered.reverse()
}
// #endregion

// #region hunk 装配
/**
 * @private
 * @author ddj 2026年11月11号
 * @description: 把操作流装配成带上下文的 hunk；变化间隔不超过 2×上下文时合并同一 hunk。
 * 行号按已消费行数推进：head 已在主循环逐行计入，块结束只补 tail。
 * @param ops 完整操作流
 * @returns hunk 列表
 */
function buildHunks(ops: LineOp[]): ReviewHunk[] {
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
    const { changes, stop } = collectChanges(ops, index)
    const tail = ops.slice(stop, stop + CONTEXT)
    hunks.push(makeHunk([...head, ...changes, ...tail], oldLine - head.length + 1, newLine - head.length + 1))

    for (const op of changes) {
      if (op.kind !== '+') oldLine++
      if (op.kind !== '-') newLine++
    }
    oldLine += tail.length
    newLine += tail.length
    index = stop + tail.length
  }
  return hunks
}

/**
 * @private
 * @author ddj 2026年11月11号
 * @description: 收集从首个变化开始的连续操作，直到遇到足够长的纯上下文段才停止。
 * @param ops 完整操作流
 * @param start 首个变化的位置
 * @returns 变化段操作与停止位置
 */
function collectChanges(ops: LineOp[], start: number): { changes: LineOp[]; stop: number } {
  const changes: LineOp[] = []
  let probe = start
  while (probe < ops.length) {
    const op = ops[probe]
    if (op.kind !== ' ') {
      changes.push(op)
      probe++
      continue
    }
    if (!hasChange(ops, probe)) break
    changes.push(op)
    probe++
  }
  return { changes, stop: probe }
}

/**
 * @private
 * @author ddj 2026年11月11号
 * @description: 判断上下文窗口内是否还有变化，用于决定是否把两处改动并进同一 hunk。
 * @param ops 完整操作流
 * @param at 待检查上下文段起点
 * @returns 窗口内是否含变化
 */
function hasChange(ops: LineOp[], at: number): boolean {
  return ops.slice(at, at + CONTEXT * 2 + 1).some((op) => op.kind !== ' ')
}

/**
 * @private
 * @author ddj 2026年11月11号
 * @description: 由一段操作装配 hunk，并统计两侧行数。
 * @param ops 该 hunk 的操作
 * @param oldStart 基线起始行（1 基）
 * @param newStart 当前起始行（1 基）
 * @returns hunk
 */
function makeHunk(ops: LineOp[], oldStart: number, newStart: number): ReviewHunk {
  let oldLines = 0
  let newLines = 0
  const lines: string[] = []
  for (const op of ops) {
    if (op.kind !== '+') oldLines++
    if (op.kind !== '-') newLines++
    lines.push(op.kind + op.text)
  }
  return { oldStart, oldLines, newStart, newLines, lines }
}
// #endregion
