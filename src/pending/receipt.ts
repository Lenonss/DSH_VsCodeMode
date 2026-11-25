/**
 * 工具回执适配：把一次写调用的结果读成「它自己声明改了哪个文件、改前改后是什么」。
 * 只认已见形状；形状不认识一律返回空数组，交给快照判定，绝不猜内容。
 * @author ddj 2026年11月25号
 */
import { OPS_PREFIX } from '../toolTargets.js'

/** 回执强度：authoritative 带前后全文，receipt 只带哈希。 */
export type ReceiptStrength = 'authoritative' | 'receipt'

/** 一次调用对一个文件声明的效果。 */
export interface ToolReceipt {
  /** 工具自己的路径写法（可能是相对路径）。 */
  path: string
  /** 写前文本；`null` = 工具声明该文件此前不存在。 */
  before?: string | null
  /** 写后文本；`null` = 工具声明该文件已被删除。 */
  after?: string | null
  /** 写前 SHA-256（小写十六进制）。 */
  revisionBefore?: string
  /** 写后 SHA-256（小写十六进制）。 */
  revisionAfter?: string
  /** 工具自己声明的完成状态，仅用于诊断。 */
  status: 'completed' | 'failed' | 'unknown' | 'skipped'
  /** 工具明确表示「写前内容给不出来」（超大/二进制/超过上下文上限），before 的 null 不代表文件不存在。 */
  noBasis?: boolean
  strength: ReceiptStrength
}

/** 无类型的结果对象。 */
type Row = Record<string, unknown>

/**
 * @author ddj 2026年11月25号
 * @description: 取工具结果里的规范值；失败结果没有值，直接返回 undefined。
 * @param result 工具执行结果
 * @returns 规范值对象或 undefined
 */
function valueOf(result: unknown): Row | undefined {
  if (!result || typeof result !== 'object') return undefined
  const value = (result as Row & { value?: unknown }).value
  return value && typeof value === 'object' ? value as Row : undefined
}

/**
 * @author ddj 2026年11月25号
 * @description: 读文本字段：字符串即内容，`null` 即声明不存在，其它一律无效。
 * @param value 字段值
 * @returns 文本、null 或 undefined（无效）
 */
function textOf(value: unknown): string | null | undefined {
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}

/**
 * @author ddj 2026年11月25号
 * @description: 读哈希字段；只接受 64 位十六进制，其余（含 `absent`）视为没有。
 * @param value 字段值
 * @returns 小写哈希或 undefined
 */
function hashOf(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : undefined
}

/**
 * @author ddj 2026年11月25号
 * @description: 读路径字段；空串与非字符串都不算路径。
 * @param value 字段值
 * @returns 路径或 undefined
 */
function pathOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * @author ddj 2026年11月25号
 * @description: 官方 edit/write 的回执：结果里直接带 path/before/after。
 * @param name 工具名
 * @param value 规范值
 * @returns 回执列表；形状不符为空
 */
function officialReceipts(name: string, value: Row): ToolReceipt[] {
  const path = pathOf(value.path)
  const before = textOf(value.before)
  const after = textOf(value.after)
  if (!path || before === undefined || after === undefined) return []
  if (name === 'edit' && typeof before !== 'string') return []
  // write 覆盖时 before 可能是 null（超大/二进制，后端不给上下文基线），不能当成新建。
  const receipt: ToolReceipt = { path, before, after, status: 'completed', strength: 'authoritative' }
  if (name === 'write' && before === null && value.operation === 'update') receipt.noBasis = true
  return [receipt]
}

/**
 * @author ddj 2026年11月25号
 * @description: apply_patch 的回执：每个完成或失败操作下挂的 changes 才是实际效果。
 * @param value 规范值
 * @returns 逐文件回执
 */
function patchReceipts(value: Row): ToolReceipt[] {
  if (value.phase !== 'commit' || !Array.isArray(value.operations)) return []
  const receipts: ToolReceipt[] = []
  for (const raw of value.operations as unknown[]) {
    if (!raw || typeof raw !== 'object') continue
    const operation = raw as Row & { status?: unknown; changes?: unknown }
    if (!Array.isArray(operation.changes)) continue
    const status = operation.status === 'completed' ? 'completed' : operation.status === 'failed' ? 'failed' : 'skipped'
    for (const change of operation.changes as unknown[]) {
      if (!change || typeof change !== 'object') continue
      const item = change as Row
      const path = pathOf(item.path)
      const before = textOf(item.before)
      const after = textOf(item.after)
      if (!path || before === undefined || after === undefined) continue
      receipts.push({ path, before, after, status, strength: 'authoritative' })
    }
  }
  return receipts
}

/**
 * @author ddj 2026年11月25号
 * @description: 批量替换回执：只认执行完成、且带写后计划的条目。
 * @param items 回执条目
 * @returns 逐文件回执
 */
function replaceReceipts(items: unknown[]): ToolReceipt[] {
  const receipts: ToolReceipt[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Row
    const path = pathOf(item.path)
    const revisionAfter = hashOf(item.revisionAfter)
    if (!path || item.status !== 'completed' || !revisionAfter) continue
    receipts.push({
      path, revisionBefore: hashOf(item.revision), revisionAfter, status: 'completed', strength: 'receipt',
    })
  }
  return receipts
}

/**
 * @author ddj 2026年11月25号
 * @description: dsh-ops 回执：单目标带 path/to 与写前后哈希；删除没有写后哈希，交给快照。
 * @param value 规范值
 * @returns 回执列表
 */
function opsReceipts(value: Row): ToolReceipt[] {
  if (Array.isArray(value.items)) return replaceReceipts(value.items as unknown[])
  // 删除没有写后内容：回执里的 revision 是写前值，不能当写后哈希用，交给快照。
  if (value.removed === true) return []
  const revisionAfter = hashOf(value.revision)
  if (!revisionAfter) return []
  const path = pathOf(value.to) ?? pathOf(value.path)
  if (!path) return []
  return [{ path, revisionBefore: hashOf(value.revisionBefore), revisionAfter, status: 'completed', strength: 'receipt' }]
}

/**
 * @public
 * @author ddj 2026年11月25号
 * @description: 把一次写调用的结果转成回执；不认识的结果与工具返回空，调用方退回快照判定。
 * @param name 工具名
 * @param result 工具执行结果（可能带 value 包装）
 * @param isError 工具是否报错
 * @returns 回执列表
 */
export function receiptsOf(name: string, result: unknown, isError: boolean): ToolReceipt[] {
  if (isError && name !== 'apply_patch') return []
  const value = valueOf(result)
  if (!value) return []
  if (name === 'edit' || name === 'write') return officialReceipts(name, value)
  if (name === 'apply_patch') return patchReceipts(value)
  if (String(name).startsWith(OPS_PREFIX)) return opsReceipts(value)
  return []
}
