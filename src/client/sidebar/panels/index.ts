// @ts-nocheck
/**
 * dsh-vscode-mode client — 「文件管理」面板定义（注册表一项）。
 * 作者 ddj 2026-08-26
 */
import React from 'react'
import { FileExplorer } from './FileExplorer.js'
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
