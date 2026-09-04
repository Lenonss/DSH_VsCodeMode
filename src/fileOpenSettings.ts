/**
 * dsh-vscode-mode host — 文件链接打开工具 + 快捷键的持久化设置。
 * 依赖守卫：schemastery 动态加载；@deepseek-ai/dsh-settings 仅作 legacy 探测——
 * rc 线导出 installSettingsSection free function，0.1.2-alpha 起移除（改由 settings
 * 服务的 installSection 方法承载，见 runSettingsInstall 三策略）。
 * 缺失/任一策略失败时插件仍可加载（fileOpenTool 降级为配置值，compat 报告可见），
 * 全程 try/catch，不产生未捕获 rejection。
 * 作者 ddj 2026年08月24号 / 2026年08月26号 / 2026年09月02号
 */
import type { Ctx } from './store.js'
import { KEYBINDING_DEFAULTS } from './shared/keybindings.js'

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
  installSettingsSection?: (ctx: Ctx, ns: string, schema: unknown, entry: object, hooks: object) => void
  z: {
    object: (shape: Record<string, unknown>) => { default: (value: Record<string, unknown>) => unknown }
    string: () => { default: (value: string) => unknown }
    boolean: () => { default: (value: boolean) => unknown }
    number: () => { default: (value: number) => unknown }
  }
}

export type SettingsDepsLoader = () => Promise<SettingsDeps | null>

let depsPromise: Promise<SettingsDeps | null> | undefined

/**
 * 动态加载设置依赖（模块级缓存；任一缺失/失败返回 null 而非抛错）。
 * installSettingsSection 仅在 rc 线 dsh-settings 中存在时提供（alpha 起移除，
 * 属性探测得到 undefined，不抛错）。
 * @author ddj 2026年08月24号
 * @returns 设置依赖或 null
 */
export function loadSettingsDeps(): Promise<SettingsDeps | null> {
  if (!depsPromise) {
    depsPromise = Promise.all([import('@deepseek-ai/dsh-settings'), import('schemastery')])
      .then(([dshSettings, schemastery]) => ({
        // dsh-settings 类型声明随版本变化（rc.8 有 d.ts、alpha 已移除导出），统一经 unknown 松绑
        installSettingsSection: (dshSettings as unknown as { installSettingsSection?: SettingsDeps['installSettingsSection'] }).installSettingsSection,
        z: (schemastery as unknown as { default: SettingsDeps['z'] }).default,
      }))
      .catch(() => null)
  }
  return depsPromise
}

/** 设置 section 安装策略（版本适配机制的观测值）。 */
export type SettingsInstallStrategy = 'legacy' | 'service' | 'none' | 'unknown'

const INSTALL_UNMOUNTED = '设置 section 尚未装配'
const INSTALL_LEGACY = 'rc 线：dsh-settings.installSettingsSection'
const INSTALL_SERVICE = '0.1.2-alpha 线：settings 服务 installSection'
const INSTALL_NONE = '两路均不可用：设置持久化降级为配置值'

interface ObservedInstall { strategy: SettingsInstallStrategy; note: string }
let observedInstall: ObservedInstall = { strategy: 'unknown', note: INSTALL_UNMOUNTED }

/** 记录最近一次安装策略（供兼容报告展示；失败路径也记录，便于诊断）。 */
function recordInstall(strategy: SettingsInstallStrategy, note: string): SettingsInstallStrategy {
  observedInstall = { strategy, note }
  return strategy
}

/** 读取观测到的安装策略（供报告；测试可用 reset 复位）。 */
export function settingsInstallStrategy(): SettingsInstallStrategy {
  return observedInstall.strategy
}

/** 读取观测到的安装策略说明文案。 */
export function settingsInstallNote(): string {
  return observedInstall.note
}

/** 复位安装策略观测（测试隔离用）。 */
export function resetSettingsInstallObserved(): void {
  observedInstall = { strategy: 'unknown', note: INSTALL_UNMOUNTED }
}

/**
 * 设置 section 版本自适应安装（核心策略分派）。
 * legacy：dsh-settings 仍导出 installSettingsSection（rc 线）→ 原样调用，行为与旧版一致。
 * service：该导出已移除（0.1.2-alpha 起）→ 经 ctx.inject(['settings']) 走服务方法
 *          provider.installSection(owner, ns, schema, entry, hooks)（等义封装，含
 *          base 层与 fiber 卸载回退）。回调内方法缺失再降级记录 none。
 * none：两条路由都不存在 → 仅记录并告警，调用方按配置值运行。
 * 全程不抛错、不产生未捕获 rejection。
 * @author ddj 2026年09月02号
 * @param ctx DSH host 上下文（inject 可选探测）
 * @param ns 设置命名空间
 * @param schema schemastery schema
 * @param entry 初始设置值（作为 base 层）
 * @param hooks 设置源绑定与变更回调
 * @param loader 依赖装载器（测试注入）
 * @returns 采用/观测到的策略
 */
