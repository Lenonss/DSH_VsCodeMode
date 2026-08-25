// @ts-nocheck
/**
 * dsh-vscode-mode client — 「大纲」面板定义（注册表一项）。
 * 数据源解析复用 outline/sources 的源注册表（ctx.outlineSources 注入）。
 * 作者 ddj 2026-08-27
 */
import React from 'react'
import { OutlinePanel } from './OutlinePanel.js'
import type { SidebarPanelDef, SidebarCtx } from '../sidebar/types.js'

/**
 * 构造大纲面板定义。
 * @author ddj 2026年08月27号
 * @returns 面板定义（无徽标；活动栏图标 📜）
 */
export function createOutlinePanel(): SidebarPanelDef {
  return {
    id: 'outline',
    title: '大纲',
    icon: '📜',
    order: 20,
    render: (ctx: SidebarCtx) => React.createElement(OutlinePanel, { ctx }),
  }
}
