/**
 * dsh-vscode-mode host — 文件链接打开工具的持久化设置。
 * @author ddj 2026年08月24号
 */
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import type { Ctx } from './store.js'

export const FILE_OPEN_SETTINGS_NS = settingsNamespace('dsh-vscode-mode')
export const FILE_OPEN_DEFAULT = 'auto'
export interface FileOpenSettings { fileOpenTool: string }
export interface FileOpenSettingsState { value: string; revision?: number; update: (value: string, expectedRevision?: number) => Promise<void> }

type SettingsProvider = {
  update?: (ns: string, patch: object, expectedRevision?: number) => Promise<void>
  describe?: (options?: unknown) => Array<{ ns?: string; value?: unknown; revision?: number }>
  get?: (ns: string) => unknown
}

const FILE_OPEN_SCHEMA = z.object({ fileOpenTool: z.string().default(FILE_OPEN_DEFAULT) })

function normalizeValue(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return FILE_OPEN_DEFAULT
  return value.trim()
}

function configValue(config: unknown): string {
  return normalizeValue((config as { fileOpenTool?: unknown } | undefined)?.fileOpenTool)
}

/**
 * 注册设置命名空间，并提供 host 侧的读取与更新状态。
 * @author ddj 2026年08月24号
 * @param ctx DSH host 上下文
 * @param config 插件组合配置
 * @param onChange 设置变化回调
 * @returns 设置状态
 */
export function setupOpenSettings(ctx: Ctx, config: unknown, onChange: (value: string) => void): FileOpenSettingsState {
  let current = configValue(config)
  let revision: number | undefined
  let provider: SettingsProvider | undefined
  const notify = (value: unknown): void => { current = normalizeValue(value); onChange(current) }
  const syncRevision = (): void => {
    const descriptor = provider?.describe?.({ redactSecrets: true })?.find((item: { ns?: string }) => item.ns === FILE_OPEN_SETTINGS_NS)
    revision = descriptor?.revision
  }
  const setSource = (source: () => FileOpenSettings): void => notify(source().fileOpenTool)
  const settingsChange = (): void => syncRevision()

  installSettingsSection(ctx, FILE_OPEN_SETTINGS_NS, FILE_OPEN_SCHEMA, { fileOpenTool: current }, { setSource, onChange: settingsChange })
  ctx.inject?.(['settings'], (settingsCtx: Ctx) => {
    provider = settingsCtx.get('settings')
    syncRevision()
  })

  return {
    get value() { return current },
    get revision() { return revision },
    update: async (value: string, expectedRevision?: number): Promise<void> => {
      const next = normalizeValue(value)
      if (!provider?.update) { notify(next); return }
      await provider.update(FILE_OPEN_SETTINGS_NS, { fileOpenTool: next }, expectedRevision)
      const descriptor = provider.describe?.({ redactSecrets: true })?.find((item: { ns?: string; value?: unknown }) => item.ns === FILE_OPEN_SETTINGS_NS)
      const stored = descriptor?.value as { fileOpenTool?: unknown } | undefined
      notify(stored?.fileOpenTool ?? next)
      syncRevision()
    },
  }
}

export function normalizeFileOpenTool(value: unknown): string { return normalizeValue(value) }
