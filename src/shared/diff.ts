/**
 * dsh-vscode-mode shared diff primitives — 快照指纹、hunk 规范化与安全定位。
 * 不依赖 Node/React，host 与 browser 共用，避免各层用不同 indexOf 语义。
 * 作者 ddj 2026-08-24
 */
import type { Hunk, RecordBase } from './types.js'

/** 文件读取状态，区分真实空文件与无法读取/过大的文件。 */
export type ReadState =
  | { kind: 'content'; content: string }
  | { kind: 'missing' }
  | { kind: 'unavailable' }

/** 文本中的一个半开区间 [start,end)。 */
export interface TextRange {
  start: number
  end: number
}

/** 一条 hunk 在当前内容中的定位结果。 */
export interface HunkLocation extends TextRange {
  idx: number
  hunk: Hunk
  matched: boolean
}

/** 统一取对应 hunk；callHunk 只用于旧记录缺失 hunks 时兼容。 */
export function preciseHunk(record: Pick<RecordBase, 'hunks' | 'callHunk'>, idx: number): Hunk | null {
  return hunkOf(record, idx)
}

/** 轻量、确定性的字符串指纹；不引入 Node crypto。 */
export function fingerprint(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return 'fnv1a:' + (hash >>> 0).toString(16) + ':' + text.length
}

/** 取记录第 idx 个有效 hunk；只有记录缺 hunk 时才回退 callHunk。 */
export function hunkOf(record: Pick<RecordBase, 'hunks' | 'callHunk'>, idx: number): Hunk | null {
  const hunk = Array.isArray(record.hunks) ? record.hunks[idx] : undefined
  if (hunk && typeof hunk.newText === 'string') return hunk
  if (idx === 0 && record.callHunk && typeof record.callHunk.newText === 'string') return record.callHunk
  return null
}

/** hunk 是否表示没有实际内容变化。 */
export function isNoopHunk(hunk: Hunk | null | undefined): boolean {
  return !!hunk && hunk.oldText !== null && hunk.oldText === hunk.newText
}

/** splitLines 的空文本语义：真实空文件没有一行变更内容。 */
export function splitLines(text: string): string[] {
  return text.length ? text.split('\n') : []
}

/** 为执行后 hunk 写入快照坐标；空 newText 通过 before/after 公共边界定位删除点。 */
export function annotateHunk(hunk: Hunk, before: string | null, after: string | null): Hunk {
  return annotateHunks([hunk], before, after)[0]
}

/** 按文件顺序为多 hunk 写入不重复的 after 坐标。 */
export function annotateHunks(hunks: Hunk[], before: string | null, after: string | null): Hunk[] {
  if (typeof after !== 'string') return hunks
  let cursor = 0
  return hunks.map((hunk) => {
    if (hunk.newText.length > 0) {
      const start = after.indexOf(hunk.newText, cursor)
      if (start >= 0) {
        cursor = start + hunk.newText.length
        return { ...hunk, afterStart: start, afterEnd: cursor }
      }
      return hunk
    }
    if (hunks.length !== 1 || typeof before !== 'string' || before === after || hunk.oldText === null) return hunk
    const prefix = commonPrefix(before, after)
    const suffix = commonSuffix(before, after, prefix)
    const removedStart = prefix
    const removedEnd = Math.max(removedStart, before.length - suffix)
    return { ...hunk, afterStart: removedStart, afterEnd: removedStart, beforeStart: removedStart, beforeEnd: removedEnd }
  })
}

/** 计算两个文本的最长公共前缀长度。 */
function commonPrefix(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let i = 0
  while (i < limit && left.charCodeAt(i) === right.charCodeAt(i)) i++
  return i
}

/** 计算不与 prefix 重叠的最长公共后缀长度。 */
function commonSuffix(left: string, right: string, prefix: number): number {
  const limit = Math.min(left.length, right.length) - prefix
  let i = 0
  while (i < limit && left.charCodeAt(left.length - 1 - i) === right.charCodeAt(right.length - 1 - i)) i++
  return i
}

