/**
 * dsh-vscode-mode host — 文件链接打开工具 + 快捷键的持久化设置。
 * 依赖守卫：schemastery 动态加载；@deepseek-ai/dsh-settings 仅作 legacy 探测——
 * rc 线导出 installSettingsSection free function，0.1.2-alpha 起移除（改由 settings
 * 服务的 installSection 方法承载，见 runSettingsInstall 三策略）。
 * 缺失/任一策略失败时插件仍可加载（fileOpenTool 降级为配置值，compat 报告可见），
 * 全程 try/catch，不产生未捕获 rejection。
 * 作者 ddj 2026年08月24号 / 2026年08月26号 / 2026年09月02号
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Ctx } from './store.js'
import { KEYBINDING_DEFAULTS } from './shared/keybindings.js'
import { INTEGRATION_BASE_DEFAULT } from './shared/integration.js'
import { TORTOISE_DIR_DEFAULT } from './shared/svn.js'
import type { AiConfigPatch, AiConfigView } from './shared/ai.js'
import { log } from './log.js'

export const FILE_OPEN_SETTINGS_NS = 'dsh-vscode-mode'
export const FILE_OPEN_DEFAULT = 'auto'
export interface FileOpenSettings { fileOpenTool: string; integrationBaseUrl: string; svnPath: string; tortoisePath: string }
export interface FileOpenSettingsState { value: string; revision?: number; update: (value: string, expectedRevision?: number) => Promise<void> }

/** AI 内联补全配置默认值（默认关闭；路由空 = 自动；档位空 = 跟随模型默认）。 */
export const AI_CONFIG_DEFAULT: { enabled: boolean; provider: string; model: string; effort: string } = {
  enabled: false,
  provider: '',
  model: '',
  effort: '',
}

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
 * 宿主锚点动态导入：先经 process.argv[1]（DSH 启动脚本所在树）解析并加载目标包，
 * 避开本插件自身 node_modules 的 dev 依赖副本（dev-link 下 import() 相对插件位置
 * 解析，会命中 rc 线旧包 dsh-settings@0.1.0-rc.8）；argv[1] 缺失或解析失败回退
 * 普通 specifier import。
 * @author ddj 2026年09月15号
 * @param specifier 包名
 * @returns 加载的模块命名空间
 */
async function hostImport(specifier: string): Promise<unknown> {
  const entry = process.argv[1]
  if (entry) {
    try {
      const resolved = createRequire(entry).resolve(specifier)
      return await import(pathToFileURL(resolved).href)
    } catch {
      /* 锚点不可用：回退普通 import */
    }
  }
  return import(specifier)
}

/**
 * schema 库候选名（新名在前）。
 * DSH 官方自 0.1.5 起把 vendored 包改名为 @deepseek-ai/schemastery 并全树改用新名，
 * 安装树里**没有**裸 schemastery；裸名保留给 rc 线（其 dsh-settings 仍 peers 旧名），
 * 也让开发形态（插件 node_modules 有 devDependency 副本）继续可用。
 */
const SCHEMA_SPECIFIERS = ['@deepseek-ai/schemastery', 'schemastery'] as const

/** 设置持久化包名（installSettingsSection 仅 rc 线提供，alpha 线缺失属正常）。 */
const SETTINGS_SPECIFIER = '@deepseek-ai/dsh-settings'

/**
 * 逐个尝试候选名，返回首个加载成功的模块及其包名（全失败返回 null，不抛错）。
 * @author ddj 2026年09月18号
 * @param specifiers 候选包名（按优先级）
 * @param importFn 加载函数（测试注入）
 * @returns 命中的模块与包名；全失败返回 null
 */
async function firstImport(
  specifiers: readonly string[],
  importFn: (specifier: string) => Promise<unknown> = hostImport,
): Promise<{ specifier: string; module: unknown } | null> {
  for (const specifier of specifiers) {
    try {
      return { specifier, module: await importFn(specifier) }
    } catch {
      /* 该候选不可解析：尝试下一个 */
    }
  }
  return null
}

/**
 * 抹平 schema 库的 ESM/CJS 互操作形态取默认导出。
 * 三种实测形态：真 ESM（`default` 即 z）、CJS 经 import()（`default` 与
 * `module.exports` 同为 z）、双层包装（`default.default` 才是 z）。
 * @author ddj 2026年09月18号
 * @param module 加载到的模块命名空间（可空）
 * @returns 具备 object/string 等构造器的 z；取不到返回 null
 */
export function pickSchema(module: unknown): SettingsDeps['z'] | null {
  const layers = [module, (module as { default?: unknown } | null)?.default, (module as Record<string, unknown> | null)?.['module.exports']]
  for (const layer of layers) {
    const z = ((layer as { default?: unknown } | null)?.default ?? layer) as SettingsDeps['z'] | undefined
    if (z && typeof z.object === 'function' && typeof z.string === 'function') return z
  }
  return null
}

