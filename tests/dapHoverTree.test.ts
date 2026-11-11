/** DAP hover 变量树：成员全量直显/折叠判定/上限保护/转义 纯逻辑测试。作者 ddj 2026年09月21号 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyAltToHovers,
  disposeHoverTree,
  installHoverTree,
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

/** 最小 DOM 行为桩，只实现本模块使用的查询与属性契约。 */
class HoverElement {
  nodeType = 1
  isConnected = true
  style = { display: '' }
  attrs = new Map<string, string>()
  parent: HoverElement | null = null
  children: HoverElement[] = []
  writes = 0
  private text = ''
  querySelectorAll = vi.fn((selector: string): HoverElement[] => {
    const matches: HoverElement[] = []
    for (const child of this.children) {
      if (child.matches(selector)) matches.push(child)
      matches.push(...child.querySelectorAll(selector))
    }
    return matches
  })
  addEventListener = vi.fn()

  /** @public @author ddj 2026年11月06号 @description 创建指定 CSS 类的元素桩。 @param classes 类名 */
  constructor(public classes = '') {}
  /** @public @author ddj 2026年11月06号 @description 读取文本。 @returns 文本 */
  get textContent(): string { return this.text }
  /** @public @author ddj 2026年11月06号 @description 统计文本写入。 @param message 文本 */
  set textContent(message: string) { this.text = message; this.writes += 1 }
  /** @public @author ddj 2026年11月06号 @description 匹配使用到的选择器。 @param selector 选择器 @returns 是否匹配 */
  matches(selector: string): boolean {
    for (const part of selector.split(', ')) {
      const required = part.match(/^\.([\w-]+)/)?.[1]
      if (required && !this.classes.split(' ').includes(required)) continue
      const attr = part.match(/\[([\w-]+)\]/)?.[1]
      if (attr && !this.attrs.has(attr)) continue
      const excluded = part.match(/:not\(\[([\w-]+)\]\)/)?.[1]
      if (excluded && this.attrs.has(excluded)) continue
      return true
    }
    return false
  }
  /** @public @author ddj 2026年11月06号 @description 查找最近归属。 @param selector 选择器 @returns 归属元素 */
  closest(selector: string): HoverElement | null {
    if (this.matches(selector)) return this
    return this.parent?.closest(selector) ?? null
  }
  /** @public @author ddj 2026年11月06号 @description 查询首个后代。 @param selector 选择器 @returns 后代 */
  querySelector(selector: string): HoverElement | null { return this.querySelectorAll(selector)[0] ?? null }
  /** @public @author ddj 2026年11月06号 @description 追加子节点。 @param child 子节点 */
  appendChild(child: HoverElement): void { child.parent = this; this.children.push(child) }
  /** @public @author ddj 2026年11月06号 @description 写属性。 @param name 属性名 @param content 属性值 */
  setAttribute(name: string, content: string): void { this.attrs.set(name, content) }
  /** @public @author ddj 2026年11月06号 @description 读属性。 @param name 属性名 @returns 属性值 */
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null }
  /** @public @author ddj 2026年11月06号 @description 判断属性。 @param name 属性名 @returns 是否存在 */
  hasAttribute(name: string): boolean { return this.attrs.has(name) }
  /** @public @author ddj 2026年11月06号 @description 清理属性。 @param name 属性名 */
  removeAttribute(name: string): void { this.attrs.delete(name) }
  /** @public @author ddj 2026年11月06号 @description 从父节点移除自身。 */
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this)
    this.isConnected = false
  }
}

/** 变量桩。 */
const node = (name: string, value: string, ref = 0): TreeNode => ({ name, value, ref })

/** @private @author ddj 2026年11月06号 @description 创建 DOM 监听测试环境。 @returns 桩与变更入口 */
function hoverHarness() {
  const body = new HoverElement()
  const disconnect = vi.fn()
  const observe = vi.fn()
  let callback: MutationCallback = () => undefined
  const doc = { body, querySelectorAll: vi.fn(() => []), createElement: () => new HoverElement() }
  class Observer {
    /** @public @author ddj 2026年11月06号 @description 捕获监听回调。 @param handler 回调 */
    constructor(handler: MutationCallback) { callback = handler }
    observe = observe
    disconnect = disconnect
  }
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.stubGlobal('document', doc)
  vi.stubGlobal('MutationObserver', Observer)
  installHoverTree()

  /** @private @author ddj 2026年11月06号 @description 派发指定目标的批量变更。 @param target 变更容器 @param added 新增节点 */
  function emit(target: HoverElement, ...added: HoverElement[]): void {
    callback([{ target, addedNodes: added } as unknown as MutationRecord], {} as MutationObserver)
  }
  return { body, doc, emit, observe, disconnect }
}

