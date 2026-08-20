/**
 * dsh-vscode-mode client — 差异区域计算纯函数（可单测）。
 * 迁移自原 src/client/index.ts 的 diffRegions/trimCommonLines/countLinesBefore，语义不改。
 * 作者 ddj 2026-08-20
 */
import type { Hunk, RecordView } from '../../shared/types.js'
import { ST, noopHunk, statusAt } from './records.js'
import type { Status } from './records.js'

/** 差异区域（文件内一段待处理/已处理的变更）。 */
export interface Region {
  callId: string
  idx: number
  start?: number
  end?: number
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
  let n = 0
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++
  return n
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

/** 计算文件内各差异区域（行范围 + old/new + 状态），用于行内绿标注与 DiffBox。 */
export function diffRegions(records: RecordView[], content: string | null): Region[] {
  const regions: Region[] = []
  if (content === null) return regions
  const lines = content.split('\n')
  for (const rec of records) {
    for (let i = 0; i < rec.hunks.length; i++) {
      const h: Hunk = rec.hunks[i]
      if (noopHunk(rec, h)) continue // 空差异（old===new）无实际变化，跳过
      const status = statusAt(rec, i)
      if (rec.create) {
        regions.push({ callId: rec.callId, idx: i, start: 1, end: lines.length, oldLines: [], newLines: lines.slice(), whole: true, status, create: true, rec, superseded: rec.superseded === true })
        continue
      }
      const precise = rec.toolName === 'edit' && rec.callHunk ? rec.callHunk : h
      const newText = precise.newText ?? ''
      const at = content.indexOf(newText)
      if (at < 0) {
        regions.push({ callId: rec.callId, idx: i, stale: true, status, create: false, oldLines: [], newLines: [], rec, superseded: rec.superseded === true })
        continue
      }
      const start = countLinesBefore(content, at) + 1
      const oldLines = precise.oldText === null ? [] : precise.oldText.split('\n')
      const newLines = newText.split('\n')
      const trimmed = trimCommonLines(oldLines, newLines)
      const regionStart = start + trimmed.shift
      regions.push({ callId: rec.callId, idx: i, start: regionStart, end: regionStart + trimmed.newLines.length, oldLines: trimmed.oldLines, newLines: trimmed.newLines, status, create: false, rec, superseded: rec.superseded === true })
    }
  }
  regions.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity))
  return regions
}
