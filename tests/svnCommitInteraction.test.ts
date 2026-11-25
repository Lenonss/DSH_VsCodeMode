// @ts-nocheck
/**
 * 提交窗口交互测试（双击看差异 / Shift 整段翻面 / Space 批量勾选 / 方向键移动）。
 *
 * 守护的是「选择」与「勾选」的边界：选中只服务批量动作，勾选才是提交范围；
 * 两类手势一旦混进同一处，最容易表现为「点一下就把不该提交的文件带进去」。
 * @author ddj 2026年11月24号
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ slots: [] as any[], effects: [] as any[], cursor: 0, ec: 0, queue: [] as any[], plan: vi.fn() }))

vi.mock('../src/client/svnCommit.js', () => ({ svnCommitPlan: h.plan, svnCommitNow: vi.fn() }))
vi.mock('../src/client/aiCommit.js', () => ({
  AI_COMMIT_STYLE_LABEL: { plain: '中文模板' },
  AI_COMMIT_IDLE: { phase: 'idle', note: '就绪', model: '' },
  runAiCommit: vi.fn(),
}))
vi.mock('../src/client/svnActions.js', () => ({ runSvnAction: vi.fn() }))
vi.mock('../src/client/copyText.js', () => ({ copyText: vi.fn() }))
vi.mock('../src/client/svnStatus.js', () => ({ svnPathKinds: async () => ({}) }))
vi.mock('../src/client/ui/FloatingWindow.js', () => ({ FloatingWindow: 'floating-window' }))
vi.mock('../src/client/ui/ContextMenu.js', () => ({ ContextMenu: 'context-menu' }))
// 图标原语来自 peer 包：开发环境未装它的传递依赖（anser），与本仓库其它 UI 测试同样改为 mock。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: 'button' }))
vi.mock('../src/client/ui/icons.js', () => ({ entryIconEl: () => null }))
vi.mock('react', async (original) => {
  const real = await original<any>()
  return {
    ...real,
    default: {
      ...real.default,
      useState: (initial: any) => {
        const index = h.cursor++
        if (!(index in h.slots)) h.slots[index] = typeof initial === 'function' ? initial() : initial
        return [h.slots[index], (value: any) => { h.slots[index] = typeof value === 'function' ? value(h.slots[index]) : value }] as any
      },
      useRef: (initial: any) => {
        const index = h.cursor++
        if (!(index in h.slots)) h.slots[index] = { current: initial }
        return h.slots[index]
      },
      useMemo: (factory: any, deps: any[]) => memo(factory, deps),
      useCallback: (fn: any, deps: any[]) => memo(() => fn, deps),
      useEffect: effect,
      useLayoutEffect: effect,
    },
  }
})

import { SvnCommitDialog } from '../src/client/ui/SvnCommitDialog.js'

const entries = [
  { path: 'a.txt', status: 'modified', versioned: true },
  { path: 'b.txt', status: 'modified', versioned: true },
  { path: 'c.txt', status: 'added', versioned: true },
  { path: 'n.txt', status: 'unversioned', versioned: false },
]

const props = {
  sessionId: 's', seed: null,
  onClose: vi.fn(), onCommitted: vi.fn(), onChanged: vi.fn(), notify: vi.fn(),
  onCompare: vi.fn(), onShowLog: vi.fn(), onOpenFile: vi.fn(), onOpenParent: vi.fn(),
}

/** @private @author ddj 2026年11月24号 @param factory 取值器 @param deps 依赖 @returns 缓存的同一引用 */
function memo(factory: any, deps: any[]) {
  const index = h.cursor++
  const prev = h.slots[index]
  if (!prev || deps.some((value, j) => !Object.is(value, prev.deps[j]))) h.slots[index] = { deps, value: factory() }
  return h.slots[index].value
}

/** @private @author ddj 2026年11月24号 @param fn 副作用主体 @param deps 依赖 @returns void */
function effect(fn: any, deps: any[] = []) {
  const index = h.ec++
  const prev = h.effects[index]
  if (prev && deps.every((value, j) => Object.is(value, prev.deps[j]))) return
  h.queue.push(() => { prev?.cleanup?.(); h.effects[index] = { deps, cleanup: fn() } })
}

/** @private @author ddj 2026年11月24号 @param node React 树 @returns 拍平后的节点（穿过浮窗与列表） */
function flatten(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(flatten)
  if (!node || typeof node !== 'object') return []
  return [node, ...flatten(node.props?.children)]
}

/** @private @author ddj 2026年11月24号 @returns 已提交副作用的渲染结果 */
function render() {
  h.cursor = 0
  h.ec = 0
  const nodes = flatten(SvnCommitDialog(props))
  for (const commit of h.queue.splice(0)) commit()
  return nodes
}

/** @private @author ddj 2026年11月24号 @returns 等微任务落定后的稳定渲染 */
async function settle() {
  for (let i = 0; i < 15; i++) { await Promise.resolve(); render() }
  return render()
}

/** @private @author ddj 2026年11月24号 @param nodes 渲染结果 @returns 文件行（不含分组头） */
function rows(nodes: any[]) {
  return nodes.filter((node) => node.props.role === 'row' && node.props.onClick)
}

/** @private @author ddj 2026年11月24号 @param nodes 渲染结果 @returns 行勾选框，按显示顺序 */
function checks(nodes: any[]) {
  return nodes.filter((node) => node.type === 'input' && String(node.props.title).endsWith('.txt'))
}

