/**
 * 待审差异构造：把两侧全文变成官方视图复用的 hunk，并提供块级 Keep/Revert 的文本合成。
 * 行差异交给 lineDiff 引擎（唯一行锚点切分 + 小窗口 LCS），只有真整段替换才标 coarse。
 * @author ddj 2026年10月29号
 */
import type { OfficialDiff } from '../shared/review.js'
import type { ReviewBlock } from '../shared/reviewRegions.js'
import { logicalLines } from '../shared/lineEndings.js'
import { lineHunks } from './lineDiff.js'

/**
 * @author ddj 2026年10月29号
 * @description: 构造可直接交给官方渲染器的差异；两侧完全相同时返回空 hunk 列表。
 * @param path 相对路径
 * @param display 展示名
 * @param oldText 基线全文
 * @param newText 当前全文
 * @returns 文本差异；coarse 表示比较中确有区域退化为整段替换
 */
export function textDiff(path: string, display: string, oldText: string, newText: string): OfficialDiff {
  const { hunks, degraded } = lineHunks(logicalLines(oldText), logicalLines(newText))
  return { kind: 'text', path, display, before: true, after: true, hunks, coarse: degraded }
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
