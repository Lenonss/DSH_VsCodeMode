/**
 * dsh-vscode-mode client — 文件管理右键菜单框架（类型 + 注册表 + 纯构建函数）。
 * 镜像 sidebar/registry.ts 的注册表模式：create + register(返回注销) + list + subscribe，
 * 由 client/index.ts `ctx.provide('edrvFileContextMenuItems', registry)` 对外暴露（第三方可注册）。
 * 新增菜单项只需 register 一条 TreeMenuItem，面板在右键打开时经 buildTreeMenu 过滤/排序。
 * 本模块不触 React/浏览器，可单测。
 * 作者 ddj 2026-08-27
 */
import type { TreeEntry } from '../../shared/rpc.js'
import type { SidebarCtx } from './types.js'

/** 右键目标（树行/面板空白区，path 相对工作区根，'' 表示根目录）。 */
export interface TreeMenuTarget {
  path: string
  type: TreeEntry['type']
}

/** 一条右键菜单项定义。 */
export interface TreeMenuItem {
  id: string
  /** 展示文案；目标相关时可传函数（buildTreeMenu 解析为字符串）。 */
  label: string | ((target: TreeMenuTarget, ctx: SidebarCtx) => string)
  /** 排序：数值越小越靠前（缺省 100）。 */
  order?: number
  /** 分组：同组条目相邻成块，组切换处由 buildTreeMenu 动态置前置分隔线（缺省不参与分组）。 */
  group?: number
  /** 红色警示样式（如删除类操作）。 */
  danger?: boolean
  /** 置灰不可点（如无权限/目标不支持时）：布尔或按目标动态求值。 */
  disabled?: boolean | ((target: TreeMenuTarget, ctx: SidebarCtx) => boolean)
  /** 前置分隔线（不带 group 的存量/第三方条目沿用静态语义）。 */
  separator?: boolean
  /** 显隐守卫：返回 false 则不显示。 */
  visible?: (target: TreeMenuTarget, ctx: SidebarCtx) => boolean
  run: (target: TreeMenuTarget, ctx: SidebarCtx) => void
}

/** 右键菜单项注册表（生命周期独立，可注册/注销/订阅）。 */
export interface TreeMenuRegistry {
  register(item: TreeMenuItem): () => void
  list(): readonly TreeMenuItem[]
  subscribe(listener: () => void): () => void
  get(id: string): TreeMenuItem | undefined
}

/** 校验菜单项并写入注册表（缺 id/run/label 抛 TypeError）。 */
function itemRegister(entries: Map<string, TreeMenuItem>, notify: () => void, item: TreeMenuItem): void {
  if (!item.id || typeof item.run !== 'function' || !item.label) {
    throw new TypeError('文件右键菜单项必须提供 id、label 和 run')
  }
  entries.set(item.id, item)
  notify()
}

/**
 * 创建生命周期独立的右键菜单项注册表。
 * @author ddj 2026年08月27号
 * @returns 菜单项注册表
 */
export function createTreeMenuRegistry(): TreeMenuRegistry {
  const entries = new Map<string, TreeMenuItem>()
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  const list = (): readonly TreeMenuItem[] =>
    [...entries.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
  return {
    register(item: TreeMenuItem): () => void {
      itemRegister(entries, notify, item)
      return () => {
        if (entries.get(item.id) !== item) return
        entries.delete(item.id)
        notify()
      }
    },
    list,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: (id: string) => entries.get(id),
  }
}

/**
 * 按目标解析动态字段并计算前置分隔线（纯函数）。
 *
 * 分隔线口径：
 * - 带 group 的条目：与前一条可见条目组号不同即出线（首条除外）——组首条被 visible
 *   隐藏时下一条自动顶上分组头，不丢线也不重复出线；
 * - 不带 group 的存量/第三方条目：沿用其静态 separator；
 * - 统一收尾：相邻分隔线合并为一条（动态组头与静态分隔线相邻时不叠双线）。
 * @author ddj 2026年09月22号
 * @param items 可见条目（已按 visible 过滤、按 order 排序）
 * @param target 右键目标（动态 label/disabled 求值用）
 * @param ctx 面板共享上下文
 * @returns 解析后的条目（label/disabled 已定值、separator 已定值）
 */
export function markMenuSeparators(
  items: readonly TreeMenuItem[],
  target: TreeMenuTarget,
  ctx: SidebarCtx,
): TreeMenuItem[] {
  const out: TreeMenuItem[] = []
  let prevGroup: number | null = null
  let sepEmitted = false
  for (const item of items) {
    const grouped = typeof item.group === 'number'
    let sep = grouped ? (out.length > 0 && item.group !== prevGroup) : (item.separator === true && out.length > 0)
    if (grouped) prevGroup = item.group as number
    if (sep && sepEmitted) sep = false
    sepEmitted = sep
    out.push({
      ...item,
      label: typeof item.label === 'function' ? item.label(target, ctx) : item.label,
      disabled: typeof item.disabled === 'function' ? item.disabled(target, ctx) === true : item.disabled === true,
      separator: sep,
    })
  }
  return out
}

/**
 * 按目标构建当前可见菜单项（visible 过滤 + order 排序 + 动态字段解析 + 分组分隔线）。
 * @author ddj 2026年08月27号 / 2026年09月22号
 * @param registry 菜单项注册表
 * @param target 右键目标
 * @param ctx 面板共享上下文
 * @returns 可见菜单项（已排序、已解析）
 */
export function buildTreeMenu(registry: TreeMenuRegistry | undefined, target: TreeMenuTarget, ctx: SidebarCtx): TreeMenuItem[] {
  if (!registry) return []
  const visible: TreeMenuItem[] = []
  for (const item of registry.list()) {
    if (typeof item.visible === 'function' && !item.visible(target, ctx)) continue
    visible.push(item)
  }
  return markMenuSeparators(visible, target, ctx)
}
