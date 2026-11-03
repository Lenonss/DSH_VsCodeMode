/**
 * dsh-vscode-mode client — 「下载到本机」弹窗的目录树与勾选模型（纯逻辑）。
 *
 * 与 React 解耦：组件只读 rowList 渲染、只调这里的函数改状态，因此本文件可在
 * node 环境单测（vitest 无可视 DOM）。状态全部不可变返回，便于 React 直接替换。
 *
 * 设计决策（产品已确认「目录树 + 勾选、不打包」）：
 * - 目录节点只负责展开，不带勾选框；勾选粒度是文件（避免「半选目录」的语义歧义）。
 * - 懒加载：一次只 listDir 一层；「全选」只作用于已加载文件，不对未展开目录做
 *   隐式整树拉取（否则 node_modules 级目录会把弹窗一次性拉爆）。
 * 作者 ddj 2026年11月03号
 */
import type { TreeEntry } from '../shared/rpc.js'

/** 单文件下载上限，与主机二进制读取上限（BINARY_READ_CAP）保持一致。 */
export const DL_SIZE_CAP = 32 * 1024 * 1024

/** 树节点：只保留文件与目录（主机的 'other' 不进弹窗）。 */
export interface DlNode {
  name: string
  path: string
  kind: 'file' | 'directory'
  /** 主机的可选大小；缺失时界面不显示体积，也不做上限预判。 */
  size?: number
}

/** 弹窗状态：目录树 + 展开态 + 加载态 + 勾选集合。 */
export interface DlState {
  /** 弹窗根（工作区相对路径；'' = 工作区根目录）。 */
  root: string
  nodes: Map<string, DlNode>
  /** 目录路径 → 已加载子项（按目录优先 + 名称排序）。 */
  children: Map<string, string[]>
  expanded: Set<string>
  loading: Set<string>
  selected: Set<string>
  /** 目录路径 → 该层加载失败的主机原文。 */
  errors: Map<string, string>
}

/** 一行渲染数据（深度优先铺平当前可见节点）。 */
export interface DlRow {
  path: string
  name: string
  kind: 'file' | 'directory'
  depth: number
  expanded: boolean
  checked: boolean
  size?: number
  loading: boolean
  error?: string
}

/**
 * 初始状态：根目录默认展开，等待首层 listDir 填充。
 * @author ddj 2026年11月03号
 * @param root 弹窗根（工作区相对路径，'' = 工作区根）
 * @returns 空树状态
 */
export function createDlState(root: string): DlState {
  return {
    root,
    nodes: new Map(),
    children: new Map(),
    expanded: new Set([root]),
    loading: new Set(),
    selected: new Set(),
    errors: new Map(),
  }
}

/**
 * 合并某目录的 listDir 结果（替换该层子项，清理本次已不存在的旧子项）。
 * @author ddj 2026年11月03号
 * @param state 当前状态
 * @param dirPath 目录路径（'' = 工作区根）
 * @param entries 主机返回的目录项
 * @returns 新状态（loading / errors 中的该目录项被清除）
 */
export function mergeChildren(state: DlState, dirPath: string, entries: TreeEntry[]): DlState {
  const nodes = new Map(state.nodes)
  const children = new Map(state.children)
  const expanded = new Set(state.expanded)
  const loading = new Set(state.loading)
  const selected = new Set(state.selected)
  const errors = new Map(state.errors)
  const previous = children.get(dirPath) ?? []
  const nextPaths: string[] = []

  for (const entry of entries) {
    if (entry.type === 'other') continue
    const kind: DlNode['kind'] = entry.type === 'directory' ? 'directory' : 'file'
    nodes.set(entry.path, { name: entry.name, path: entry.path, kind, size: entry.size })
    nextPaths.push(entry.path)
  }
  nextPaths.sort((left, right) => compareNodes(nodes, left, right))
  children.set(dirPath, nextPaths)
  loading.delete(dirPath)
  errors.delete(dirPath)

  // 本次列表里消失的旧子项整支清理：残留节点会让勾选命中幽灵路径，也会让弹窗显示已删文件。
  for (const stale of previous) {
    if (nextPaths.includes(stale)) continue
    nodes.delete(stale)
    selected.delete(stale)
    children.delete(stale)
    expanded.delete(stale)
  }

  return { root: state.root, nodes, children, expanded, loading, selected, errors }
}

/**
 * 标记某目录正在加载（展开时先出「加载中…」行）。
 * @author ddj 2026年11月03号
 * @param state 当前状态
 * @param dirPath 目录路径
 * @returns 新状态
 */
export function markLoading(state: DlState, dirPath: string): DlState {
  const loading = new Set(state.loading)
  loading.add(dirPath)
  return { ...state, loading }
}

/**
 * 标记某目录加载失败（保留错误原文供重试行显示）。
 * @author ddj 2026年11月03号
 * @param state 当前状态
 * @param dirPath 目录路径
 * @param message 主机错误原文
 * @returns 新状态
 */
export function markError(state: DlState, dirPath: string, message: string): DlState {
  const loading = new Set(state.loading)
  const errors = new Map(state.errors)
  loading.delete(dirPath)
  errors.set(dirPath, message)
  return { ...state, loading, errors }
}

/**
 * 展开目录（不改 children，加载由调用方按 needLoad 判定）。
 * @author ddj 2026年11月03号
 * @param state 当前状态
 * @param dirPath 目录路径
 * @returns 新状态
 */
export function expandDir(state: DlState, dirPath: string): DlState {
  const expanded = new Set(state.expanded)
  expanded.add(dirPath)
  return { ...state, expanded }
}

