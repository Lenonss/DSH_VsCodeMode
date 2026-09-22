/**
 * dsh-vscode-mode client — 暂停态 hover 变量树（成员全量直显 + 折叠展开 + 子级懒加载）。
 *
 * 形态：复用 Monaco 内置 hover 面板。调试内容由 hover.ts 渲染成**单个 HTML 块**
 * （`[data-edrv-dap]`），本模块负责：
 * - 树容器的 click/mousedown 委托（展开/折叠，子级懒加载）+ 重新渲染后的兜底绑定；
 * - hover 层：给行打 `debug`/`lsp` 归属标记、注入贴底常驻的 Alt 提示层、按 Alt 状态切换显隐
 *   （纯显示层切换：不动 provider、不触发重算，因此不依赖 Monaco 的重算路径）。
 * 约定（与 src/client/dap/variableTree.ts 一致）：循环 ref 不再展开、限制深度与总行数。
 *
 * ⚠️ 依赖内置 hover 容器 `.monaco-hover` 与 markdown 的 supportHtml（已在本仓 vendored
 * Monaco 构建中确认存在）；找不到容器时退化为静态行，不抛错、不影响其它功能。
 * 作者 ddj 2026年09月21号
 */
import { dapStore } from './store.js'
import { dapTrace } from './trace.js'
import type { DapVariableView } from '../../shared/dap.js'

// --region 常量
/** 最大展开深度（到达后不再给展开箭头）。 */
export const MAX_DEPTH = 8
/** 单棵树的行数上限（DOM 保护；超出给上限提示行）。 */
export const MAX_ROWS = 1000
/** 值截断长度（完整值写入 title）。 */
export const VALUE_CLIP = 120
/** 树容器标记（DOM 查找与重新绑定用）。 */
export const TREE_ATTR = 'data-edrv-tree'
/** 调试内容块标记（hover.ts 渲染的单块 HTML 根节点）。 */
export const BLOCK_ATTR = 'data-edrv-dap'
/** 贴底提示层标记。 */
export const HINT_ATTR = 'data-edrv-hint'
/** 承载提示层的 hover 容器标记（用于预留同高内边距，避免提示层遮住末行）。 */
export const HINT_HOST_ATTR = 'data-edrv-hint-host'
/** LSP 占位行标记（Alt 按住但真实 LSP 行尚未返回时顶位显示）。 */
export const PLACEHOLDER_ATTR = 'data-edrv-placeholder'
/** LSP 占位行文案。 */
export const LSP_PLACEHOLDER_TEXT = 'LSP 信息加载中…'
/** 行归属标记（`debug` = 调试块所在行，其余为 `lsp`）。 */
const ROW_ATTR = 'data-edrv-row'
/**
 * 属性钩子（折叠按钮/名称/等号/值/提示行/行本身）。
 * ⚠️ 必须用 data-*：实测本仓 vendored Monaco 的 markdown→DOM 管线会把我们 HTML 里的 `class`
 * 全部剥掉（`supportHtml` / `isTrusted` 都不豁免），只有 `data-*` 存活；因此 CSS 也一律用
 * 属性选择器，否则样式与交互钩子都会静默失效。
 */
export const LINE_ATTR = 'data-edrv-line'
export const TWIST_ATTR = 'data-edrv-twist'
export const NAME_ATTR = 'data-edrv-name'
export const EQ_ATTR = 'data-edrv-eq'
export const VAL_ATTR = 'data-edrv-val'
export const NOTE_ATTR = 'data-edrv-note'
export const HEAD_ATTR = 'data-edrv-head'
export const EXPR_ATTR = 'data-edrv-expr'
export const TYPE_ATTR = 'data-edrv-type'
/** 已绑定标记（同一 DOM 不重复挂监听）。 */
const WIRED_ATTR = 'data-edrv-wired'
/** 已展开标记（重新渲染后据此回放）。 */
const OPEN_ATTR = 'data-edrv-open'
/** 状态表上限（防止跨多次 hover 无限增长）。 */
const STATE_CAP = 50
/** mousedown 与 click 双通道去重窗口（ms）。 */
const CLICK_DEDUPE_MS = 600
// --endregion

