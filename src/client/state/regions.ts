/**
 * dsh-vscode-mode client — 差异区域计算纯函数（可单测）。
 * 迁移自原 src/client/index.ts 的 diffRegions/trimCommonLines/countLinesBefore，语义不改。
 * 作者 ddj 2026-08-20
 */
import type { Hunk, RecordView } from '../../shared/types.js'
import { applyLocations, fingerprint, locateHunks, lineBefore, normalizeForCompare, normalizeHunk, preciseHunk, splitLines } from '../../shared/diff.js'
import { ST, noopHunk, statusAt } from './records.js'
import type { Status } from './records.js'

/** 差异区域（文件内一段待处理/已处理的变更）。 */
export interface Region {
  callId: string
  idx: number
  start?: number
  end?: number
  /** 原快照中的 1 基行号；历史证据不足时不伪造为当前行号。 */
  oldStart?: number
  oldLines: string[]
  newLines: string[]
  whole?: boolean
  status: Status
  create: boolean
  rec: RecordView
  superseded: boolean
  stale?: boolean
}

/** 统计 index 之前（不含）的换行数 → 0 基行号。 */
export function countLinesBefore(text: string, index: number): number {
  return lineBefore(text, index)
}

/**
 * 在预计算的换行位置中找出 offset 前的行数。
 * @author ddj 2026年09月29号
 * @param breaks 换行符位置（递增）
 * @param offset 目标位置
 * @returns 目标位置前的换行数
 */
function lineAt(breaks: number[], offset: number): number {
  let left = 0
  let right = breaks.length
  while (left < right) {
    const middle = (left + right) >>> 1
    if (breaks[middle] < offset) left = middle + 1
    else right = middle
  }
  return left
}

/**
 * 行级公共前缀/后缀裁剪：old/new 首尾相同的行视为未变化（上下文），只保留真正变更的中间段。
 * @author ddj 2026年08月20号
 * @param oldLines 替换前内容按行拆分
 * @param newLines 替换后内容按行拆分
 * @returns 裁剪后的变更段与公共前缀行数
 */
