// @ts-nocheck
/**
 * dsh-vscode-mode client — 「大纲」面板定义（注册表一项）。
 * 数据源解析复用 outline/sources 的源注册表（ctx.outlineSources 注入）。
 * 作者 ddj 2026-08-27
 */
import React from 'react'
import { IconCodeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { OutlinePanel } from './OutlinePanel.js'
import type { SidebarPanelDef, SidebarCtx } from '../sidebar/types.js'

/**
 * 构造大纲面板定义。
 * @author ddj 2026年08月27号 / 2026年09月10号
 * @returns 面板定义（无徽标；活动栏图标 = 官方 IconCodeOutline16）
 */
export function createOutlinePanel(): SidebarPanelDef {
  return {
    id: 'outline',
    title: '大纲',
    icon: IconCodeOutline16,
    order: 20,
    render: (ctx: SidebarCtx) => React.createElement(OutlinePanel, { ctx }),
  }
}