/** 变量节点视图（与 DAP variables 返回结构一致）。 */
export type TreeNode = DapVariableView

/** 展平后的树行。 */
export interface TreeRow {
  /** 稳定路径（根 `r0`，子级 `r0.1`），也是缓存与展开状态的键。 */
  path: string
  /** 所属层级路径（根为 ''）。 */
  parentPath: string
  depth: number
  node: TreeNode
  /** 祖先 ref 链（不含自身）：循环 ref 防护。 */
  anc: number[]
  /** 可展开（ref>0、未超深度、非循环）。 */
  expandable: boolean
}

/** 一次 hover 的树状态（DOM 无关，可单测）。 */
export interface TreeState {
  key: string
  roots: readonly TreeNode[]
  /** path → 已取回的子项（懒加载缓存）。 */
  cache: Map<string, TreeNode[]>
  /** 已展开的 path。 */
  expanded: Set<string>
}

/** 状态注册表：hover key → 树状态。 */
const states = new Map<string, TreeState>()
/** DOM 观察器（hover 面板插入/重渲染时重新绑定）。 */
let observer: MutationObserver | null = null

// --region 纯逻辑（可单测）
/**
 * HTML 转义（调试值来自被调试进程，必须全量转义后再拼进 supportHtml 片段）。
 * @author ddj 2026年09月21号
 * @param text 原始文本
 * @returns 转义后的文本
 */
export function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 值截断（完整值另存 title，避免长字符串撑爆浮窗）。
 * @author ddj 2026年09月21号
 * @param text 原始值
 * @returns 截断后的值
 */
export function clipValue(text: string): string {
  const one = String(text ?? '')
  return one.length > VALUE_CLIP ? one.slice(0, VALUE_CLIP) + '…' : one
}

/**
 * 根级变量序列是否等价（名 + ref 相同）：等价即视为「同一 hover 的重渲染」。
 * @author ddj 2026年09月21号
 * @param a 上一次根级变量
 * @param b 本次根级变量
 * @returns 是否等价
 */
export function sameRoots(a: readonly TreeNode[], b: readonly TreeNode[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index].name !== b[index].name || a[index].ref !== b[index].ref) return false
  }
  return true
}

/**
 * 建立并登记一次 hover 的树状态。
 * 同一 key 且根级等价时**复用**旧状态：Monaco 会在鼠标微动时重跑 provider，若每次新建，
 * 展开状态与子项缓存会被清空 → 表现为「点开又自动收起」（折叠看似失效）。
 * @author ddj 2026年09月21号
 * @param key hover 身份键（表达式 + 模型路径 + 范围）
 * @param roots 根级变量
 * @returns 树状态
 */
export function createTreeState(key: string, roots: readonly TreeNode[]): TreeState {
  const prev = states.get(key)
  if (prev && sameRoots(prev.roots, roots)) return prev
  const state: TreeState = { key, roots, cache: new Map(), expanded: new Set() }
  states.delete(key)
  states.set(key, state)
  while (states.size > STATE_CAP) {
    const oldest = states.keys().next().value as string | undefined
    if (oldest === undefined) break
    states.delete(oldest)
  }
  return state
}

/**
 * 行可见性计划：未按 Alt → 只看调试块；按住 Alt → 只看 LSP 行。
 * @author ddj 2026年09月21号
 * @param held Alt 是否按住
 * @returns 两类行的可见性
 */
export function rowPlan(held: boolean): { debug: boolean; lsp: boolean } {
  return held ? { debug: false, lsp: true } : { debug: true, lsp: false }
}

