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
  label: string
  /** 排序：数值越小越靠前（缺省 100）。 */
  order?: number
  /** 红色警示样式（如删除类操作）。 */
  danger?: boolean
  /** 置灰不可点（如无权限/目标不支持时）。 */
  disabled?: boolean
  /** 前置分隔线。 */
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
 * 按目标构建当前可见菜单项（visible 过滤 + order 排序）。
 * @author ddj 2026年08月27号
 * @param registry 菜单项注册表
 * @param target 右键目标
 * @param ctx 面板共享上下文
 * @returns 可见菜单项（已排序）
 */
export function buildTreeMenu(registry: TreeMenuRegistry | undefined, target: TreeMenuTarget, ctx: SidebarCtx): TreeMenuItem[] {
  if (!registry) return []
  const out: TreeMenuItem[] = []
  for (const item of registry.list()) {
    if (typeof item.visible === 'function' && !item.visible(target, ctx)) continue
    out.push(item)
  }
  return out
}
