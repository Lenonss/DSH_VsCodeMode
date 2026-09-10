// @ts-nocheck
/**
 * dsh-vscode-mode client — 侧边栏面板定义（文件管理 + 搜索 + 规则）。
 * 活动栏图标用官方 UI 原语（跟随 DSH 主题与皮肤）；原语缺失时由 SidebarView 回落文本渲染。
 * 作者 ddj 2026-08-26 / 2026-09-03 / 2026-09-10
 */
import React from 'react'
import { IconFolderOpenOutline16, IconListPenOutline16, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { FileExplorer } from './FileExplorer.js'
import { SearchPanel } from './SearchPanel.js'
import { RulesPanel } from './RulesPanel.js'
import type { SidebarPanelDef, SidebarCtx } from '../types.js'

/**
 * 构造文件管理面板定义。
 * @author ddj 2026年08月26号 / 2026年09月10号
 * @returns 面板定义（含活动栏徽标 = 差异文件总数；图标 = 官方 IconFolderOpenOutline16）
 */
export function createFilePanel(): SidebarPanelDef {
  return {
    id: 'explorer',
    title: '文件管理',
    icon: IconFolderOpenOutline16,
    order: 10,
    badge: (ctx: SidebarCtx) => (ctx.sum && ctx.sum.totalFiles > 0 ? ctx.sum.totalFiles : null),
    render: (ctx: SidebarCtx) => React.createElement(FileExplorer, { ctx }),
  }
}

/**
 * 构造搜索面板定义。
 * @author ddj 2026年08月30号 / 2026年09月10号
 * @returns 面板定义（无徽标；图标 = 官方 IconSearchOutline16）
 */
export function createSearchPanel(): SidebarPanelDef {
  return {
    id: 'search',
    title: '搜索',
    icon: IconSearchOutline16,
    order: 15,
    render: (ctx: SidebarCtx) => React.createElement(SearchPanel, { ctx }),
  }
}

/**
 * 构造规则管理面板定义（Codebuddy 规则形态：用户规则/项目规则双 Tab + 开关）。
 * @author ddj 2026年09月03号 / 2026年09月10号
 * @returns 面板定义（无徽标；图标 = 官方 IconListPenOutline16）
 */
export function createRulesPanel(): SidebarPanelDef {
  return {
    id: 'rules',
    title: '规则',
    icon: IconListPenOutline16,
    order: 20,
    render: (ctx: SidebarCtx) => React.createElement(RulesPanel, { ctx }),
  }
}