/**
 * 贴底提示文案（随 Alt 状态提示当前/下一步动作）。
 * @author ddj 2026年09月21号
 * @param held Alt 是否按住
 * @returns 单行文案
 */
export function hintText(held: boolean): string {
  return held ? '松开 Alt 返回调试值' : '按住 Alt 查看 LSP 信息'
}

/**
 * 是否需要 LSP 占位行：Alt 按住、且还没有真实 LSP 行。
 * LuaLS 首次 hover 可能数百毫秒，没有占位行时面板会空白，看起来像「没切过去」。
 * @author ddj 2026年09月21号
 * @param held Alt 是否按住
 * @param hasRealLsp 是否已有真实 LSP 行
 * @returns 是否需要占位行
 */
export function needsLspPlaceholder(held: boolean, hasRealLsp: boolean): boolean {
  return held && !hasRealLsp
}

/**
 * 查询已登记的树状态。
 * @author ddj 2026年09月21号
 * @param key hover 身份键
 * @returns 树状态（未登记为 null）
 */
export function stateOf(key: string): TreeState | null {
  return states.get(key) ?? null
}

/**
 * 子路径生成（父 + 序号；根级为 `r<n>`）。
 * @author ddj 2026年09月21号
 * @param parent 父路径（根为 ''）
 * @param index 序号
 * @returns 稳定路径
 */
function pathOf(parent: string, index: number): string {
  return parent ? parent + '.' + index : 'r' + index
}

/**
 * 取某父节点的子项列表（根级取 roots，其余取缓存）。
 * @author ddj 2026年09月21号
 * @param state 树状态
 * @param parent 父路径（根为 ''）
 * @returns 子项列表
 */
function itemsOf(state: TreeState, parent: string): readonly TreeNode[] {
  if (!parent) return state.roots
  return state.cache.get(parent) ?? []
}

/**
 * 构造单行（含循环 ref 判定）。
 * @author ddj 2026年09月21号
 * @param state 树状态
 * @param parent 父路径（根为 ''）
 * @param depth 行深度
 * @param anc 祖先 ref 链（不含本层节点）
 * @param index 子项下标
 * @returns 树行
 */
export function rowAt(state: TreeState, parent: string, depth: number, anc: readonly number[], index: number): TreeRow {
  const node = itemsOf(state, parent)[index]
  const expandable = node.ref > 0 && depth < MAX_DEPTH && !anc.includes(node.ref)
  return { path: pathOf(parent, index), parentPath: parent, depth, node, anc: [...anc], expandable }
}

/**
 * 展平某父节点下的一层行（成员全量直显，仅受 budget 上限约束）。
 * @author ddj 2026年09月21号
 * @param state 树状态
 * @param parent 父路径（根为 ''）
 * @param depth 行深度
 * @param anc 祖先 ref 链（不含本层节点）
 * @param budget 本层最多渲染的行数（缺省 MAX_ROWS）
 * @returns 行列表
 */
export function rowsOf(state: TreeState, parent: string, depth: number, anc: readonly number[], budget: number = MAX_ROWS): TreeRow[] {
  const items = itemsOf(state, parent)
  const size = Math.min(items.length, Math.max(0, budget))
  const rows: TreeRow[] = []
  for (let index = 0; index < size; index += 1) rows.push(rowAt(state, parent, depth, anc, index))
  return rows
}

/**
 * 行数上限提示行（仅在极端大表触顶时出现）。
 * @author ddj 2026年09月21号
 * @param depth 所属深度（与子项同层，便于随父级折叠一并移除）
 * @returns 提示行 HTML
 */
function limitNoteHtml(depth: number): string {
  return '<li ' + LINE_ATTR + '="1" data-edrv-depth="' + String(depth) + '" ' + NOTE_ATTR + '="limit">已达行数上限（' + String(MAX_ROWS) + '），请在监视面板查看</li>'
}

/**
 * 「无子项」提示行（点了展开却没有任何子项时给出明确反馈）。
 * @author ddj 2026年09月21号
 * @param depth 所属深度（与子项同层，便于随父级折叠一并移除）
 * @returns 提示行 HTML
 */