/** 计算 index 前的 0 基行数。 */
export function lineBefore(text: string, index: number): number {
  let n = 0
  const end = Math.max(0, Math.min(index, text.length))
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/** 找出文本的全部非重叠出现位置。 */
function allMatches(content: string, needle: string): TextRange[] {
  if (!needle.length) return []
  const out: TextRange[] = []
  let from = 0
  while (from <= content.length - needle.length) {
    const at = content.indexOf(needle, from)
    if (at < 0) break
    out.push({ start: at, end: at + needle.length })
    from = at + Math.max(1, needle.length)
  }
  return out
}

/**
 * 从 after 快照定位所有 hunk，按 hunk 顺序优先选未占用且靠近前一块的候选。
 * 若 hunk 带 afterStart/afterEnd，则优先验证快照坐标，避免重复文本错配。
 * @author ddj 2026年08月24号
 * @param content 当前文件内容
 * @param hunks 待定位 hunk
 * @returns 每个 hunk 一个结果，matched=false 表示冲突/stale
 */
export function locateHunks(content: string, hunks: Hunk[]): HunkLocation[] {
  const locations: HunkLocation[] = []
  let cursor = 0
  const occupied: TextRange[] = []
  for (let idx = 0; idx < hunks.length; idx++) {
    const hunk = hunks[idx]
    const newText = hunk.newText
    const snapshot = Number.isInteger(hunk.afterStart) && Number.isInteger(hunk.afterEnd)
      ? { start: hunk.afterStart as number, end: hunk.afterEnd as number }
      : null
    const snapshotMatches = snapshot && snapshot.start >= 0 && snapshot.end >= snapshot.start
      && (newText.length === 0 || content.slice(snapshot.start, snapshot.end) === newText)
      ? snapshot
      : null
    const candidates = snapshotMatches ? [snapshotMatches] : allMatches(content, newText)
    const candidate = candidates.find((range) => range.start >= cursor && !occupied.some((used) => overlaps(range, used)))
      ?? candidates.find((range) => !occupied.some((used) => overlaps(range, used)))
    if (candidate) {
      locations.push({ idx, hunk, ...candidate, matched: true })
      occupied.push(candidate)
      cursor = Math.max(cursor, candidate.end)
      continue
    }
    if (newText.length === 0 && hunk.afterStart === undefined && hunk.afterEnd === undefined && content.length === 0) {
      const point = { start: 0, end: 0 }
      locations.push({ idx, hunk, ...point, matched: true })
      continue
    }
    if (newText.length === 0 && hunk.afterStart !== undefined && hunk.afterEnd !== undefined
      && hunk.afterStart === hunk.afterEnd && hunk.afterStart >= 0 && hunk.afterStart <= content.length) {
      const point = { start: hunk.afterStart, end: hunk.afterEnd }
      if (!occupied.some((used) => overlaps(point, used))) {
        locations.push({ idx, hunk, ...point, matched: true })
        occupied.push(point)
        cursor = Math.max(cursor, point.end)
        continue
      }
    }
    locations.push({ idx, hunk, start: -1, end: -1, matched: false })
  }
  return locations
}

/** 判断两个半开区间是否重叠。零长度区间只与同一位置的零长度区间重叠。 */
function overlaps(left: TextRange, right: TextRange): boolean {
  if (left.start === left.end || right.start === right.end) return left.start === right.start && left.end === right.end
  return left.start < right.end && right.start < left.end
}

/** 在可定位区间上执行一次 hunk 反向替换。 */
export function replaceRange(content: string, location: HunkLocation, reverse = false): string | null {
  if (!location.matched || location.start < 0) return null
  const replacement = reverse ? (location.hunk.oldText ?? '') : location.hunk.newText
  return content.slice(0, location.start) + replacement + content.slice(location.end)
}

/** 按当前内容中出现的位置从后向前应用 hunk，避免前块长度变化影响后块。 */
export function applyLocations(content: string, locations: HunkLocation[], reverse = false): { content: string; stale: number[] } {
  const stale = locations.filter((location) => !location.matched).map((location) => location.idx)
  let out = content
  const matched = locations.filter((location) => location.matched).sort((a, b) => b.start - a.start)
  for (const location of matched) {
    const next = replaceRange(out, location, reverse)
    if (next === null) stale.push(location.idx)
    else out = next
  }
  return { content: out, stale: stale.sort((a, b) => a - b) }
}