/** @private @author ddj 2026年11月24号 @param target 事件目标 @returns 事件对象 */
function evt(target: any = { closest: () => null }, extra: any = {}) {
  return {
    shiftKey: false, ctrlKey: false, metaKey: false,
    preventDefault: vi.fn(), stopPropagation: vi.fn(), target, ...extra,
  }
}

beforeEach(() => {
  h.slots = []; h.effects = []; h.queue = []; h.plan.mockReset(); vi.clearAllMocks()
  h.plan.mockImplementation(async () => ({ ok: true, plan: { entries, changelists: [], recent: [] }, message: '已读取提交清单' }))
  vi.stubGlobal('window', { confirm: vi.fn(() => true), innerWidth: 1000 })
})

afterEach(() => { for (const entry of h.effects) entry?.cleanup?.(); vi.unstubAllGlobals() })

describe('提交窗口双击看差异', () => {
  it('双击文件行调用 onCompare，双击勾选框列不触发', async () => {
    const nodes = await settle()
    rows(nodes)[2].props.onDoubleClick(evt())
    expect(props.onCompare).toHaveBeenCalledWith('c.txt')

    props.onCompare.mockClear()
    const onBox = { closest: (selector: string) => (selector === '.edrv-svncommit-pick' ? {} : null) }
    rows(nodes)[0].props.onDoubleClick(evt(onBox))
    expect(props.onCompare).not.toHaveBeenCalled()
  })

  it('右键菜单的「与基线比较」也走同一个回调', async () => {
    const nodes = await settle()
    rows(nodes)[2].props.onContextMenu(evt())
    const menu = render().find((node) => node.type === 'context-menu')
    expect(menu).toBeTruthy()

    const compare = menu.props.entries.find((item: any) => item.id === 'compare')
    expect(compare.disabled).toBeUndefined()
    compare.onClick()
    expect(props.onCompare).toHaveBeenCalledWith('c.txt')
  })

  it('未版本控制的行双击只提示原因', async () => {
    const nodes = await settle()
    rows(nodes)[3].props.onDoubleClick(evt())
    expect(props.onCompare).not.toHaveBeenCalled()
    expect(props.notify).toHaveBeenCalledWith('二进制文件或未纳入版本控制，没有文本基线')
  })
})

describe('提交窗口多选与批量勾选', () => {
  it('Shift 点击把锚点到该行的勾选整段翻面，并掐掉原生复选框切换', async () => {
    let nodes = await settle()
    rows(nodes)[0].props.onClick(evt())
    nodes = render()
    expect(checks(nodes).slice(0, 3).map((node) => node.props.checked)).toEqual([true, true, true])

    const shift = evt(undefined, { shiftKey: true })
    rows(nodes)[2].props.onClick(shift)
    nodes = render()
    expect(shift.preventDefault).toHaveBeenCalled()
    expect(checks(nodes).slice(0, 3).map((node) => node.props.checked)).toEqual([false, false, false])
    expect(checks(nodes)[3].props.checked).toBe(false)
  })

  it('Ctrl 点击只改选中，Space 才批量改勾选', async () => {
    let nodes = await settle()
    rows(nodes)[0].props.onClick(evt(undefined, { ctrlKey: true }))
    nodes = render()
    rows(nodes)[1].props.onClick(evt(undefined, { ctrlKey: true }))
    nodes = render()
    expect(rows(nodes).slice(0, 2).every((row) => row.props['aria-selected'])).toBe(true)
    expect(checks(nodes).slice(0, 2).every((node) => node.props.checked)).toBe(true)

    rows(nodes)[0].props.onKeyDown(evt(undefined, { key: ' ' }))
    nodes = render()
    expect(checks(nodes).slice(0, 2).map((node) => node.props.checked)).toEqual([false, false])
    expect(checks(nodes)[2].props.checked).toBe(true)
  })

  it('空格与方向键之外，方向键移动选中、Ctrl+A 全选', async () => {
    let nodes = await settle()
    // 没有选中时向下一格落在首行
    rows(nodes)[0].props.onKeyDown(evt(undefined, { key: 'ArrowDown' }))
    nodes = render()
    expect(rows(nodes)[0].props['aria-selected']).toBe(true)

    rows(nodes)[0].props.onKeyDown(evt(undefined, { key: 'ArrowDown' }))
    nodes = render()
    expect(rows(nodes)[1].props['aria-selected']).toBe(true)
    expect(rows(nodes)[0].props['aria-selected']).toBe(false)

    rows(nodes)[1].props.onKeyDown(evt(undefined, { key: 'a', ctrlKey: true }))
    nodes = render()
    expect(rows(nodes).every((row) => row.props['aria-selected'])).toBe(true)
  })

  it('选中两行以上时工具带出现批量勾选按钮', async () => {
    let nodes = await settle()
    expect(nodes.some((node) => node.props.className === 'edrv-svncommit-sels')).toBe(false)

    rows(nodes)[0].props.onClick(evt(undefined, { ctrlKey: true }))
    nodes = render()
    rows(nodes)[1].props.onClick(evt(undefined, { ctrlKey: true }))
    nodes = render()
    expect(nodes.some((node) => node.props.className === 'edrv-svncommit-sels')).toBe(true)
  })
})