function emptyNoteHtml(depth: number): string {
  return '<li ' + LINE_ATTR + '="1" data-edrv-depth="' + String(depth) + '" ' + NOTE_ATTR + '="empty">（无子项）</li>'
}

/**
 * 展开箭头文案（可展开行按开合给 ▸/▾，不可展开留空）。
 * @author ddj 2026年09月21号
 * @param row 树行
 * @param open 是否已展开
 * @returns 箭头文案
 */
function twistOf(row: TreeRow, open: boolean): string {
  if (!row.expandable) return ''
  return open ? '▾' : '▸'
}

/**
 * 单行 → HTML（名称/值全部转义；箭头仅可展开行给出）。
 * @author ddj 2026年09月21号
 * @param row 树行
 * @param open 该行当前是否已展开
 * @returns 行 HTML
 */
export function rowHtml(row: TreeRow, open: boolean): string {
  const attrs = [
    LINE_ATTR + '="1"',
    'data-edrv-path="' + escapeHtml(row.path) + '"',
    'data-edrv-parent="' + escapeHtml(row.parentPath) + '"',
    'data-edrv-depth="' + String(row.depth) + '"',
    'data-edrv-anc="' + escapeHtml(row.anc.join(',')) + '"',
    'data-edrv-ref="' + String(row.node.ref) + '"',
    'style="padding-left:' + String(row.depth * 12) + 'px"',
  ]
  const full = String(row.node.value ?? '')
  return '<li ' + attrs.join(' ') + '>'
    + '<span ' + TWIST_ATTR + '="1">' + twistOf(row, open) + '</span>'
    + '<span ' + NAME_ATTR + '="1">' + escapeHtml(row.node.name) + '</span>'
    + '<span ' + EQ_ATTR + '="1">=</span>'
    + '<span ' + VAL_ATTR + '="1" title="' + escapeHtml(full) + '">' + escapeHtml(clipValue(full)) + '</span>'
    + '</li>'
}

/**
 * 行列表 → HTML。
 * @author ddj 2026年09月21号
 * @param rows 行列表
 * @param open 已展开路径集合
 * @returns 拼接后的 HTML
 */
export function rowsHtml(rows: readonly TreeRow[], open: ReadonlySet<string>): string {
  return rows.map((row) => rowHtml(row, open.has(row.path))).join('')
}

/**
 * 生成树初始 HTML（根级成员全量直显；无可渲染行时返回空串）。
 * @author ddj 2026年09月21号
 * @param state 树状态
 * @returns 树容器 HTML
 */
export function initialHtml(state: TreeState): string {
  const rows = rowsOf(state, '', 0, [], MAX_ROWS)
  if (!rows.length) return ''
  // 不加自定义 class：markdown 渲染会剥掉 class（见常量区注释），钩子/样式一律用 data-*
  const note = state.roots.length > rows.length ? limitNoteHtml(0) : ''
  return '<ul ' + TREE_ATTR + '="1" data-edrv-key="' + escapeHtml(state.key) + '">'
    + rowsHtml(rows, state.expanded)
    + note
    + '</ul>'
}
// --endregion

// --region DOM 绑定与懒加载
/**
 * 设置展开箭头方向。
 * @author ddj 2026年09月21号
 * @param row 行元素
 * @param open 是否展开
 */
function setTwist(row: HTMLElement, open: boolean): void {
  const twist = row.querySelector('[' + TWIST_ATTR + ']')
  if (!twist) return
  twist.textContent = open ? '▾' : '▸'
}

/**
 * 行内祖先 ref 链（DOM 属性 → 数组）。
 * @author ddj 2026年09月21号
 * @param row 行元素
 * @returns ref 数组
 */