/** 实际命中的 schema 库名（供兼容性报告展示；未命中为空串）。 */
let schemaLib = ''

/**
 * 读取实际命中的 schema 库名（报告文案用）。
 * @author ddj 2026年09月18号
 * @returns 包名；未解析到为空串
 */
export function schemaLibName(): string {
  return schemaLib
}

/** 复位依赖缓存与命中库名（测试隔离用）。 */
export function resetSettingsDeps(): void {
  depsPromise = undefined
  schemaLib = ''
}

/**
 * 动态加载设置依赖（模块级缓存；schema 库缺失返回 null 而非抛错）。
 * ⚠️ 两个依赖**独立解析**：@deepseek-ai/dsh-settings 仅 rc 线跑 legacy 策略时需要，
 * alpha 线走 settings 服务 installSection 用不到它；原先 Promise.all 让该包缺失
 * 拖垮整体 → 用户端（npm 安装）settings section 永不装配。
 * 同理，schema 库按候选链解析（安装树只有新名 @deepseek-ai/schemastery）。
 * @author ddj 2026年08月24号 / 2026年09月15号 / 2026年09月18号
 * @param importFn 加载函数（测试注入；缺省宿主锚点动态导入）
 * @returns 设置依赖或 null
 */
export function loadSettingsDeps(importFn: (specifier: string) => Promise<unknown> = hostImport): Promise<SettingsDeps | null> {
  if (!depsPromise) {
    depsPromise = Promise.all([firstImport([SETTINGS_SPECIFIER], importFn), firstImport(SCHEMA_SPECIFIERS, importFn)])
      .then(([settingsHit, schemaHit]) => {
        const z = pickSchema(schemaHit?.module)
        if (!z) {
          schemaLib = ''
          return null
        }
        schemaLib = schemaHit?.specifier ?? ''
        // dsh-settings 类型声明随版本变化（rc.8 有 d.ts、alpha 已移除导出），统一经 unknown 松绑
        const installSettingsSection = (settingsHit?.module as unknown as { installSettingsSection?: SettingsDeps['installSettingsSection'] } | undefined)?.installSettingsSection
        return { installSettingsSection, z }
      })
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
    log.warn('设置依赖不可用，section ' + ns + ' 未安装（配置回退）')
    return recordInstall('none', INSTALL_NONE)
  }
  const legacy = deps.installSettingsSection
  if (typeof legacy === 'function') {
    try {
      legacy(ctx, ns, schema, entry, hooks)
      return recordInstall('legacy', INSTALL_LEGACY)
    } catch (error) {
      log.warn('legacy 设置安装失败，尝试服务路由：' + String(error))
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
        log.warn('settings 服务无 installSection（DSH 版本 API 变化），section ' + ns + ' 降级为配置值')
        recordInstall('none', INSTALL_NONE)
        return
      }
      try {
        install.call(provider, ctx, ns, schema, entry, hooks)
        recordInstall('service', INSTALL_SERVICE)
      } catch (error) {
        log.warn('settings.installSection 安装失败（' + String(error) + '），section ' + ns + ' 降级为配置值')
        recordInstall('none', INSTALL_NONE)
      }
    })
  } catch (error) {
    log.warn('settings 服务路由不可用（' + String(error) + '）')
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

/** 配置/设置里的深链基址（缺省/非法回退默认值）。 */
function baseValueOf(config: unknown): string {
  const raw = (config as { integrationBaseUrl?: unknown } | undefined)?.integrationBaseUrl
  return typeof raw === 'string' && raw.trim() ? raw.trim() : INTEGRATION_BASE_DEFAULT
}

/** 配置/设置里的 svn CLI 覆盖（空 = 从 PATH 解析 'svn'）。 */
function svnPathValueOf(config: unknown): string {
  const raw = (config as { svnPath?: unknown } | undefined)?.svnPath
  return typeof raw === 'string' ? raw.trim() : ''
}

/** 配置/设置里的 TortoiseSVN 目录（空 = 默认安装目录）。 */
function tortoiseDirValueOf(config: unknown): string {
  const raw = (config as { tortoisePath?: unknown } | undefined)?.tortoisePath
  return typeof raw === 'string' && raw.trim() ? raw.trim() : TORTOISE_DIR_DEFAULT
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
    integrationBaseUrl: deps.z.string().default(INTEGRATION_BASE_DEFAULT),
    // AI 内联补全（默认关；provider/model 空 = 自动路由；effort 空 = 跟随模型默认）
    aiInline: deps.z.boolean().default(AI_CONFIG_DEFAULT.enabled),
    aiProvider: deps.z.string().default(AI_CONFIG_DEFAULT.provider),
    aiModel: deps.z.string().default(AI_CONFIG_DEFAULT.model),
    aiEffort: deps.z.string().default(AI_CONFIG_DEFAULT.effort),
    // SVN 能力：svn CLI 覆盖（空 = PATH）与 TortoiseSVN 目录（Windows 过渡增强）
    svnPath: deps.z.string().default(''),
    tortoisePath: deps.z.string().default(TORTOISE_DIR_DEFAULT),
  })
  const strategy = await runSettingsInstall(ctx, ns, schema, entry, {
    setSource: (source) => hooks.setSource(source as () => FileOpenSettings),
    onChange: hooks.onChange,
  }, loader)
  return strategy === 'legacy' || strategy === 'service'
}

