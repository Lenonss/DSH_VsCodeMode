import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 轻量提交模型：运行真实 SearchPanel，先写 input.value，再执行 layout/passive effects。
// 不模拟浏览器实现；GUI 焦点最终仍需现有实例冒烟。
const hooks = vi.hoisted(() => ({ index: 0, slots: [] as any[], dirty: false,
  layout: [] as Array<() => void>, passive: [] as Array<() => void>, rpc: vi.fn() }))
vi.mock('../src/client/rpc.js', () => ({ rpc: hooks.rpc }))
vi.mock('react', async (original) => {
  const real = await original<any>()
  const React = { ...real.default }
  /** @private @author ddj 2026年10月14号 @param initial 初始值 @returns 状态和更新方法 */
  React.useState = (initial: any) => {
    const index = hooks.index++
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial
    /** @private @author ddj 2026年10月14号 @param next 新状态或更新器 @description 标记下一次提交 */
    const set = (next: any) => {
      const value = typeof next === 'function' ? next(hooks.slots[index]) : next
      if (value !== hooks.slots[index]) { hooks.slots[index] = value; hooks.dirty = true }
    }
    return [hooks.slots[index], set]
  }
  /** @private @author ddj 2026年10月14号 @param initial 初始值 @returns 稳定 ref */
  React.useRef = (initial: any) => React.useState({ current: initial })[0]
  /** @private @author ddj 2026年10月14号 @param effect 副作用 @param deps 依赖 @param queue 提交阶段队列 */
  function queueEffect(effect: any, deps: any[], queue: Array<() => void>) {
    const index = hooks.index++
    const old = hooks.slots[index]
    if (old && deps.every((value, i) => value === old.deps[i])) return
    queue.push(() => { old?.cleanup?.(); hooks.slots[index] = { deps, cleanup: effect() } })
  }
  /** @private @author ddj 2026年10月14号 @param effect 副作用 @param deps 依赖 */
  React.useEffect = (effect: any, deps: any[]) => queueEffect(effect, deps, hooks.passive)
  /** @private @author ddj 2026年10月14号 @param effect 布局副作用 @param deps 依赖 */
  React.useLayoutEffect = (effect: any, deps: any[]) => queueEffect(effect, deps, hooks.layout)
  /** @private @author ddj 2026年10月14号 @param factory 计算方法 @returns 计算结果 */
  React.useMemo = (factory: any) => factory()
  return { ...real, default: React }
})
import { SearchPanel, noticeInScope, noticeTouchesContent } from '../src/client/sidebar/panels/SearchPanel.js'
import { CACHE_KEY } from '../src/client/paths.js'
import { clearSearchSeed, clearSearchScope, setSearchSeed, setSearchScope } from '../src/client/searchSeed.js'

let input: any
let field: any
const props = { ctx: { scope: 'focus-test', sessionId: 'test' } }

/** @private @author ddj 2026年10月14号 @param tree 元素树 @returns 查询输入元素 */
function findInput(tree: any): any {
  if (!tree || typeof tree !== 'object') return undefined
  if (tree.props?.className === 'edrv-search-input') return tree
  for (const child of [tree.props?.children].flat(Infinity)) {
    const found = findInput(child)
    if (found) return found
  }
}

/** @private @author ddj 2026年10月14号 @description 提交受控输入再执行 effects，直到状态稳定 */
function commit(): void {
  for (let count = 0; count < 10; count++) {
    hooks.dirty = false
    hooks.index = 0
    field = findInput(SearchPanel(props))
    input.value = field.props.value
    field.ref.current = input
    for (const effect of hooks.layout.splice(0)) effect()
    for (const effect of hooks.passive.splice(0)) effect()
    if (!hooks.dirty) return
  }
  throw new Error('SearchPanel commit did not settle')
}

/** @private @author ddj 2026年10月14号 @description 清理全部挂载 effects 与 refs */
function unmount(): void {
  for (const slot of hooks.slots) slot?.cleanup?.()
  if (field) field.ref.current = null
  hooks.slots.length = 0
}

/** @private @author ddj 2026年10月14号 @description 派发真实搜索聚焦事件并提交 */
function focusSearch(): void {
  window.dispatchEvent(new Event('edrv:search-focus'))
  commit()
}

/** @private @author ddj 2026年10月14号 @param text 预期输入值 @description 校验聚焦与完整选区 */
function expectSelection(text: string): void {
  expect(input.value).toBe(text)
  expect(input.focus).toHaveBeenCalled()
  expect([input.start, input.end]).toEqual([0, text.length])
}