function ancOf(row: HTMLElement): number[] {
  const raw = row.getAttribute('data-edrv-anc') ?? ''
  return raw ? raw.split(',').map((item) => Number(item)).filter((item) => Number.isFinite(item)) : []
}

/**
 * 渲染某行已缓存的子项（成员全量直显；不发起请求，命中与否由调用方判断）。
 * @author ddj 2026年09月21号
 * @param state 树状态
 * @param row 行元素
 * @param host 树容器
 * @returns 实际插入的行数
 */
function renderChildren(state: TreeState, row: HTMLElement, host: HTMLElement): number {
  const path = row.getAttribute('data-edrv-path') ?? ''
  const depth = Number(row.getAttribute('data-edrv-depth') ?? '0') + 1
  const anc = [...ancOf(row), Number(row.getAttribute('data-edrv-ref') ?? '0')]
  const budget = Math.max(0, MAX_ROWS - host.querySelectorAll('[' + LINE_ATTR + ']').length)
  if (!budget) return 0
  const rows = rowsOf(state, path, depth, anc, budget)
  const note = itemsOf(state, path).length > rows.length ? limitNoteHtml(depth) : ''
  row.insertAdjacentHTML('afterend', rowsHtml(rows, state.expanded) + note)
  return rows.length
}

/**
 * 折叠某行（移除其后深度更大的行）。
 * @author ddj 2026年09月21号
 * @param state 树状态
 * @param row 行元素
 */
function collapseRow(state: TreeState, row: HTMLElement): void {
  const depth = Number(row.getAttribute('data-edrv-depth') ?? '0')
  let node = row.nextElementSibling
  while (node && Number(node.getAttribute('data-edrv-depth') ?? '-1') > depth) {
    const next = node.nextElementSibling
    node.remove()
    node = next
  }
  state.expanded.delete(row.getAttribute('data-edrv-path') ?? '')
  row.removeAttribute(OPEN_ATTR)
  setTwist(row, false)
}

/**
 * 展开某行（子项懒加载：未缓存才请求 variables；空子项给出明确反馈）。
 * @author ddj 2026年09月21号
 * @param state 树状态
 * @param row 行元素
 * @param host 树容器
 */
async function expandRow(state: TreeState, row: HTMLElement, host: HTMLElement): Promise<void> {
  const path = row.getAttribute('data-edrv-path') ?? ''
  if (state.expanded.has(path)) {
    collapseRow(state, row)
    return
  }
  if (!state.cache.has(path)) {
    const ref = Number(row.getAttribute('data-edrv-ref') ?? '0')
    const children = await dapStore.variables(ref)
    state.cache.set(path, children)
    if (!children.length) dapTrace('hover-expand-empty', { path, ref })
  }
  state.expanded.add(path)
  row.setAttribute(OPEN_ATTR, '1')
  renderChildren(state, row, host)
  // 子项为空：给出明确反馈，避免看起来「点了没反应」
  if (!itemsOf(state, path).length) row.insertAdjacentHTML('afterend', emptyNoteHtml(Number(row.getAttribute('data-edrv-depth') ?? '0') + 1))
  setTwist(row, true)
}

/** 双通道去重时间戳（mousedown 已切换时，紧随的 click 不再重复切换）。 */
let lastToggleAt = 0

/**
 * 命中折叠按钮的行（未命中返回 null）。
 * @author ddj 2026年09月21号
 * @param target 事件目标
 * @returns 行元素（非折叠区/不可展开为 null）
 */
function twistRowOf(target: EventTarget | null): HTMLElement | null {
  const el = target as HTMLElement | null
  const row = el?.closest?.('[' + LINE_ATTR + ']') as HTMLElement | null
  if (!row) return null
  if (!row.querySelector('[' + TWIST_ATTR + ']')?.textContent) return null
  return row
}

/**
 * 切换某行展开/折叠（含容器与状态查找）。
 * @author ddj 2026年09月21号
 * @param row 行元素
 * @returns 是否已派发
 */
