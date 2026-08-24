/**
 * dsh-vscode-mode client — 设置 scope 的跨组件上下文。
 * @author ddj 2026年08月24号
 */
import React from 'react'

export interface SettingsScopeLike {
  getSnapshot: () => { status?: string; value?: { fileOpenTool?: unknown }; writable?: boolean }
  subscribe: (listener: () => void) => () => void
  set: (field: string, value: unknown) => Promise<void>
}

export const SettingsContext = React.createContext<SettingsScopeLike | undefined>(undefined)

/**
 * 从 Cordis 服务绑定 VSCodeMode 设置 scope。
 * @author ddj 2026年08月24号
 * @param ctx 客户端上下文
 * @returns 设置 scope 或 undefined
 */
/**
 * 绑定官方设置 scope，优先使用 web-ui 兼容桥。
 * @author ddj 2026年08月24号
 * @param ctx 客户端服务上下文
 * @returns 设置 scope；未安装设置服务时返回 undefined
 */
export function getSettingsScope(ctx: { get: (name: string) => unknown }): SettingsScopeLike | undefined {
  const service = ctx.get('webUiSettings') ?? ctx.get('settingsScope')
  const binder = service as { bind?: (spec: { namespace: string }) => SettingsScopeLike } | undefined
  return binder?.bind?.({ namespace: 'dsh-vscode-mode' })
}
