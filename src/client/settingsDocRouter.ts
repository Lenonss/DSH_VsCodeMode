/** Redirect the DSH settings document action into the plugin editor. */
import { patchAccessor } from './compat.js'

export interface SettingsDocResult {
  ok: boolean
  value?: { opened: boolean }
}

type SettingsDocOpen = (...args: unknown[]) => Promise<SettingsDocResult>

/**
 * Patch the optional DSH settings document opener; failed handoff keeps native behavior.
 * @author ddj 2026年10月02号
 * @param service DSH remote settings namespace
 * @param getPath plugin RPC that prepares the profile document
 * @param openEditor current plugin editor action
 * @param logger optional diagnostic sink
 * @returns disposer, or null if the DSH API is unavailable
 */
export function patchSettingsDoc(
  service: object,
  getPath: () => Promise<{ ok: boolean; path?: string; error?: string }>,
  openEditor: (path: string) => void,
  logger?: (message: string) => void,
): (() => void) | null {
  return patchAccessor(service, 'openSettingsDocument', async (original, ...args) => {
    try {
      const result = await getPath()
      if (!result.ok || !result.path) throw new Error(result.error || '设置配置文件路径不可用')
      openEditor(result.path)
      return { ok: true, value: { opened: true } }
    } catch (error) {
      logger?.('插件编辑器打开设置配置文件失败，回退 DSH 原生打开: ' + String(error))
      return (original as SettingsDocOpen)(...args)
    }
  })
}

/**
 * Safely locate the optional DSH settings remote service.
 * @author ddj 2026年10月02号
 * @param ctx Client service context
 * @returns The settings service when its document opener exists
 */
export function probeSettingsDoc(ctx: { get: (name: string) => unknown }): object | undefined {
  try {
    const service = ctx.get('remote.settings') as { openSettingsDocument?: unknown } | undefined
    return typeof service?.openSettingsDocument === 'function' ? service : undefined
  } catch {
    return undefined
  }
}