function toggleRow(row: HTMLElement): boolean {
  const host = row.closest('[' + TREE_ATTR + ']') as HTMLElement | null
  if (!host) return false
  const state = stateOf(host.getAttribute('data-edrv-key') ?? '')
  if (!state) return false
  lastToggleAt = Date.now()
  void expandRow(state, row, host)
  return true
}

/**
 * 折叠按钮 mousedown（capture 主通道）：早于文本选择/焦点变化响应，并阻止默认行为。
 * @author ddj 2026年09月21号
 * @param ev 指针事件
 */
function onTreeDown(ev: Event): void {
  const row = twistRowOf(ev.target)
  if (!row) return
  ev.preventDefault()
  ev.stopPropagation()
  toggleRow(row)
}

/**
 * 折叠按钮 click（capture 兜底通道）：mousedown 被宿主吞掉时仍可切换；与主通道去重。
 * @author ddj 2026年09月21号
 * @param ev 点击事件
 */
function onTreeClick(ev: Event): void {
  if (Date.now() - lastToggleAt < CLICK_DEDUPE_MS) return
  const row = twistRowOf(ev.target)
  if (!row) return
  ev.preventDefault()
  ev.stopPropagation()
  toggleRow(row)
}

/**
 * 绑定一个树容器（幂等）：双通道委托 + 回放已展开层级。
 * @author ddj 2026年09月21号
 * @param tree 树容器元素
 */
function wireTree(tree: HTMLElement): void {
  if (tree.getAttribute(WIRED_ATTR) === '1') return
  tree.setAttribute(WIRED_ATTR, '1')
  tree.addEventListener('mousedown', onTreeDown, true)
  tree.addEventListener('click', onTreeClick, true)
  const state = stateOf(tree.getAttribute('data-edrv-key') ?? '')
  if (state) replayExpansions(state, tree)
}

/**
 * 重新渲染后回放已展开层级（只用缓存，不再请求）。
 * @author ddj 2026年09月21号
 * @param state 树状态
 * @param tree 树容器元素
 */
function replayExpansions(state: TreeState, tree: HTMLElement): void {
  for (let round = 0; round < MAX_DEPTH; round += 1) {
    const opened = (row: HTMLElement): boolean => !row.hasAttribute(OPEN_ATTR) && state.cache.has(row.getAttribute('data-edrv-path') ?? '')
    const pending = Array.from(tree.querySelectorAll<HTMLElement>('[' + LINE_ATTR + ']'))
      .filter((row) => state.expanded.has(row.getAttribute('data-edrv-path') ?? '') && opened(row))
    if (!pending.length) return
    for (const row of pending) {
      row.setAttribute(OPEN_ATTR, '1')
      renderChildren(state, row, tree)
      setTwist(row, true)
    }
  }
}

// --region hover 层（提示贴底常驻 + Alt 行级显隐）
/** 当前 Alt 状态镜像（由 hoverMode 经 applyAltToHovers 注入，避免模块循环依赖）。 */
let altHeld = false

/**
 * 同步 LSP 占位行（幂等）：Alt 按住且还没有真实 LSP 行时补一行「LSP 信息加载中…」，
 * 真实 LSP 行到达（或松开 Alt）即移除；避免按下 Alt 后面板空白被当成「没切换」。
 * @author ddj 2026年09月21号
 * @param hover hover 容器
 * @param held Alt 是否按住
 */
