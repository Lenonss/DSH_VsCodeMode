/**
 * dsh-vscode-mode client — 成员补全结果集的形态分类（纯函数，node 可测）。
 *
 * 背景：`ECommon.` 这类成员位置偶尔被错答为**外层作用域集**（`this` 的成员）
 * 或**全局集**（含 `this`/`...` 与大量 `CS_*` xLua 绑定桩），而正确答案应是
 * `ECommon` 自身的字段。根因指向服务器对「刚输入文本」的解析新鲜度，且非确定性。
 * 本模块只做「形态打标」供诊断日志使用，**不改变任何补全结果**。
 *
 * 作者 ddj 2026-09-24
 */
import type { LspCompletionItem } from '../../../shared/lsp.js'

/** 结果集形态：empty 空；globals 全局集；outerScope 外层作用域集；member 成员集；other 其他。 */
export type CompletionSetKind = 'empty' | 'globals' | 'outerScope' | 'member' | 'other'

/** 分类结果：形态 + 计数 + 前几项（供日志与人工判读）。 */
export interface CompletionSetInfo {
  /** 形态标签 */
  kind: CompletionSetKind
  /** 条目总数 */
  total: number
  /** `CS_*` 绑定桩条数 */
  csCount: number
  /** 绑定桩占比（0–1；空集为 0） */
  csRatio: number
  /** 前若干条 label（便于人工判读，不参与判定） */
  head: string[]
}

/**
 * 外层作用域（`this` 成员）特征名。
 *
 * ⚠️ 这是**捕获派生的启发式标记**，不是通用的作用域判定：名单来自 2026-09-24
 * 在 `RechargeHeartView.lua` 真实键盘复现到的 87 条错答样本（`this` 成员列表）。
 * 用途仅是把「疑似外层作用域」的观测标出来供取证；未命中足够标记时归入 `member`，
 * 因此**不会**把正常的成员集误报成外层集。
 */
const INSTANCE_MARKERS = new Set([
  'addframe', 'addtimer', 'clearalltimers', 'buyheart', 'canvas', 'canvasgroup',
])

/**
 * 取条目匹配文本（Monaco 口径：filterText 优先，回落 label）。
 *
 * 与 host 侧 `lsp/completionCap.ts` 的同名私有函数刻意各留一份：两者分属
 * host / client 两个打包平面，不为 3 行逻辑建立跨平面依赖。
 * @author ddj 2026年09月24号
 * @param item 补全项
 * @returns 匹配文本；无可用文本时为空串
 */
function textOfItem(item: LspCompletionItem): string {
  const raw = typeof item?.filterText === 'string' && item.filterText ? item.filterText : item?.label
  return typeof raw === 'string' ? raw : ''
}

/**
 * 依据条目形态判定结果集属于哪一类。
 * @author ddj 2026年09月24号
 * @param lower 全部条目文本（已小写）
 * @param total 条目总数
 * @param csCount `CS_*` 条数
 * @param csRatio `CS_*` 占比
 * @returns 形态标签
 */
function kindOf(lower: string[], total: number, csCount: number, csRatio: number): CompletionSetKind {
  if (total === 0) return 'empty'
  if (lower.includes('this') || lower.includes('...') || csRatio > 0.5) return 'globals'
  if (csCount === 0 && lower.filter((t) => INSTANCE_MARKERS.has(t)).length >= 2) return 'outerScope'
  if (csCount === 0) return 'member'
  return 'other'
}

/**
 * 分类成员补全结果集（纯函数，无副作用）。
 * @author ddj 2026年09月24号
 * @param items 服务器归一化后的补全条目（非数组按空处理）
 * @param headSize 日志携带的前缀条数（缺省 3）
 * @returns 形态、计数与前几项
 */
export function classifyMemberSet(items: LspCompletionItem[], headSize: number = 3): CompletionSetInfo {
  const list = Array.isArray(items) ? items : []
  // 判定用 filterText 优先（与过滤器同口径）；日志展示用 label（人工判读友好）。
  const texts = list.map(textOfItem)
  const lower = texts.map((t) => t.toLowerCase())
  const total = list.length
  const csCount = texts.filter((t) => t.startsWith('CS_')).length
  const csRatio = total ? csCount / total : 0
  const head = list.slice(0, Math.max(0, headSize)).map((item) => String(item?.label ?? ''))
  return { kind: kindOf(lower, total, csCount, csRatio), total, csCount, csRatio, head }
}