beforeEach(() => {
  vi.useFakeTimers()
  hooks.slots.length = 0; hooks.layout.length = 0; hooks.passive.length = 0
  hooks.rpc.mockReset().mockResolvedValue({ ok: true, matches: [] })
  clearSearchSeed(); clearSearchScope()
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value) })
  vi.stubGlobal('window', new EventTarget())
  input = { value: '', start: -1, end: -1, focus: vi.fn(), blur: vi.fn() }
  /** @private @author ddj 2026年10月14号 @description 记录 select 调用时已提交值的范围 */
  input.select = vi.fn(() => { input.start = 0; input.end = input.value.length })
})
afterEach(() => { unmount(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('SearchPanel commit-time selection', () => {
  it('selects restored content on mount and repeated focus without searching', () => {
    localStorage.setItem(CACHE_KEY.search + props.ctx.scope, JSON.stringify({ query: 'remembered query' }))
    commit()
    expectSelection('remembered query')
    input.start = 3; input.end = 4
    focusSearch()
    expectSelection('remembered query')
    expect(hooks.rpc).not.toHaveBeenCalled()
    expect(input.select).toHaveBeenCalledTimes(2)
  })

  it('selects the new seed after commit, not the previous controlled value', () => {
    localStorage.setItem(CACHE_KEY.search + props.ctx.scope, JSON.stringify({ query: 'old', regex: true }))
    setSearchSeed('new selected text')
    commit()
    expectSelection('new selected text')
    expect(hooks.rpc).toHaveBeenCalledTimes(1)
    expect(hooks.rpc).toHaveBeenLastCalledWith('edrv.searchContent', expect.objectContaining({ query: 'new selected text', regex: true }))
    setSearchSeed('another seed')
    focusSearch()
    expectSelection('another seed')
    expect(hooks.rpc).toHaveBeenCalledTimes(2)
  })

  it('does not select on ordinary typing and cancels the pending search when seeded', () => {
    commit()
    field.props.onChange({ target: { value: 'typed text' } })
    commit()
    expect(input.select).toHaveBeenCalledTimes(1)
    setSearchSeed('replacement')
    focusSearch()
    expectSelection('replacement')
    vi.advanceTimersByTime(300)
    expect(hooks.rpc).toHaveBeenCalledTimes(1)
  })

  it('focuses empty content, selects folder-scoped content, and stops listening on unmount', () => {
    commit()
    expectSelection('')
    setSearchSeed('folder word')
    setSearchScope('Assets/Module')
    focusSearch()
    expectSelection('folder word')
    expect(hooks.rpc).toHaveBeenLastCalledWith('edrv.searchContent', expect.objectContaining({ include: ['Assets/Module/**'] }))
    unmount()
    window.dispatchEvent(new Event('edrv:search-focus'))
    expect(input.select).toHaveBeenCalledTimes(2)
    commit()
    expectSelection('folder word')
  })
})

describe('SearchPanel refresh on file change', () => {
  /** @private @author ddj 2026年10月14号 @param kind 变化类别（可省略） @description 派发本作用域的文件变化通知 */
  function notify(kind?: string): void {
    window.dispatchEvent(new CustomEvent('edrv:refresh', { detail: { scope: props.ctx.scope, paths: ['a.lua'], kind } }))
  }

  /** @private @author ddj 2026年10月14号 @description 输入搜索词并跑完输入防抖 */
  function search(text: string): void {
    field.props.onChange({ target: { value: text } })
    commit()
    vi.advanceTimersByTime(250)
    commit()
  }

  it('classifies notices by scope and change kind', () => {
    expect(noticeInScope({ scope: 'ws' }, 'ws')).toBe(true)
    expect(noticeInScope({ scope: 'other' }, 'ws')).toBe(false)
    expect(noticeInScope({}, 'ws')).toBe(true)
    expect(noticeTouchesContent({ kind: 'text' })).toBe(true)
    expect(noticeTouchesContent({ kind: 'structure' })).toBe(true)
    expect(noticeTouchesContent({})).toBe(true)
    expect(noticeTouchesContent({ kind: 'svn' })).toBe(false)
    expect(noticeTouchesContent({ kind: 'unknown' })).toBe(false)
  })

  it('re-runs the search with force after the target content changes', () => {
    commit()
    search('alpha')
    expect(hooks.rpc).toHaveBeenCalledTimes(1)
    expect(hooks.rpc).toHaveBeenLastCalledWith('edrv.searchContent', expect.objectContaining({ query: 'alpha' }))
    expect(hooks.rpc.mock.calls[0][1]).not.toHaveProperty('force')
    notify('text')
    vi.advanceTimersByTime(300)
    commit()
    expect(hooks.rpc).toHaveBeenCalledTimes(2)
    expect(hooks.rpc).toHaveBeenLastCalledWith('edrv.searchContent', expect.objectContaining({ query: 'alpha', force: true }))
  })

  it('merges the duplicate refresh/file-changed notices of one write', () => {
    commit()
    search('alpha')
    notify('text')
    window.dispatchEvent(new CustomEvent('edrv:file-changed', { detail: { scope: props.ctx.scope, path: 'a.lua', kind: 'text' } }))
    vi.advanceTimersByTime(300)
    commit()
    expect(hooks.rpc).toHaveBeenCalledTimes(2)
  })

  it('skips svn refreshes and foreign scopes but keeps untyped notices', () => {
    commit()
    search('alpha')
    notify('svn')
    window.dispatchEvent(new CustomEvent('edrv:refresh', { detail: { scope: 'other', kind: 'text' } }))
    vi.advanceTimersByTime(300)
    commit()
    expect(hooks.rpc).toHaveBeenCalledTimes(1)
    // 无 kind 的历史通知无法排除内容变化，按保守策略重搜一次。
    notify()
    vi.advanceTimersByTime(300)
    commit()
    expect(hooks.rpc).toHaveBeenCalledTimes(2)
    expect(hooks.rpc).toHaveBeenLastCalledWith('edrv.searchContent', expect.objectContaining({ query: 'alpha', force: true }))
  })

  it('does not search on a notice while the query is too short', () => {
    commit()
    field.props.onChange({ target: { value: 'a' } })
    commit()
    vi.advanceTimersByTime(250)
    commit()
    expect(hooks.rpc).not.toHaveBeenCalled()
    notify('text')
    vi.advanceTimersByTime(300)
    commit()
    expect(hooks.rpc).not.toHaveBeenCalled()
  })

  it('stops refreshing after unmount', () => {
    commit()
    search('alpha')
    unmount()
    expect(hooks.rpc).toHaveBeenCalledTimes(1)
    notify('text')
    vi.advanceTimersByTime(300)
    commit()
    expect(hooks.rpc).toHaveBeenCalledTimes(1)
  })
})
