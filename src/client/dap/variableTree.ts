/**
 * dsh-vscode-mode client — DAP 变量树纯函数。
 * 把 DAP variablesReference 缓存展平成可渲染 sibling rows，避免把子行嵌套进父级
 * 横向 flex 行导致变量重叠；同时限制递归深度与总行数，保护侧栏性能。
 * 作者 ddj 2026年09月29号
 */

/** DAP 变量最小视图。 */
export interface VariableLike {
  name: string
  value: string
  type?: string
  ref: number
}

/** 展平后的变量行。 */
export interface VariableRow {
  key: string
  variable: VariableLike
  depth: number
}

/** 展平选项。 */
export interface VariableTreeOptions {
  maxRows?: number
  maxDepth?: number
}

/**
 * 将变量树展平为 sibling rows；循环 ref 只展开一次，避免异常适配器数据造成递归。
 * @author ddj 2026年09月29号
 * @param roots 根变量
 * @param expanded 已展开的 variablesReference
 * @param cache ref → 子变量缓存
 * @param options 行数/深度上限
 */
export function flattenVariableRows(
  roots: readonly VariableLike[],
  expanded: ReadonlySet<number>,
  cache: ReadonlyMap<number, readonly VariableLike[]>,
  options: VariableTreeOptions = {},
): VariableRow[] {
  const rows: VariableRow[] = []
  const maxRows = options.maxRows ?? 1000
  const maxDepth = options.maxDepth ?? 32
  const walk = (items: readonly VariableLike[], depth: number, ancestry: ReadonlySet<number>, prefix: string): void => {
    if (depth > maxDepth || rows.length >= maxRows) return
    for (let index = 0; index < items.length && rows.length < maxRows; index += 1) {
      const variable = items[index]
      const key = prefix + '/' + index + ':' + variable.name
      rows.push({ key, variable, depth })
      if (variable.ref <= 0 || !expanded.has(variable.ref) || ancestry.has(variable.ref)) continue
      const children = cache.get(variable.ref)
      if (!children?.length) continue
      const nextAncestry = new Set(ancestry)
      nextAncestry.add(variable.ref)
      walk(children, depth + 1, nextAncestry, key)
    }
  }
  walk(roots, 0, new Set(), 'root')
  return rows
}
