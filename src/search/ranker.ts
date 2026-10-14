/**
 * dsh-vscode-mode host — 文件名优先的连续/模糊匹配排序器。
 * 每个候选仅计算一次匹配等级与模糊代价，平分按稳定路径序。
 * 作者 ddj 2026年08月24号
 */
import type { CandidateRanker, PreparedQuery, SearchCandidate } from './types.js'
import { pathText } from './query.js'

/**
 * 生成搜索候选。
 * @author ddj 2026年08月24号
 * @param path 文件路径
 * @param source 候选来源
 * @returns 内部候选
 */
export function candidateOf(path: string, source: SearchCandidate['source']): SearchCandidate {
  const normalizedPath = pathText(path)
  const basename = normalizedPath.split('/').pop() ?? normalizedPath
  return { path, basename, normalizedPath: normalizedPath.toLocaleLowerCase('en-US'), source }
}

/**
 * @private
 * @author ddj 2026年10月14号
 * @description 贪心匹配文件名，优先词/驼峰边界，其次紧凑程度；不枚举组合。
 * @param name 原始大小写文件名
 * @param text 已规范化查询
 * @returns 边界漏命中数与跨度代价；无匹配返回 null
 */
function fuzzyCost(name: string, text: string): number[] | null {
  const base = name.toLocaleLowerCase('en-US')
  let offset = 0
  let first = -1
  let misses = 0
  for (const char of text) {
    const index = base.indexOf(char, offset)
    if (index < 0) return null
    if (first < 0) first = index
    const boundary = index === 0 || /[\s_.\-]/.test(name[index - 1]) || /[a-z0-9]/.test(name[index - 1]) && /[A-Z]/.test(name[index])
    if (!boundary) misses++
    offset = index + char.length
  }
  return [misses, offset - first - text.length]
}

/**
 * @private
 * @author ddj 2026年10月14号
 * @description 计算完全/前缀/连续/模糊/路径命中的排序等级。
 * @param candidate 文件候选
 * @param text 已规范化查询
 * @returns 等级、边界与跨度代价
 */
function rankKey(candidate: SearchCandidate, text: string): number[] {
  const base = candidate.basename.toLocaleLowerCase('en-US')
  if (base === text) return [0, 0, 0]
  if (base.startsWith(text)) return [1, 0, 0]
  if (base.includes(text)) return [2, 0, 0]
  const cost = text.includes('/') ? null : fuzzyCost(candidate.basename, text)
  if (cost) return [3, ...cost]
  return [candidate.normalizedPath.includes(text) ? 4 : 5, 0, 0]
}

/**
 * @public
 * @author ddj 2026年10月14号
 * @description 每个候选只评分一次，排序不修改调用方数组。
 * @param candidates 候选列表
 * @param query 已规范化 query
 * @returns 排序后的候选
 */
export function rankCandidates(candidates: SearchCandidate[], query: PreparedQuery): SearchCandidate[] {
  const ranked = candidates.map((candidate) => ({ candidate, key: rankKey(candidate, query.text) }))
  ranked.sort((left, right) => left.key[0] - right.key[0] || left.key[1] - right.key[1] || left.key[2] - right.key[2]
    || left.candidate.normalizedPath.localeCompare(right.candidate.normalizedPath, 'en-US')
    || left.candidate.path.localeCompare(right.candidate.path, 'en-US'))
  return ranked.map((item) => item.candidate)
}

/**
 * 默认候选排序器。
 * @author ddj 2026年08月24号
 * @returns 排序器
 */
export function substringRanker(): CandidateRanker {
  return { rank: rankCandidates }
}
