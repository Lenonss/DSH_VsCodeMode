/**
 * dsh-vscode-mode host — 文件链接打开工具的持久化设置。
 * 依赖守卫：@deepseek-ai/dsh-settings / schemastery 以动态加载引入，
 * 缺失时插件仍可加载（fileOpenTool 降级为配置值，compat 报告可见）。
 * 作者 ddj 2026年08月24号
 */
import type { Ctx } from './store.js'

export const FILE_OPEN_SETTINGS_NS = 'dsh-vscode-mode'
export const FILE_OPEN_DEFAULT = 'auto'
export interface FileOpenSettings { fileOpenTool: string }
export interface FileOpenSettingsState { value: string; revision?: number; update: (value: string, expectedRevision?: number) => Promise<void> }

type SettingsProvider = {
  update?: (ns: string, patch: object, expectedRevision?: number) => Promise<void>
  describe?: (options?: unknown) => Array<{ ns?: string; value?: unknown; revision?: number }>
  get?: (ns: string) => unknown
}

/** 动态依赖的装载结果（宽松类型：dsh-settings 无本地类型声明）。 */
export interface SettingsDeps {
  installSettingsSection: (ctx: Ctx, ns: string, schema: unknown, entry: object, hooks: object) => void
  z: {
    object: (shape: Record<string, unknown>) => unknown
    string: () => { default: (value: string) => unknown }
  }
}

export type SettingsDepsLoader = () => Promise<SettingsDeps | null>

let depsPromise: Promise<SettingsDeps | null> | undefined

/**
 * 动态加载设置依赖（模块级缓存；任一缺失返回 null 而非抛错）。
 * @author ddj 2026年08月24号
 * @returns 设置依赖或 null
 */
export function loadSettingsDeps(): Promise<SettingsDeps | null> {
  if (!depsPromise) {
    depsPromise = Promise.all([import('@deepseek-ai/dsh-settings'), import('schemastery')])
      .then(([dshSettings, schemastery]) => ({
        installSettingsSection: (dshSettings as { installSettingsSection: SettingsDeps['installSettingsSection'] }).installSettingsSection,
        z: (schemastery as { default: SettingsDeps['z'] }).default,
      }))
      .catch(() => null)
  }
  return depsPromise
}

function normalizeValue(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return FILE_OPEN_DEFAULT
  return value.trim()
}

function configValue(config: unknown): string {
  return normalizeValue((config as { fileOpenTool?: unknown } | undefined)?.fileOpenTool)
}

/**
 * 安装设置 section（动态依赖；缺失返回 false 不抛错）。
 * @author ddj 2026年08月24号
 * @param ctx DSH host 上下文
 * @param ns 设置命名空间
 * @param entry 初始设置值
 * @param hooks 设置源绑定与变更回调
 * @param loader 依赖装载器（测试注入）
 * @returns 是否成功安装
 */
export async function installOpenSettingsSection(
  ctx: Ctx,
  ns: string,
  entry: FileOpenSettings,
  hooks: { setSource: (source: () => FileOpenSettings) => void; onChange: () => void },
  loader: SettingsDepsLoader = loadSettingsDeps,
): Promise<boolean> {
  const deps = await loader()
  if (!deps) return false
  const schema = deps.z.object({ fileOpenTool: deps.z.string().default(FILE_OPEN_DEFAULT) })
  deps.installSettingsSection(ctx, ns, schema, entry, hooks)
  return true
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

  void installOpenSettingsSection(ctx, FILE_OPEN_SETTINGS_NS, { fileOpenTool: current }, { setSource, onChange: settingsChange })
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