/** @private @author ddj 2026年11月06号 @description 组装真实调试浮窗的最小结构。 @returns 浮窗及子节点 */
function debugHover() {
  const hover = new HoverElement('monaco-hover')
  const content = new HoverElement('monaco-hover-content')
  const row = new HoverElement('hover-row')
  const block = new HoverElement()
  block.setAttribute('data-edrv-dap', '1')
  const tree = new HoverElement()
  tree.setAttribute(TREE_ATTR, '1')
  block.appendChild(tree)
  row.appendChild(block)
  content.appendChild(row)
  hover.appendChild(content)
  return { hover, content, row, tree }
}

// 每次先清理监听与待绑定队列，再还原全局，避免跨测试共享 DOM 状态。
afterEach(() => {
  disposeHoverTree()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('hoverTree DOM 热路径', () => {
  it.each(['view-lines', 'margin-view-overlays', 'view-overlays', 'minimap', 'edrv-del-zone', 'edrv-del-margin'])('%s 大批新增代码行不查询后代、不调度任务', classes => {
    const env = hoverHarness()
    const target = new HoverElement(classes)
    const lines = Array.from({ length: 1000 }, () => new HoverElement('view-line'))
    env.emit(target, ...lines)
    expect(lines.every(line => line.querySelectorAll.mock.calls.length === 0)).toBe(true)
    expect(target.querySelectorAll).not.toHaveBeenCalled()
    expect(env.doc.querySelectorAll).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('外层整体插入发现多个浮窗，去重并仅绑定各自的树', () => {
    const env = hoverHarness()
    const wrapper = new HoverElement()
    const first = debugHover()
    const second = debugHover()
    wrapper.appendChild(first.hover)
    wrapper.appendChild(second.hover)
    env.emit(env.body, wrapper)
    env.emit(first.content, new HoverElement())
    expect(vi.getTimerCount()).toBe(1)
    vi.runAllTimers()
    expect(first.tree.addEventListener).toHaveBeenCalledTimes(2)
    expect(second.tree.addEventListener).toHaveBeenCalledTimes(2)
    expect(env.doc.querySelectorAll).not.toHaveBeenCalled()
  })

  it('异步 LSP 行立即应用 Alt 状态，相同提示不重复写入', () => {
    const env = hoverHarness()
    applyAltToHovers(true)
    const panel = debugHover()
    env.emit(env.body, panel.hover)
    expect(panel.row.style.display).toBe('none')
    const hint = panel.hover.querySelector('[data-edrv-hint]')!
    const writes = hint.writes
    const lsp = new HoverElement('hover-row')
    panel.content.appendChild(lsp)
    env.emit(panel.content, lsp)
    expect(lsp.style.display).toBe('')
    expect(panel.content.querySelector('[data-edrv-placeholder]')).toBeNull()
    expect(hint.writes).toBe(writes)
    // 模拟自身提示文字变更带来的记录；不再反复写入 childList。
    env.emit(hint)
    expect(hint.writes).toBe(writes)
    applyAltToHovers(false)
    env.emit(panel.content)
    expect(panel.row.style.display).toBe('')
    expect(lsp.style.display).toBe('none')
  })

  it('安装幂等；卸载取消局部任务，重装不残留旧容器', () => {
    const env = hoverHarness()
    installHoverTree()
    expect(env.observe).toHaveBeenCalledTimes(1)
    const panel = debugHover()
    env.emit(env.body, panel.hover)
    disposeHoverTree()
    expect(env.disconnect).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    installHoverTree()
    vi.runAllTimers()
    expect(panel.tree.addEventListener).not.toHaveBeenCalled()
    expect(env.observe).toHaveBeenCalledTimes(2)
  })

  it('已脱离文档的浮窗不绑定', () => {
    const env = hoverHarness()
    const panel = debugHover()
    env.emit(env.body, panel.hover)
    panel.hover.isConnected = false
    vi.runAllTimers()
    expect(panel.tree.addEventListener).not.toHaveBeenCalled()
  })
})

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