function syncPlaceholder(hover: HTMLElement, held: boolean): void {
  const existing = hover.querySelector('[' + PLACEHOLDER_ATTR + ']')
  const rows = Array.from(hover.querySelectorAll('.hover-row[' + ROW_ATTR + ']'))
  const hasRealLsp = rows.some((row) => row.getAttribute(ROW_ATTR) === 'lsp' && !row.hasAttribute(PLACEHOLDER_ATTR))
  if (!needsLspPlaceholder(held, hasRealLsp)) {
    if (existing) existing.remove()
    return
  }
  if (existing) return
  const content = hover.querySelector('.monaco-hover-content')
  if (!content) return
  const node = document.createElement('div')
  node.className = 'hover-row'
  node.setAttribute(PLACEHOLDER_ATTR, '1')
  node.setAttribute(ROW_ATTR, 'lsp')
  // 内联样式：占位行不在本文件既有 CSS 钩子清单里，避免为此扩散样式改动
  node.style.cssText = 'padding:2px 8px;font-style:italic;color:var(--dsw-alias-label-tertiary,#8a949b)'
  node.textContent = LSP_PLACEHOLDER_TEXT
  content.appendChild(node)
}

/**
 * 按 Alt 状态切换单次 hover 的行可见性、占位行与提示文案（纯显示层，不动 provider）。
 * @author ddj 2026年09月21号
 * @param hover hover 容器
 * @param held Alt 是否按住
 */
function applyRows(hover: HTMLElement, held: boolean): void {
  syncPlaceholder(hover, held)
  const plan = rowPlan(held)
  for (const row of Array.from(hover.querySelectorAll<HTMLElement>('.hover-row[' + ROW_ATTR + ']'))) {
    const visible = row.getAttribute(ROW_ATTR) === 'debug' ? plan.debug : plan.lsp
    row.style.display = visible ? '' : 'none'
  }
  const hint = hover.querySelector<HTMLElement>('[' + HINT_ATTR + ']')
  if (hint) hint.textContent = hintText(held)
}

/**
 * 同步 hover 层（幂等）：打行归属标记、注入贴底提示层、应用当前 Alt 状态。
 * 没有调试块时清除标记与提示层，避免污染普通（LSP）hover。
 * @author ddj 2026年09月21号
 * @param hover hover 容器
 */
function syncHoverLayer(hover: HTMLElement): void {
  const block = hover.querySelector('[' + BLOCK_ATTR + ']')
  const hint = hover.querySelector<HTMLElement>('[' + HINT_ATTR + ']')
  if (!block) {
    if (hint) hint.remove()
    hover.removeAttribute(HINT_HOST_ATTR)
    for (const row of Array.from(hover.querySelectorAll('[' + ROW_ATTR + ']'))) row.removeAttribute(ROW_ATTR)
    return
  }
  for (const row of Array.from(hover.querySelectorAll('.hover-row'))) {
    row.setAttribute(ROW_ATTR, row.querySelector('[' + BLOCK_ATTR + ']') ? 'debug' : 'lsp')
  }
  if (!hint) {
    const node = document.createElement('div')
    node.setAttribute(HINT_ATTR, '1')
    node.className = 'edrv-dap-hint'
    hover.appendChild(node)
  }
  // 容器标记：CSS 依此预留 22px 底部内边距，避免贴底提示层遮住最后一行
  hover.setAttribute(HINT_HOST_ATTR, '1')
  applyRows(hover, altHeld)
}

/**
 * 当前是否有可见的调试 hover（供 hoverMode 判定「是否消费裸 Alt」）。
 * @author ddj 2026年09月21号
 * @returns 是否有可见的调试浮层
 */
export function hasDebugHover(): boolean {
  if (typeof document === 'undefined') return false
  for (const hover of Array.from(document.querySelectorAll<HTMLElement>('.monaco-hover'))) {
    if (!hover.classList.contains('hidden') && hover.querySelector('[' + BLOCK_ATTR + ']')) return true
  }
  return false
}

/**
 * 应用 Alt 状态到所有 hover（幂等；供 hoverMode 在 Alt 变化时调用）。
 * @author ddj 2026年09月21号
 * @param held Alt 是否按住
 */
export function applyAltToHovers(held: boolean): void {
  altHeld = held
  if (typeof document === 'undefined') return
  for (const hover of Array.from(document.querySelectorAll<HTMLElement>('.monaco-hover'))) applyRows(hover, held)
}

