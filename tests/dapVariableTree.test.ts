/** DAP 变量树展平测试。作者 ddj 2026年09月29号 */
import { describe, expect, it } from 'vitest'
import { flattenVariableRows } from '../src/client/dap/variableTree.js'

describe('flattenVariableRows', () => {
  it('把子变量展平为独立 sibling rows并保留深度', () => {
    const roots = [{ name: 'this', value: 'table', ref: 10 }]
    const cache = new Map([[10, [
      { name: 'itemId', value: '3', ref: 0 },
      { name: 'model', value: 'table', ref: 11 },
    ]], [11, [{ name: 'name', value: 'x', ref: 0 }]]])
    const rows = flattenVariableRows(roots, new Set([10, 11]), cache)
    expect(rows.map((row) => [row.variable.name, row.depth])).toEqual([
      ['this', 0], ['itemId', 1], ['model', 1], ['name', 2],
    ])
  })

  it('循环 ref 不递归爆炸且受行数上限约束', () => {
    const roots = [{ name: 'self', value: 'table', ref: 1 }]
    const cache = new Map([[1, [{ name: 'self', value: 'table', ref: 1 }]]])
    const rows = flattenVariableRows(roots, new Set([1]), cache, { maxRows: 10 })
    expect(rows).toHaveLength(2)
  })
})
