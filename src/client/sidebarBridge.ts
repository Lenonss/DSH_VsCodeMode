/**
 * dsh-vscode-mode client — 侧边栏编辑区桥：可选探测 dsh-better-sidebar 的
 * ctx.betterSidebar 服务，并注册「文件编辑」Tab（单实例）。
 * 可选依赖模式：服务缺失时调用方回退到中央页签形态；本模块不注册任何东西。
 * 纯逻辑（探测/初始打开解析/角标计数）可单测，DOM/事件仅存在于 install 路径。
 * 作者 ddj 2026年08月25号
 */

import React from 'react'

/** betterSidebar 服务名（ctx.get 用；不要加进 inject——缺失会让插件停靠等待）。 */
export const BETTER_SIDEBAR_SERVICE = 'betterSidebar'
/** 本插件在侧边栏注册的 Tab 类型 id（亦是 SidebarTab.type）。 */
export const SIDE_TAB_ID = 'edrv-editor'
/** 侧边栏 Tab 标题。 */
export const SIDE_TAB_TITLE = '文件编辑'
/** 推荐安装命令（提示条/兼容性报告共用）。 */
export const SIDEBAR_INSTALL_CMD = 'dsh plugin --profile web add dsh-better-sidebar'

/** Tab 元数据（openTab 种子随 Tab 持久化，创建路径用它恢复初始打开）。 */
export interface SideEditorMeta {
  /** 待打开的工作区相对/绝对路径。 */
  openPath?: string
  /** 打开后聚焦首个差异。 */
  focusDiff?: boolean
}

/**
 * betterSidebar 服务的最小结构面（结构性探测，不 import 第三方类型）。
 */
export interface SidebarServiceLike {
  registerTab: (descriptor: unknown) => () => void
  openTab: (seed: { type: string; title?: string; path?: string; meta?: unknown }, scope?: { sessionId: string; cwd?: string }) => void
  isTabEnabled?: (id: string) => boolean
  features?: readonly string[]
}

/**
 * 解析 Tab 挂载时的初始打开请求（创建路径读 tab.path/meta，聚焦路径走窗口事件）。
 * @author ddj 2026年08月25号
 * @param tab 侧边栏 Tab（path/meta 为可选字段）
 * @returns 待打开路径与是否聚焦差异
 */
export function resolveInitialOpen(tab: { path?: string; meta?: unknown } | null | undefined): { path: string | null; focusDiff: boolean } {
  const meta = (tab?.meta ?? {}) as SideEditorMeta
  const path = typeof tab?.path === 'string' && tab.path ? tab.path : (typeof meta?.openPath === 'string' ? meta.openPath : null)
  return { path: path || null, focusDiff: meta?.focusDiff === true }
}

/** 会话级待处理差异文件数缓存（Tab 角标同步读取；EditorView 侧栏形态写入）。 */
const sidePending = new Map<string, number>()

/**
 * 写入会话的待处理差异文件数（0 视为清除，不显示角标）。
 * @author ddj 2026年08月25号
 * @param sessionId 会话 id
 * @param count 待处理差异文件数
 */
export function setSidePending(sessionId: string, count: number): void {
  if (!sessionId) return
  const value = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  if (value > 0) sidePending.set(sessionId, value)
  else sidePending.delete(sessionId)
}

/**
 * 读取会话的待处理差异文件数（角标用）。
 * @author ddj 2026年08月25号
 * @param sessionId 会话 id
 * @returns 非负计数
 */
export function getSidePending(sessionId?: string): number {
  if (!sessionId) return 0
  return sidePending.get(sessionId) ?? 0
}

/** 模块级侧栏打开路由（events.ts 优先走它；未注册 = 旧页签形态）。 */
let ensureSideEditor: ((path: string | null, focusDiff: boolean) => boolean) | null = null

/** 待消费的初始打开（Tab 组件尚未挂载时暂存；按会话匹配，挂载时取走）。 */
let pendingOpen: { sessionId: string; path: string | null; focusDiff: boolean } | null = null
/** Tab 组件当前是否有挂载实例（有则直接投递窗口事件，无则暂存待消费）。 */
let sideEditorMounted = false

/**
 * 注册/撤销侧栏打开路由。
 * @author ddj 2026年08月25号
 * @param fn 路由函数或 null
 */
export function setEnsureSideEditor(fn: ((path: string | null, focusDiff: boolean) => boolean) | null): void {
  ensureSideEditor = fn
}

/**
 * 标记侧栏编辑器组件挂载状态（SideEditorTab 挂载/卸载时调用）。
 * @author ddj 2026年08月25号
 * @param mounted 是否已挂载
 */
export function setSideEditorMounted(mounted: boolean): void {
  sideEditorMounted = mounted
}

/**
 * 暂存指定会话的待消费初始打开（Tab 组件未挂载时由 install 路径调用）。
 * @author ddj 2026年08月25号
 * @param sessionId 会话 id
 * @param path 待打开路径（可空）
 * @param focusDiff 是否聚焦首个差异
 */
export function stagePendingSideOpen(sessionId: string, path: string | null, focusDiff: boolean): void {
  if (!sessionId) return
  pendingOpen = { sessionId, path: path || null, focusDiff: focusDiff === true }
}

