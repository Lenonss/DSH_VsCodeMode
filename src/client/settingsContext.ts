/**
 * dsh-vscode-mode client — 设置 scope 的跨组件上下文。
 * 绑定逻辑（webUiSettings 兼容桥 → 官方 settingsScope 降级）统一由 compat 层提供。
 * 作者 ddj 2026年08月24号
 */
import React from 'react'
import { pickSettingsBinder, type SettingsScopeLike } from './compat.js'

export type { SettingsScopeLike }

export const SettingsContext = React.createContext<SettingsScopeLike | undefined>(undefined)

/**
 * 从 Cordis 服务绑定 VSCodeMode 设置 scope（兼容桥优先，官方次之）。
 * @author ddj 2026年08月24号
 * @param ctx 客户端服务上下文
 * @returns 设置 scope 或 undefined
 */
export function getSettingsScope(ctx: { get: (name: string) => unknown }): SettingsScopeLike | undefined {
  return pickSettingsBinder(ctx).scope
}
