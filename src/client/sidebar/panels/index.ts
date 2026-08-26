// @ts-nocheck
/**
 * dsh-vscode-mode client — 侧边栏面板定义（文件管理 + 搜索）。
 * 作者 ddj 2026-08-26 / 2026-08-26
 */
import React from 'react'
import { FileExplorer } from './FileExplorer.js'
import { SearchPanel } from './SearchPanel.js'
import type { SidebarPanelDef, SidebarCtx } from '../types.js'

/**
 * 构造文件管理面板定义。
 * @author ddj 2026年08月26号
 * @returns 面板定义（含活动栏徽标 = 差异文件总数）
 */
export function createFilePanel(): SidebarPanelDef {
  return {
    id: 'explorer',
    title: '文件管理',
    icon: '📁',
    order: 10,
    badge: (ctx: SidebarCtx) => (ctx.sum && ctx.sum.totalFiles > 0 ? ctx.sum.totalFiles : null),
    render: (ctx: SidebarCtx) => React.createElement(FileExplorer, { ctx }),
  }
}

/**
 * 构造搜索面板定义。
 * @author ddj 2026年08月30号
 * @returns 面板定义（无徽标；活动栏图标 🔍）
 */
export function createSearchPanel(): SidebarPanelDef {
  return {
    id: 'search',
    title: '搜索',
    icon: '🔍',
    order: 15,
    render: (ctx: SidebarCtx) => React.createElement(SearchPanel, { ctx }),
  }
}