export function trimCommonLines(oldLines: string[], newLines: string[]): { oldLines: string[]; newLines: string[]; shift: number } {
  let prefix = 0
  const maxPrefix = Math.min(oldLines.length, newLines.length)
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  const maxSuffix = Math.min(oldLines.length - prefix, newLines.length - prefix)
  while (suffix < maxSuffix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++
  return { oldLines: oldLines.slice(prefix, oldLines.length - suffix), newLines: newLines.slice(prefix, newLines.length - suffix), shift: prefix }
}

/**
 * 从执行后快照反向验证原文本，计算每块原行号（而非当前文件行号）。
 * @private @author ddj 2026年10月09号
 * @param rec 审查记录
 * @returns 按 hunk 索引的原行号；不完整/指纹冲突时全部留空
 */
function oldStartsOf(rec: RecordView): Array<number | undefined> {
  if (typeof rec.after !== 'string' || rec.create) return []
  const hunks = rec.hunks.map((_, index) => preciseHunk(rec, index))
  if (hunks.some((hunk) => !hunk || hunk.oldText === null)) return []
  const locations = locateHunks(rec.after, hunks as Hunk[])
  // 没有原指纹时，要求每块有验证过的快照坐标，避免重复 newText 被猜中。
  for (const location of locations) {
    const hunk = location.hunk
    if (!location.matched || location.end > rec.after.length || location.end - location.start !== hunk.newText.length) return []
    if (!rec.baseFingerprint && (hunk.afterStart !== location.start || hunk.afterEnd !== location.end)) return []
  }
  const original = applyLocations(rec.after, locations, true)
  if (original.stale.length || (rec.baseFingerprint && fingerprint(original.content) !== rec.baseFingerprint)) return []
  const breaks: number[] = []
  for (let index = rec.after.indexOf('\n'); index >= 0; index = rec.after.indexOf('\n', index + 1)) breaks.push(index)
  const starts: Array<number | undefined> = []
  let shift = 0
  for (const location of locations.slice().sort((a, b) => a.start - b.start)) {
    starts[location.idx] = lineAt(breaks, location.start) + shift + 1
    const hunk = location.hunk
    shift += lineBefore(hunk.oldText!, hunk.oldText!.length) - lineBefore(hunk.newText, hunk.newText.length)
  }
  return starts
}

/**
 * 将快照坐标一次性映射到 LF/BOM 归一化坐标，避免每块扫描文件前缀。
 * @private @author ddj 2026年10月09号
 * @param after 已确认相同的原始快照 @param hunks 块集合
 * @returns 原偏移到展示偏移的映射；O(文本长度 + 块数 log 块数)
 */
function offsetsOf(after: string | undefined, hunks: Hunk[]): Map<number, number> {
  const offsets = new Map<number, number>()
  if (after === undefined) return offsets
  const points = hunks.flatMap((hunk) => [hunk.afterStart, hunk.afterEnd])
    .filter((point): point is number => Number.isInteger(point) && point! >= 0 && point! <= after.length)
    .sort((a, b) => a - b)
  let cursor = 0
  let removed = 0
  for (const point of points) {
    while (cursor < point) {
      if ((cursor === 0 && after[cursor] === '\uFEFF') || (after[cursor] === '\r' && after[cursor + 1] === '\n')) removed++
      cursor++
    }
    offsets.set(point, point - removed)
  }
  return offsets
}

/**
 * 保留可验证的归一化快照坐标，让纯删除也能在 CRLF/BOM 文本中定位。
 * @private @author ddj 2026年10月09号
 * @param hunk 原始块 @param after 已确认与当前文本相同的执行后快照 @param offsets 展示偏移映射
 * @returns 展示用块；快照已变化时不借用删除点
 */
function viewHunk(hunk: Hunk, after: string | undefined, offsets: Map<number, number>): Hunk {
  const normalized = normalizeHunk(hunk)
  if (after === undefined) return normalized
  const start = hunk.afterStart
  const end = hunk.afterEnd
  if (!Number.isInteger(start) || !Number.isInteger(end) || start! < 0 || end! < start! || end! > after.length) return normalized
  if (after.slice(start, end) !== hunk.newText) return normalized
  return { ...normalized, afterStart: offsets.get(start!), afterEnd: offsets.get(end!) }
}

/**
 * 计算文件内各差异区域（行范围 + old/new + 状态），用于行内绿标注与 DiffBox。
 * 定位统一基于归一化文本（剥 BOM、CRLF→LF）：外部工具可能改变行尾/BOM，
 * 与 edit 工具的 LF hunk 口径不一致会导致定位失败（差异被误标 stale）。
 * 行号按 \n 计数，归一化不改变行号，展示语义不变。
 * @author ddj 2026年09月09号
 */
export function diffRegions(records: RecordView[], content: string | null): Region[] {
  const regions: Region[] = []
  if (content === null) return regions
  const normalized = normalizeForCompare(content)
  const lines = splitLines(normalized)
  const breaks: number[] = []
  for (let index = normalized.indexOf('\n'); index >= 0; index = normalized.indexOf('\n', index + 1)) breaks.push(index)
  for (const rec of records) {
    if (rec.create) {
      for (let i = 0; i < rec.hunks.length; i++) {
        const h = preciseHunk(rec, i)
        if (!h || noopHunk(rec, h)) continue
        regions.push({ callId: rec.callId, idx: i, start: 1, end: lines.length + 1, oldLines: [], newLines: lines.slice(), whole: true, status: statusAt(rec, i), create: true, rec, superseded: rec.superseded === true })
      }
      continue
    }
    const oldStarts = oldStartsOf(rec)
    const snapshot = typeof rec.after === 'string' && normalizeForCompare(rec.after) === normalized ? rec.after : undefined
    const offsets = offsetsOf(snapshot, rec.hunks)
    const entries: Array<{ idx: number; hunk: Hunk }> = []
    for (let i = 0; i < rec.hunks.length; i++) {
      const hunk = preciseHunk(rec, i)
      if (hunk && !noopHunk(rec, hunk)) entries.push({ idx: i, hunk: viewHunk(hunk, snapshot, offsets) })
    }
    const locations = locateHunks(normalized, entries.map((entry) => entry.hunk))
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const location = locations[i]
      const status = statusAt(rec, entry.idx)
      if (!location.matched) {
        regions.push({ callId: rec.callId, idx: entry.idx, stale: true, status, create: false, oldLines: entry.hunk.oldText === null ? [] : entry.hunk.oldText.split('\n'), newLines: entry.hunk.newText ? entry.hunk.newText.split('\n') : [], rec, superseded: rec.superseded === true })
        continue
      }
      const start = lineAt(breaks, location.start) + 1
      const oldLines = entry.hunk.oldText === null ? [] : entry.hunk.oldText.split('\n')
      const newLines = entry.hunk.newText.split('\n')
      const trimmed = trimCommonLines(oldLines, newLines)
      // 保留尾换行的公共空行裁剪，但空字符串自身不制造增删占位行。
      if (entry.hunk.oldText === '') trimmed.oldLines = []
      if (entry.hunk.newText === '') trimmed.newLines = []
      const regionStart = start + trimmed.shift
      const oldStart = oldStarts[entry.idx] === undefined ? undefined : oldStarts[entry.idx]! + trimmed.shift
      regions.push({ callId: rec.callId, idx: entry.idx, start: regionStart, end: regionStart + trimmed.newLines.length, oldStart, oldLines: trimmed.oldLines, newLines: trimmed.newLines, status, create: false, rec, superseded: rec.superseded === true })
    }
  }
  regions.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity))
  return regions
}