/**
 * 收起目录。
 * @author ddj 2026年11月03号
 * @param state 当前状态
 * @param dirPath 目录路径
 * @returns 新状态
 */
export function collapseDir(state: DlState, dirPath: string): DlState {
  const expanded = new Set(state.expanded)
  expanded.delete(dirPath)
  return { ...state, expanded }
}

/**
 * 目录是否已展开。
 * @author ddj 2026年11月03号
 * @param state 当前状态
 * @param dirPath 目录路径
 * @returns 是否展开
 */
export function isExpanded(state: DlState, dirPath: string): boolean {
  return state.expanded.has(dirPath)
}

/**
 * 某目录是否已拉取过子项（决定展开时要不要发 listDir）。
 * @author ddj 2026年11月03号
 * @param state 当前状态
 * @param dirPath 目录路径
 * @returns 是否已加载
 */
export function hasLoaded(state: DlState, dirPath: string): boolean {
  return state.children.has(dirPath)
}

/**
 * 切换文件勾选（超过上限的文件不可勾选；目录与未知路径忽略）。
 * @author ddj 2026年11月03号
 * @param state 当前状态
 * @param path 文件路径
 * @returns 新状态
 */
export function toggleFile(state: DlState, path: string): DlState {
  const node = state.nodes.get(path)
  if (!node || node.kind !== 'file') return state
  if (isOversized(node.size)) return state
  const selected = new Set(state.selected)
  if (selected.has(path)) selected.delete(path)
  else selected.add(path)
  return { ...state, selected }
}

/**
 * 全选已加载文件（不含超限文件）。
 * @author ddj 2026年11月03号
 * @param state 当前状态
 * @returns 新状态
 */
export function selectLoaded(state: DlState): DlState {
  const selected = new Set<string>()
  for (const path of loadedFiles(state)) {
    const node = state.nodes.get(path)
    if (node && !isOversized(node.size)) selected.add(path)
  }
  return { ...state, selected }
}

/**
 * 清空勾选。
 * @author ddj 2026年11月03号
 * @param state 当前状态
 * @returns 新状态
 */
export function clearSelected(state: DlState): DlState {
  return { ...state, selected: new Set<string>() }
}

/**
 * 已勾选文件（按路径排序，保证下载顺序稳定可测）。
 * @author ddj 2026年11月03号
 * @param state 当前状态
 * @returns 路径列表
 */
export function selectedFiles(state: DlState): string[] {
  return Array.from(state.selected).sort()
}

/**
 * 已加载的文件路径（全选的作用域就是它）。
 * @author ddj 2026年11月03号
 * @param state 当前状态
 * @returns 路径列表
 */
export function loadedFiles(state: DlState): string[] {
  const out: string[] = []
  for (const node of state.nodes.values()) {
    if (node.kind === 'file') out.push(node.path)
  }
  return out.sort()
}

/**
 * 当前可见行（深度优先；只展开已展开目录）。
 * @author ddj 2026年11月03号
 * @param state 当前状态
 * @returns 渲染行列表
 */
export function rowList(state: DlState): DlRow[] {
  const rows: DlRow[] = []
  appendRows(state, state.root, 0, rows)
  return rows
}

/**
 * 递归铺平子项（仅内部使用；深度受限于用户实际展开层数）。
 * @author ddj 2026年11月03号
 * @param state 当前状态
 * @param dirPath 当前目录
 * @param depth 缩进层级
 * @param rows 输出累积
 */
function appendRows(state: DlState, dirPath: string, depth: number, rows: DlRow[]): void {
  if (!state.expanded.has(dirPath)) return
  const childPaths = state.children.get(dirPath) ?? []
  for (const path of childPaths) {
    const node = state.nodes.get(path)
    if (!node) continue
    const expanded = node.kind === 'directory' && state.expanded.has(path)
    rows.push({
      path,
      name: node.name,
      kind: node.kind,
      depth,
      expanded,
      checked: state.selected.has(path),
      size: node.size,
      loading: state.loading.has(path),
      error: state.errors.get(path),
    })
    if (node.kind === 'directory') appendRows(state, path, depth + 1, rows)
  }
}

/**
 * 体积可读文案（列表右侧提示用）。
 * @author ddj 2026年11月03号
 * @param size 字节数
 * @returns 如 `512 B` / `12 KB` / `3.4 MB`
 */
export function formatSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return size + ' B'
  if (size < 1024 * 1024) return Math.round(size / 1024) + ' KB'
  return (size / (1024 * 1024)).toFixed(1) + ' MB'
}

/**
 * 体积是否超过单文件上限（主机 >32MB 会直接拒绝，界面提前拦一层）。
 * @author ddj 2026年11月03号
 * @param size 字节数（主机未提供体积时为 undefined ⇒ 不预判）
 * @returns 是否超限
 */
export function isOversized(size: number | undefined): boolean {
  return typeof size === 'number' && size > DL_SIZE_CAP
}

/**
 * 目录优先 + 名称排序的比较器（与资源管理器视觉一致）。
 * @author ddj 2026年11月03号
 * @param nodes 节点表
 * @param left 左路径
 * @param right 右路径
 * @returns 比较结果
 */
function compareNodes(nodes: Map<string, DlNode>, left: string, right: string): number {
  const one = nodes.get(left)
  const two = nodes.get(right)
  if (!one || !two) return 0
  if (one.kind !== two.kind) return one.kind === 'directory' ? -1 : 1
  return one.name.localeCompare(two.name)
}