/**
 * 批次末兜底扫描：绑定所有未绑定的树容器 + 同步所有 hover 层。
 * 覆盖 markdown 异步渲染的各种插入形态（先插容器后填子节点等），也保证 hover
 * 重渲染后重新打标记并回放展开层级。
 * @author ddj 2026年09月21号
 */
function sweepWires(): void {
  for (const tree of Array.from(document.querySelectorAll<HTMLElement>('[' + TREE_ATTR + ']:not([' + WIRED_ATTR + '])'))) wireTree(tree)
  for (const hover of Array.from(document.querySelectorAll<HTMLElement>('.monaco-hover'))) syncHoverLayer(hover)
}

/** 兜底扫描合并计时器（一帧内多次 DOM 变更只扫一次）。 */
let sweepTimer: number | null = null

/**
 * 合并调度一次兜底扫描（避免与宿主高频渲染互相放大）。
 * @author ddj 2026年09月21号
 */
function scheduleSweep(): void {
  if (typeof window === 'undefined' || sweepTimer !== null) return
  sweepTimer = window.setTimeout(() => {
    sweepTimer = null
    sweepWires()
  }, 0)
}

/**
 * 收集本次变更影响的 hover 容器（新增节点自身 / 祖先 / 后代）。
 * @author ddj 2026年09月21号
 * @param records 变更记录
 * @returns hover 容器集合
 */
function hoversOf(records: MutationRecord[]): Set<HTMLElement> {
  const found = new Set<HTMLElement>()
  for (const record of records) {
    for (const node of Array.from(record.addedNodes)) {
      if (node.nodeType !== 1) continue
      const el = node as Element
      const owner = (el.matches?.('.monaco-hover') ? el : el.closest?.('.monaco-hover')) as HTMLElement | null
      if (owner) {
        found.add(owner)
        continue
      }
      for (const hover of Array.from(el.querySelectorAll?.('.monaco-hover') ?? [])) found.add(hover as HTMLElement)
    }
  }
  return found
}

/**
 * 清理已注入的 hover 层（卸载时避免残留提示层与隐藏态）。
 * @author ddj 2026年09月21号
 */
function clearHoverLayer(): void {
  if (typeof document === 'undefined') return
  for (const hint of Array.from(document.querySelectorAll<HTMLElement>('[' + HINT_ATTR + ']'))) hint.remove()
  for (const ph of Array.from(document.querySelectorAll<HTMLElement>('[' + PLACEHOLDER_ATTR + ']'))) ph.remove()
  for (const host of Array.from(document.querySelectorAll<HTMLElement>('[' + HINT_HOST_ATTR + ']'))) host.removeAttribute(HINT_HOST_ATTR)
  for (const row of Array.from(document.querySelectorAll<HTMLElement>('.hover-row[' + ROW_ATTR + ']'))) {
    row.style.display = ''
    row.removeAttribute(ROW_ATTR)
  }
}

/**
 * 安装 hover 树绑定（幂等）：观察 hover 面板插入与内容重渲染，批次末兜底扫描。
 * @author ddj 2026年09月21号
 */
export function installHoverTree(): void {
  if (typeof window === 'undefined' || observer) return
  observer = new MutationObserver((records) => {
    const hovers = hoversOf(records)
    // 同步应用：新行一落地就处于正确的 Alt 可见性，不会在按住 Alt 时闪回调试块
    for (const hover of hovers) syncHoverLayer(hover)
    if (hovers.size) scheduleSweep()
  })
  observer.observe(document.body, { childList: true, subtree: true })
}

/** 卸载 hover 树绑定并清空状态（插件重载/卸载）。 */
export function disposeHoverTree(): void {
  observer?.disconnect()
  observer = null
  if (typeof window !== 'undefined' && sweepTimer !== null) window.clearTimeout(sweepTimer)
  sweepTimer = null
  states.clear()
  clearHoverLayer()
}
// --endregion
