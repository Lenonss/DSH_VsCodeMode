/** DAP hover 变量树：成员全量直显/折叠判定/上限保护/转义 纯逻辑测试。作者 ddj 2026年09月21号 */
import { describe, expect, it } from 'vitest'
import {
  clipValue,
  createTreeState,
  escapeHtml,
  hintText,
  initialHtml,
  LSP_PLACEHOLDER_TEXT,
  needsLspPlaceholder,
  rowAt,
  rowHtml,
  rowPlan,
  rowsOf,
  sameRoots,
  MAX_DEPTH,
  MAX_ROWS,
  TREE_ATTR,
  VALUE_CLIP,
  type TreeNode,
} from '../src/client/dap/hoverTree.js'

/** 变量桩。 */
const node = (name: string, value: string, ref = 0): TreeNode => ({ name, value, ref })

describe('hoverTree 行生成', () => {
  it('根级行按 ref 判定可展开，并带稳定路径', () => {
    const state = createTreeState('k', [node('a', '1'), node('t', 'table: 0x1', 9)])
    const rows = rowsOf(state, '', 0, [])
    expect(rows).toHaveLength(2)
    expect(rows[0].path).toBe('r0')
    expect(rows[0].expandable).toBe(false)
    expect(rows[1].expandable).toBe(true)
    expect(rows[1].depth).toBe(0)
  })

  it('循环 ref 不再可展开（同一 ref 出现在祖先链里）', () => {
    const state = createTreeState('k', [node('t', 'table: 0x1', 9)])
    state.cache.set('r0', [node('self', 'table: 0x1', 9)])
    const rows = rowsOf(state, 'r0', 1, [9])
    expect(rows[0].expandable).toBe(false)
  })

  it('到达最大深度后不再可展开', () => {
    const state = createTreeState('k', [node('t', 'table: 0x1', 9)])
    expect(rowAt(state, '', MAX_DEPTH, [], 0).expandable).toBe(false)
    expect(rowAt(state, '', MAX_DEPTH - 1, [], 0).expandable).toBe(true)
  })

  it('成员全量直显：60 个成员全部出列，且不再出现「还有 N 项」行', () => {
    const roots = Array.from({ length: 60 }, (_item, index) => node('f' + index, String(index)))
    const state = createTreeState('k', roots)
    const rows = rowsOf(state, '', 0, [])
    expect(rows).toHaveLength(60)
    expect(rows[59].path).toBe('r59')
    const html = rows.map((row) => rowHtml(row, false)).join('')
    expect(html).not.toContain('edrv-dap-more')
    expect(html).not.toContain('还有')
  })

  it('每层子项同样全量直显（不再按 50 条截断）', () => {
    const state = createTreeState('k', [node('t', 'table: 0x1', 9)])
    state.cache.set('r0', Array.from({ length: 120 }, (_item, index) => node('c' + index, String(index))))
    expect(rowsOf(state, 'r0', 1, [])).toHaveLength(120)
  })

  it('budget 收窄时只渲染预算内行数（DOM 保护）', () => {
    const roots = Array.from({ length: 30 }, (_item, index) => node('f' + index, String(index)))
    const state = createTreeState('k', roots)
    expect(rowsOf(state, '', 0, [], 5)).toHaveLength(5)
    expect(rowsOf(state, '', 0, [], 0)).toHaveLength(0)
  })
})

describe('hoverTree HTML 渲染', () => {
  it('完整转义名称/值（调试值可能含 HTML）', () => {
    expect(escapeHtml('<img src=x onerror="1">')).toBe('&lt;img src=x onerror=&quot;1&quot;&gt;')
    const state = createTreeState('k', [node('<b>name', '<script>alert(1)</script>')])
    const html = rowHtml(rowsOf(state, '', 0, [])[0], false)
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('超长值截断并把完整值放进 title', () => {
    const long = 'x'.repeat(VALUE_CLIP + 10)
    expect(clipValue(long)).toHaveLength(VALUE_CLIP + 1)
    const state = createTreeState('k', [node('k', long)])
    const html = rowHtml(rowsOf(state, '', 0, [])[0], false)
    expect(html).toContain('title="' + long + '"')
  })

  it('可展开行给折叠按钮，不可展开行留空占位', () => {
    const state = createTreeState('k', [node('a', '1'), node('t', 'table: 0x1', 9)])
    const rows = rowsOf(state, '', 0, [])
    expect(rowHtml(rows[0], false)).toContain('<span data-edrv-twist="1"></span>')
    expect(rowHtml(rows[1], false)).toContain('▸')
    expect(rowHtml(rows[1], true)).toContain('▾')
  })

  it('初始 HTML 带树标记与 hover 键；无可渲染行时返回空串', () => {
    const state = createTreeState('k1', [node('a', '1')])
    const html = initialHtml(state)
    expect(html).toContain(TREE_ATTR + '="1"')
    expect(html).toContain('data-edrv-key="k1"')
    expect(initialHtml(createTreeState('k2', []))).toBe('')
  })

  it('超过行数上限时给出上限提示行（不再给「点击加载」）', () => {
    const roots = Array.from({ length: MAX_ROWS + 5 }, (_item, index) => node('f' + index, String(index)))
    const state = createTreeState('k', roots)
    const html = initialHtml(state)
    expect(html.match(/data-edrv-path=/g) ?? []).toHaveLength(MAX_ROWS)
    expect(html).toContain('data-edrv-note="limit"')
    expect(html).toContain('已达行数上限（' + String(MAX_ROWS) + '）')
  })
})

describe('hoverTree 状态复用与 Alt 行计划', () => {
  it('同 key 且根级等价 → 复用状态（保留展开与缓存，避免点开又被收起）', () => {
    const first = createTreeState('reuse', [node('t', 'table: 0x1', 9)])
    first.cache.set('r0', [node('a', '1')])
    first.expanded.add('r0')
    const again = createTreeState('reuse', [node('t', 'table: 0x9', 9)]) // 值变、名+ref 未变
    expect(again).toBe(first)
    expect(again.expanded.has('r0')).toBe(true)
    expect(again.cache.get('r0')?.[0].name).toBe('a')
  })

  it('根级变化 → 重建状态（展开与缓存清空）', () => {
    const first = createTreeState('rebuild', [node('a', '1')])
    first.expanded.add('r0')
    const second = createTreeState('rebuild', [node('a', '1'), node('b', '2')])
    expect(second).not.toBe(first)
    expect(second.expanded.size).toBe(0)
  })

  it('sameRoots 按名 + ref 判等（值与 type 不参与）', () => {
    expect(sameRoots([node('a', '1', 3)], [node('a', '99', 3)])).toBe(true)
    expect(sameRoots([node('a', '1', 3)], [node('a', '1', 4)])).toBe(false)
    expect(sameRoots([node('a', '1')], [])).toBe(false)
  })

  it('rowPlan / hintText：Alt 决定调试块与 LSP 行显隐与提示文案', () => {
    expect(rowPlan(false)).toEqual({ debug: true, lsp: false })
    expect(rowPlan(true)).toEqual({ debug: false, lsp: true })
    expect(hintText(false)).toContain('按住 Alt')
    expect(hintText(true)).toContain('松开 Alt')
  })

  it('needsLspPlaceholder：Alt 按住且真实 LSP 行未到时才补占位行', () => {
    expect(needsLspPlaceholder(true, false)).toBe(true)
    expect(needsLspPlaceholder(true, true)).toBe(false)
    expect(needsLspPlaceholder(false, false)).toBe(false)
    expect(LSP_PLACEHOLDER_TEXT).toContain('LSP')
  })
})
