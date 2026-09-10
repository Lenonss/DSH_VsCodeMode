/**
 * dsh-vscode-mode client — 命令栏筛选与排序（纯函数，可单测）。
 * 匹配语义：查询与索引文本统一小写，空格分词，全部 token 需在 label/id/category
 * 任一字段中以子串出现（中文子串匹配天然成立）。
 * 排序语义：命中字段权重（label 0 < id 1 < category 2）+ 目录序（order 缺省 100）+ 注册序，
 * 保证同一查询下结果稳定、越相关的越靠前。
 * 作者 ddj 2026年09月10号
 */
import type { CommandDef } from './ui/commandCatalog.js'

/** 排序用基础序（未声明 order 的命令排在已声明之后）。 */
const DEFAULT_ORDER = 100

/** 命中字段权重（数值越小越优先）。 */
const FIELD_WEIGHT: Record<string, number> = { label: 0, id: 1, category: 2 }

/** 命令栏候选行（命令定义 + 匹配权重）。 */
export interface CommandHit {
  command: CommandDef
  weight: number
}

/** 命中字段索引文本（小写）。 */
interface IndexedFields {
  label: string
  id: string
  category: string
}

/** 小写化（非字符串按空串处理，容错外部脏数据）。 */
function lower(text: unknown): string {
  return typeof text === 'string' ? text.toLocaleLowerCase('en-US') : ''
}

/** 建立一条命令的索引文本。 */
function indexOf(command: CommandDef): IndexedFields {
  return { label: lower(command.label), id: lower(command.id), category: lower(command.category) }
}

/**
 * 命令是否命中全部 token；命中时返回最优（最小）字段权重。
 * @author ddj 2026年09月10号
 * @param fields 命令索引文本
 * @param tokens 小写查询 token
 * @returns 字段权重；未命中返回 null
 */
function hitWeight(fields: IndexedFields, tokens: readonly string[]): number | null {
  let best: number | null = null
  for (const token of tokens) {
    let tokenWeight: number | null = null
    for (const field of ['label', 'id', 'category'] as const) {
      if (!fields[field].includes(token)) continue
      const weight = FIELD_WEIGHT[field]
      if (tokenWeight === null || weight < tokenWeight) tokenWeight = weight
      if (weight === 0) break
    }
    if (tokenWeight === null) return null
    if (best === null || tokenWeight < best) best = tokenWeight
  }
  return best
}

/** 目录序（order 缺省 100；非有限值同样按 100）。 */
function orderOf(command: CommandDef): number {
  const order = command.order
  return typeof order === 'number' && Number.isFinite(order) ? order : DEFAULT_ORDER
}

/**
 * 过滤并按相关度排序命令（空查询返回全部，仅按目录序排序）。
 * @author ddj 2026年09月10号
 * @param commands 候选命令（调用方通常已按可用性过滤）
 * @param query 用户输入
 * @returns 命中命令数组
 */
export function filterCommands(commands: readonly CommandDef[], query: string): CommandDef[] {
  const tokens = lower(query).split(/\s+/).filter(Boolean)
  const hits: CommandHit[] = []
  for (const command of commands) {
    const weight = tokens.length ? hitWeight(indexOf(command), tokens) : 0
    if (weight !== null) hits.push({ command, weight })
  }
  return hits
    .map((hit, index) => ({ hit, index }))
    .sort((a, b) => a.hit.weight - b.hit.weight
      || orderOf(a.hit.command) - orderOf(b.hit.command)
      || a.index - b.index)
    .map((entry) => entry.hit.command)
}
