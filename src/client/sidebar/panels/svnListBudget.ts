/**
 * dsh-vscode-mode client — SVN 变更列表渐进渲染的预算切分（纯函数，可单测）。
 *
 * 为什么不虚拟滚动：工程无虚拟列表基建，且 changelist 分组头与「显示更多」尾部
 * 天然兼容渐进展示——预算切分即可把单次渲染行数从全量（host 上限 4000）压到预算内。
 * 为什么独立成模块：SvnPanel 顶部引 React 与 UI 原语（图标跨版本垫片），
 * 纯函数放同文件会拖进重依赖链，单测无法轻量导入。
 * 作者 ddj 2026年09月23号
 */
import type { SvnChangeEntry } from '../../../shared/svn.js'

/** 分组行（groupByChangelist 产出形态）。 */
interface SvnGroup {
  /** changelist 名（未分组为固定文案）。 */
  name: string
  /** 组内条目（工作副本原顺序）。 */
  entries: SvnChangeEntry[]
}

/** 预算切分结果：预算内组透传原对象，被截断组带 full（全量计数）、折叠组带 folded 标记供组头展示。 */
export interface SvnBudget {
  groups: Array<SvnGroup & { full?: number; folded?: boolean }>
  /** 预算内条数（本次实际渲染行数）。 */
  shown: number
  /** 全量条数。 */
  total: number
  /** 是否还有未渲染行。 */
  hasMore: boolean
}

/**
 * 按 DOM 预算切分分组行（渐进渲染）。
 *
 * 预算跨组依序分配：预算内组整组保留（透传原对象，引用稳定利于行 memo），
 * 最后触及预算的组被截断，预算耗尽后不再产出**需要行数**的组；
 * 零行组（如折叠映射的空 entries 组）不占预算，恒产出组头。
 * 组头计数恒显全量（full），行只渲染预算内（entries），避免「截断组计数变小」的误导。
 * @author ddj 2026年09月23号
 * @param groups groupByChangelist 产出的分组
 * @param budget 允许渲染的条目行数上限
 * @returns 截断后的分组与计数
 */
export function budgetGroupsOf(groups: readonly SvnGroup[], budget: number): SvnBudget {
  const total = groups.reduce((sum, group) => sum + group.entries.length, 0)
  const limit = Math.max(0, budget)
  if (total <= limit) return { groups: [...groups], shown: total, total, hasMore: false }
  const sliced: Array<SvnGroup & { full?: number; folded?: boolean }> = []
  let used = 0
  for (const group of groups) {
    if (used >= limit && group.entries.length > 0) break
    const take = Math.min(group.entries.length, limit - used)
    sliced.push(take >= group.entries.length
      ? group
      : { name: group.name, entries: group.entries.slice(0, take), full: group.entries.length })
    used += take
  }
  return { groups: sliced, shown: used, total, hasMore: true }
}