export async function runSettingsInstall(
  ctx: Ctx,
  ns: string,
  schema: unknown,
  entry: object,
  hooks: { setSource: (source: () => unknown) => void; onChange: () => void; validate?: unknown },
  loader: SettingsDepsLoader = loadSettingsDeps,
): Promise<SettingsInstallStrategy> {
  let deps: SettingsDeps | null = null
  try {
    deps = await loader()
  } catch {
    /* 装载失败按缺失处理 */
  }
  if (!deps) {
    console.warn('[dsh-vscode-mode] 设置依赖不可用，section ' + ns + ' 未安装（配置回退）')
    return recordInstall('none', INSTALL_NONE)
  }
  const legacy = deps.installSettingsSection
  if (typeof legacy === 'function') {
    try {
      legacy(ctx, ns, schema, entry, hooks)
      return recordInstall('legacy', INSTALL_LEGACY)
    } catch (error) {
      console.warn('[dsh-vscode-mode] legacy 设置安装失败，尝试服务路由：' + String(error))
    }
  }
  const ctxInject = (ctx as unknown as { inject?: (services: string[], callback: (sctx: unknown) => void) => unknown }).inject
  if (typeof ctxInject !== 'function') return recordInstall('none', INSTALL_NONE)
  try {
    ctxInject(['settings'], (sctx: unknown) => {
      const sc = sctx as { get?: (name: string) => unknown; settings?: unknown }
      const provider = typeof sc.get === 'function' ? sc.get('settings') : sc.settings
      const install = (provider as { installSection?: unknown } | undefined)?.installSection
      if (typeof install !== 'function') {
        console.warn('[dsh-vscode-mode] settings 服务无 installSection（DSH 版本 API 变化），section ' + ns + ' 降级为配置值')
        recordInstall('none', INSTALL_NONE)
        return
      }
      try {
        install.call(provider, ctx, ns, schema, entry, hooks)
        recordInstall('service', INSTALL_SERVICE)
      } catch (error) {
        console.warn('[dsh-vscode-mode] settings.installSection 安装失败（' + String(error) + '），section ' + ns + ' 降级为配置值')
        recordInstall('none', INSTALL_NONE)
      }
    })
  } catch (error) {
    console.warn('[dsh-vscode-mode] settings 服务路由不可用（' + String(error) + '）')
    return recordInstall('none', INSTALL_NONE)
  }
  // inject 回调若同步执行（settings 已就绪）会覆写观测值；仍未执行（unknown）时乐观按 service 记录
  if (observedInstall.strategy !== 'unknown') return observedInstall.strategy
  return recordInstall('service', '已调度 settings 服务 installSection（等待 settings 就绪）')
}

/**
 * 按命令目录构建 keybindings 显式键形状（每键独立默认值）。
 * @author ddj 2026年08月26号
 * @param z schemastery 命名空间
 * @returns keybindings 字段形状
 */
function keybindingsShape(z: SettingsDeps['z']): Record<string, unknown> {
  const shape: Record<string, unknown> = {}
  for (const [id, chord] of Object.entries(KEYBINDING_DEFAULTS)) shape[id] = z.string().default(chord)
  return shape
}

function normalizeValue(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return FILE_OPEN_DEFAULT
  return value.trim()
}

function configValue(config: unknown): string {
  return normalizeValue((config as { fileOpenTool?: unknown } | undefined)?.fileOpenTool)
}

/**
 * 安装设置 section（版本自适应；任一策略不可用返回 false 不抛错）。
 * @author ddj 2026年08月24号 / 2026年09月02号
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
  let deps: SettingsDeps | null = null
  try {
    deps = await loader()
  } catch {
    /* 装载失败按缺失处理 */
  }
  if (!deps) return false
  const schema = deps.z.object({
    fileOpenTool: deps.z.string().default(FILE_OPEN_DEFAULT),
    keybindings: deps.z.object(keybindingsShape(deps.z)).default({ ...KEYBINDING_DEFAULTS }),
    sidebarMinWidth: deps.z.number().default(300),
  })
  const strategy = await runSettingsInstall(ctx, ns, schema, entry, {
    setSource: (source) => hooks.setSource(source as () => FileOpenSettings),
    onChange: hooks.onChange,
  }, loader)
  return strategy === 'legacy' || strategy === 'service'
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
