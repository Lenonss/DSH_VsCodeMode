/**
 * dsh-vscode-mode host — 补全结果的前缀感知截断（纯函数，node 可测）。
 * 背景：RPC 层按固定上限硬截断补全条目，而本仓库的 xLua 绑定桩
 * （Assets/Scripts/EmmyLuaDefine，形如 CS_IslandSplash_Extensions_Common_ArrayExtension）
 * 有上万个全局，字母序会把项目自身全局（ECommon / EActivity 等）挤到上限之外；
 * 截断发生在 Monaco 前缀过滤之前，因此**之后无论输入什么都取不回**该条目。
 * 改为按当前输入前缀分桶后截断：优先保留真实命中的条目；未超限时零行为变化。
 * 作者 ddj 2026年09月24号
 */
import type { LspCompletionItem } from '../shared/lsp.js'

/** 单次补全返回条目上限（RPC 载荷护栏，与 references 同口径）。 */
export const COMPLETION_ITEM_CAP = 500

/** 截断结果：items 恒不超上限；truncated 标记本轮是否发生了丢弃。 */
export interface CappedCompletions {
  items: LspCompletionItem[]
  truncated: boolean
}

/**
 * 判断 needle 是否为 haystack 的子序列（两侧均已小写）。
 *
 * 与 Monaco 候选列表的模糊匹配同口径，保证「分桶判为命中」的条目确实是
 * 用户输入能筛出来的那些，避免分桶顺序与前端过滤结果互相矛盾。
 * @author ddj 2026年09月24号
 * @param haystack 候选文本（已小写）
 * @param needle 输入前缀（已小写、非空）
 * @returns 是否为子序列
 */
function isSubsequence(haystack: string, needle: string): boolean {
  let matched = 0
  for (let i = 0; i < haystack.length && matched < needle.length; i++) {
    if (haystack[i] === needle[matched]) matched++
  }
  return matched === needle.length
}

/**
 * 取补全项的匹配文本（Monaco 口径：filterText 优先，回落 label；统一小写）。
 * @author ddj 2026年09月24号
 * @param item 补全项
 * @returns 小写匹配文本；无可用文本时为空串
 */
function textOfItem(item: LspCompletionItem): string {
  const raw = typeof item?.filterText === 'string' && item.filterText ? item.filterText : item?.label
  return typeof raw === 'string' ? raw.toLowerCase() : ''
}

/**
 * 按输入前缀分桶后截断补全列表。
 *
 * 分桶优先级：startsWith > includes > 子序列 > 其余；桶内保持服务器原始顺序
 * （服务器已按相关性排序，不重新打分）。无前缀或未超限时与旧行为完全一致。
 * @author ddj 2026年09月24号
 * @param items 服务器归一化后的补全条目
 * @param prefix 当前输入前缀（Monaco getWordUntilPosition 的词）
 * @param cap 条目上限（缺省 COMPLETION_ITEM_CAP；测试可注入小值）
 * @returns 有界条目与截断标记
 */
export function capCompletions(
  items: LspCompletionItem[],
  prefix?: string,
  cap: number = COMPLETION_ITEM_CAP,
): CappedCompletions {
  if (!Array.isArray(items)) return { items: [], truncated: false }
  if (items.length <= cap) return { items, truncated: false }
  const needle = String(prefix ?? '').toLowerCase()
  if (!needle) return { items: items.slice(0, cap), truncated: true }
  const buckets: LspCompletionItem[][] = [[], [], [], []]
  for (const item of items) {
    const text = textOfItem(item)
    if (text.startsWith(needle)) buckets[0].push(item)
    else if (text.includes(needle)) buckets[1].push(item)
    else if (isSubsequence(text, needle)) buckets[2].push(item)
    else buckets[3].push(item)
  }
  const ordered = buckets[0].concat(buckets[1], buckets[2], buckets[3])
  return { items: ordered.slice(0, cap), truncated: true }
}
