/**
 * dsh-vscode-mode host — 可替换的连续匹配排序器。
 * 第一版保持 basename 优先和稳定路径序，后续可接 fuzzy scorer。
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
 * 对连续匹配候选进行排序。
 * @author ddj 2026年08月24号
 * @param candidates 候选列表
 * @param query 已规范化 query
 * @returns 排序后的候选
 */
export function rankCandidates(candidates: SearchCandidate[], query: PreparedQuery): SearchCandidate[] {
  const text = query.text
  const score = (candidate: SearchCandidate): number => {
    const base = candidate.basename.toLocaleLowerCase('en-US')
    if (base.startsWith(text)) return 0
    if (base.includes(text)) return 1
    if (candidate.normalizedPath.includes(text)) return 2
    return 3
  }
  return [...candidates].sort((left, right) => score(left) - score(right) || left.normalizedPath.localeCompare(right.normalizedPath, 'en-US'))
}

/**
 * 默认候选排序器。
 * @author ddj 2026年08月24号
 * @returns 排序器
 */
export function substringRanker(): CandidateRanker {
  return { rank: rankCandidates }
}
