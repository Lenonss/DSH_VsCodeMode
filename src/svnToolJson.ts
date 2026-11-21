/**
 * dsh-vscode-mode host — agent 工具输出归一（无损 JSON）。
 *
 * 为什么必须归一：DSH 0.2.x 的 dsh-tools 会用 snapshotJsonValue 快照每个工具结果，
 * 只要出现 §undefined§ / NaN / 稀疏数组 / 非普通对象，**整次调用**就以
 * "value is not lossless JSON" 失败——而 svn 的结构化载荷本来就有大量可选字段
 * （未版本化条目没有 revision、不带 -v 的 log 没有 paths…），因此统一出口归一一次。
 * @author ddj 2026年11月15号
 */

/** 单字段字符串上限（超长截断并留标记）。 */
export const TOOL_FIELD_MAX = 8 * 1024

/** 单次工具输出总字节上限（防超大载荷拖慢会话）。 */
export const TOOL_TOTAL_MAX = 200 * 1024

/**
 * 深度归一为无损 JSON 值：丢 undefined/函数/Symbol，NaN/Infinity → null，
 * 数组空洞 → null，类实例 → 普通对象，循环引用 → null，字符串超长截断。
 * @author ddj 2026年11月15号
 * @param value 任意值
 * @returns 可安全 JSON 序列化的值
 */
/** 「丢弃该属性」哨兵（与 null 区分：undefined/函数如实省略，循环引用才补 null）。 */
const DROP = Symbol('drop')

export function toLosslessJson(value: unknown): unknown {
  const seen = new WeakSet<object>()

  /** @author ddj 2026年11月15号 @param input 任意值 @returns 归一值 */
  function walk(input: unknown): unknown {
    if (input === null) return null
    const type = typeof input
    if (type === 'string') return (input as string).length > TOOL_FIELD_MAX ? (input as string).slice(0, TOOL_FIELD_MAX) : input
    if (type === 'number') return Number.isFinite(input as number) ? input : null
    if (type === 'boolean') return input
    if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') return DROP
    if (type !== 'object') return null

    const object = input as object
    if (seen.has(object)) return null
    seen.add(object)
    if (Array.isArray(object)) {
      const out: unknown[] = []
      for (let i = 0; i < object.length; i++) {
        const next = i in object ? walk(object[i]) : null
        out.push(next === DROP ? null : next)
      }
      return out
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(object as Record<string, unknown>)) {
      const next = walk(item)
      if (next === DROP) continue
      out[key] = next
    }
    return out
  }

  return walk(value)
}

/**
 * 工具结果 → 提供给模型的文本（无损 JSON + 总量截断）。
 * @author ddj 2026年11月15号
 * @param value 工具结果（任意形状）
 * @returns JSON 文本（超总上限时附截断标记）
 */
export function toolJsonText(value: unknown): string {
  const json = JSON.stringify(toLosslessJson(value)) ?? 'null'
  if (json.length <= TOOL_TOTAL_MAX) return json
  return JSON.stringify({ ok: false, truncated: true, error: '工具输出超限（' + json.length + ' 字符），请缩小范围重试' })
}
