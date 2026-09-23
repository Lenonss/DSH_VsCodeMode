/**
 * dsh-vscode-mode client — 设置 scope 的跨组件上下文。
 * 绑定逻辑（configForms 0.1.7+ → webUiSettings 兼容桥 → 官方 settingsScope 降级，
 * 带晚到有界重试）统一由 compat 层提供。
 * 作者 ddj 2026年08月24号 / 2026年09月22号
 */
import React from 'react'
import { pickSettingsBinder, type SettingsScopeLike } from './compat.js'

export type { SettingsScopeLike }

export const SettingsContext = React.createContext<SettingsScopeLike | undefined>(undefined)

/**
 * 从 Cordis 服务绑定 VSCodeMode 设置 scope（四级桥：configForms/webUiSettings/settingsScope/无）。
 * 每次调用重新探测——设置提供方晚到时后续渲染自然拿到新桥（自愈）。
 * @author ddj 2026年08月24号（2026年09月22号 增补 configForms 级）
 * @param ctx 客户端服务上下文
 * @returns 设置 scope 或 undefined
 */
export function getSettingsScope(ctx: { get: (name: string) => unknown }): SettingsScopeLike | undefined {
  return pickSettingsBinder(ctx).scope
}