/** AI 配置脏值读取（settings 未就绪时回退默认）。 */
function aiValueOf(stored: unknown): { enabled: boolean; provider: string; model: string; effort: string } {
  const raw = (stored ?? {}) as Record<string, unknown>
  return {
    enabled: raw.aiInline === true,
    provider: typeof raw.aiProvider === 'string' ? raw.aiProvider : AI_CONFIG_DEFAULT.provider,
    model: typeof raw.aiModel === 'string' ? raw.aiModel : AI_CONFIG_DEFAULT.model,
    effort: typeof raw.aiEffort === 'string' ? raw.aiEffort : AI_CONFIG_DEFAULT.effort,
  }
}

/**
 * 注册设置命名空间，并提供 host 侧的读取与更新状态。
 * @author ddj 2026年08月24号
 * @param ctx DSH host 上下文
 * @param config 插件组合配置
 * @param onChange 设置变化回调
 * @returns 设置状态（fileOpenTool 值 + AI 补全配置读写）
 */
export function setupOpenSettings(ctx: Ctx, config: unknown, onChange: (value: string) => void): FileOpenSettingsState & { ai: () => AiConfigView; aiUpdate: (patch: AiConfigPatch, expectedRevision?: number) => Promise<AiConfigView>; svn: () => { svnPath: string; tortoisePath: string } } {
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

  /** AI 配置当前值（settings 未就绪回退默认）。 */
  let aiCurrent: AiConfigView = { ...AI_CONFIG_DEFAULT }
  const aiSync = (): void => {
    const descriptor = provider?.describe?.({ redactSecrets: true })?.find((item: { ns?: string }) => item.ns === FILE_OPEN_SETTINGS_NS)
    const stored = descriptor?.value
    aiCurrent = stored !== undefined ? aiValueOf(stored) : aiCurrent
  }

  /** SVN 路径当前值（settings 未就绪回退配置值）。 */
  let svnCurrent: { svnPath: string; tortoisePath: string } = {
    svnPath: svnPathValueOf(config),
    tortoisePath: tortoiseDirValueOf(config),
  }
  const svnSync = (stored: unknown): void => {
    svnCurrent = { svnPath: svnPathValueOf(stored), tortoisePath: tortoiseDirValueOf(stored) }
  }
  /** 读取 settings 存储值（describe 未就绪返回 undefined）。 */
  const storedValue = (): unknown => {
    return provider?.describe?.({ redactSecrets: true })?.find((item: { ns?: string }) => item.ns === FILE_OPEN_SETTINGS_NS)?.value
  }

  void installOpenSettingsSection(ctx, FILE_OPEN_SETTINGS_NS, {
    fileOpenTool: current,
    integrationBaseUrl: baseValueOf(config),
    svnPath: svnCurrent.svnPath,
    tortoisePath: svnCurrent.tortoisePath,
  }, {
    setSource: (source) => {
      notify(source().fileOpenTool)
      aiCurrent = aiValueOf(source())
      svnSync(source())
      syncRevision()
    },
    onChange: settingsChange,
  })
  ctx.inject?.(['settings'], (settingsCtx: Ctx) => {
    provider = settingsCtx.get('settings')
    aiSync()
    svnSync(storedValue())
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
    ai: () => aiCurrent,
    svn: () => svnCurrent,
    aiUpdate: async (patch: AiConfigPatch, expectedRevision?: number): Promise<AiConfigView> => {
      if (!provider?.update) {
        // settings 不可用：内存态生效（重启回落默认），保持与 fileOpenTool 的降级语义一致
        if (patch.enabled !== undefined) aiCurrent.enabled = patch.enabled
        if (patch.provider !== undefined) aiCurrent.provider = patch.provider
        if (patch.model !== undefined) aiCurrent.model = patch.model
        if (patch.effort !== undefined) aiCurrent.effort = patch.effort
        return aiCurrent
      }
      const stored = { ...aiCurrent }
      const body: Record<string, unknown> = {}
      if (patch.enabled !== undefined) { stored.enabled = patch.enabled; body.aiInline = patch.enabled }
      if (patch.provider !== undefined) { stored.provider = patch.provider; body.aiProvider = patch.provider }
      if (patch.model !== undefined) { stored.model = patch.model; body.aiModel = patch.model }
      if (patch.effort !== undefined) { stored.effort = patch.effort; body.aiEffort = patch.effort }
      await provider.update(FILE_OPEN_SETTINGS_NS, body, expectedRevision)
      aiSync()
      return aiCurrent
    },
  }
}

export function normalizeFileOpenTool(value: unknown): string { return normalizeValue(value) }
