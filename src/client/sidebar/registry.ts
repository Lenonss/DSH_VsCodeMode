/**
 * dsh-vscode-mode client — 侧边栏面板注册表。
 * 镜像 fileOpeners.ts 的注册表模式：create + register(返回注销) + list + subscribe，
 * 由 client/index.ts `ctx.provide('edrvSidebarPanels', registry)` 对外暴露（第三方可注册）。
 * 作者 ddj 2026-08-26
 */
import type { SidebarPanelDef } from './types.js'

export interface SidebarPanelRegistry {
  register(panel: SidebarPanelDef): () => void
  list(): readonly SidebarPanelDef[]
  subscribe(listener: () => void): () => void
  get(id: string): SidebarPanelDef | undefined
}

/** 校验面板定义并写入注册表（缺 id/render 抛 TypeError）。 */
function panelRegister(entries: Map<string, SidebarPanelDef>, notify: () => void, panel: SidebarPanelDef): void {
  if (!panel.id || typeof panel.render !== 'function') throw new TypeError('侧边栏面板必须提供 id 和 render')
  entries.set(panel.id, panel)
  notify()
}

/**
 * 创建生命周期独立的面板注册表。
 * @author ddj 2026年08月26号
 * @returns 面板注册表
 */
export function createSidebarPanelRegistry(): SidebarPanelRegistry {
  const entries = new Map<string, SidebarPanelDef>()
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  const list = (): readonly SidebarPanelDef[] =>
    [...entries.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
  return {
    register(panel: SidebarPanelDef): () => void {
      panelRegister(entries, notify, panel)
      return () => {
        if (entries.get(panel.id) !== panel) return
        entries.delete(panel.id)
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