/**
 * 取走指定会话的待消费初始打开（SideEditorTab 挂载时读取；不存在返回 null）。
 * @author ddj 2026年08月25号
 * @param sessionId 会话 id
 * @returns 待打开请求或 null
 */
export function takePendingSideOpen(sessionId?: string): { path: string | null; focusDiff: boolean } | null {
  if (!pendingOpen || !sessionId || pendingOpen.sessionId !== sessionId) return null
  const value = { path: pendingOpen.path, focusDiff: pendingOpen.focusDiff }
  pendingOpen = null
  return value
}

/**
 * 打开/聚焦侧栏编辑器（打开路径可选；返回是否已被侧栏形态接管）。
 * @author ddj 2026年08月25号
 * @param path 待打开路径（可空）
 * @param focusDiff 是否聚焦首个差异
 * @returns 是否路由成功
 */
export function routeSideEditor(path: string | null, focusDiff: boolean): boolean {
  if (typeof ensureSideEditor !== 'function') return false
  try {
    return ensureSideEditor(path, focusDiff) === true
  } catch (error) {
    console.warn('[dsh-vscode-mode] 侧栏编辑器打开失败（' + String(error) + '），已回退')
    return false
  }
}

/**
 * 结构化探测 betterSidebar 服务（可选依赖：缺失/降级返回 undefined）。
 * @author ddj 2026年08月25号
 * @param ctx 客户端服务上下文
 * @returns 服务结构面或 undefined
 */
export function detectSidebarService(ctx: { get: (name: string) => unknown }): SidebarServiceLike | undefined {
  try {
    const service = ctx.get(BETTER_SIDEBAR_SERVICE) as SidebarServiceLike | undefined
    if (!service || typeof service.registerTab !== 'function' || typeof service.openTab !== 'function') return undefined
    return service
  } catch {
    return undefined
  }
}

/**
 * 注册侧边栏「文件编辑」Tab 并接管打开路由。
 * Tab 被用户在 better-sidebar 设置里禁用时，打开路由降级为回退回调（中央页签）。
 * @author ddj 2026年08月25号
 * @param options 装配参数（组件依赖 + 活动会话解析 + 回退注册）
 * @returns 卸载器（反注册 Tab + 撤销路由）
 */
export function installSideEditor(options: {
  service: SidebarServiceLike
  renderTab: (props: Record<string, unknown>) => unknown
  activeSession: () => { sessionId?: string; cwd?: string } | undefined
  registerLegacyFallback: () => void
}): () => void {
  const { service, renderTab, activeSession, registerLegacyFallback } = options
  let fallbackInstalled = false
  const open = (path: string | null, focusDiff: boolean): boolean => {
    if (typeof service.isTabEnabled === 'function' && !service.isTabEnabled(SIDE_TAB_ID)) {
      if (!fallbackInstalled) {
        fallbackInstalled = true
        try { registerLegacyFallback() } catch (error) { console.warn('[dsh-vscode-mode] 回退注册失败（' + String(error) + '）') }
      }
      return false
    }
    const scope = activeSession()
    const sessionId = scope?.sessionId
    if (!sessionId) return false
    try {
      service.openTab({
        type: SIDE_TAB_ID,
        title: SIDE_TAB_TITLE,
        ...(path ? { path } : {}),
        meta: { openPath: path || undefined, focusDiff },
      }, { sessionId, cwd: scope?.cwd })
    } catch (error) {
      console.warn('[dsh-vscode-mode] openTab 失败（' + String(error) + '）')
      return false
    }
    if (sideEditorMounted) {
      // 已挂载：窗口事件直达 EditorView 监听器
      window.dispatchEvent(new CustomEvent('edrv:open-editor', { detail: { path, focusDiff } }))
    } else {
      // 未挂载（面板折叠卸载/首次创建）：暂存待消费，挂载时由 SideEditorTab 取走
      stagePendingSideOpen(sessionId, path, focusDiff)
    }
    return true
  }
  let tabDisposer: (() => void) | null = null
  try {
    tabDisposer = service.registerTab({
      id: SIDE_TAB_ID,
      title: SIDE_TAB_TITLE,
      icon: codeIcon,
      single: true,
      badge: (_ctx: unknown, scope: { sessionId?: string }) => getSidePending(scope?.sessionId) || null,
      component: renderTab,
    })
  } catch (error) {
    console.warn('[dsh-vscode-mode] 侧边栏 Tab 注册失败（' + String(error) + '）')
    // 注册失败 = 侧栏形态不可用：立即回退中央页签，不接管打开路由
    if (!fallbackInstalled) {
      fallbackInstalled = true
      try { registerLegacyFallback() } catch (inner) { console.warn('[dsh-vscode-mode] 回退注册失败（' + String(inner) + '）') }
    }
    return () => {}
  }
  setEnsureSideEditor(open)
  return () => {
    if (typeof tabDisposer === 'function') tabDisposer()
    setEnsureSideEditor(null)
  }
}

/**
 * 侧边栏 Tab 图标（内联 SVG 代码括号，不依赖图标包）。
 * @author ddj 2026年08月25号
 * @param size 边长（px）
 * @returns 图标元素
 */
function codeIcon(size: number): unknown {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false,
  },
    React.createElement('path', {
      d: 'M5.5 4.5 2.5 8l3 3.5M10.5 4.5 13.5 8l-3 3.5',
      stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
    }))
}
