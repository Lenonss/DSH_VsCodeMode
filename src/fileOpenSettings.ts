/**
 * dsh-vscode-mode host — 文件链接打开工具 + 快捷键的持久化设置。
 * 依赖守卫：schemastery 动态加载；@deepseek-ai/dsh-settings 仅作 legacy 探测——
 * rc 线导出 installSettingsSection free function，0.1.2-alpha 起移除（改由 settings
 * 服务的 installSection 方法承载），0.1.7 再移除 installSection（设置并入 profile
 * 插件 Config schema，见 runSettingsInstall 四策略：legacy/service/forms/none）。
 * 缺失/任一策略失败时插件仍可加载（fileOpenTool 降级为配置值，compat 报告可见），
 * 全程 try/catch，不产生未捕获 rejection。
 * 作者 ddj 2026年08月24号 / 2026年08月26号 / 2026年09月02号 / 2026年09月22号 / 2026年09月23号
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Ctx } from './store.js'
import { KEYBINDING_DEFAULTS } from './shared/keybindings.js'
import { EDITOR_LIMIT_DEFAULT } from './shared/editorLimit.js'
import { INTEGRATION_BASE_DEFAULT } from './shared/integration.js'
import { TORTOISE_DIR_DEFAULT } from './shared/svn.js'
import type { AiConfigPatch, AiConfigView } from './shared/ai.js'
import { DEFAULT_NATIVE_CSV } from './shared/nativeOpen.js'
import { log } from './log.js'

export const FILE_OPEN_SETTINGS_NS = 'dsh-vscode-mode'
export const FILE_OPEN_DEFAULT = 'auto'
export interface FileOpenSettings { fileOpenTool: string; integrationBaseUrl: string; svnPath: string; tortoisePath: string }
export interface FileOpenSettingsState { value: string; revision?: number; update: (value: string, expectedRevision?: number) => Promise<void> }

/** AI 配置默认值（补全默认关；路由空 = 自动；档位空 = 跟随模型默认；任务模型空 = 跟随补全配置）。 */
export const AI_CONFIG_DEFAULT: { enabled: boolean; provider: string; model: string; effort: string; taskProvider: string; taskModel: string; taskEffort: string } = {
  enabled: false,
  provider: '',
  model: '',
  effort: '',
  taskProvider: '',
  taskModel: '',
  taskEffort: '',
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
export type SettingsInstallStrategy = 'legacy' | 'service' | 'forms' | 'none' | 'unknown'

const INSTALL_UNMOUNTED = '设置 section 尚未装配'
const INSTALL_LEGACY = 'rc 线：dsh-settings.installSettingsSection'
const INSTALL_SERVICE = '0.1.2-alpha 线：settings 服务 installSection'
const INSTALL_FORMS = '0.1.7 线：设置并入插件 Config schema（SettingsForms）'
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
 * 判定设置写冲突错误（0.1.7 SettingsConflictError：code 常量 / 构造器名双通道）。
 * @author ddj 2026年09月22号
 * @param error 捕获到的错误
 * @returns 是否为 revision 冲突
 */
function isConflictError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { code?: unknown; name?: unknown }
  return e.code === 'SETTINGS_CONFLICT' || e.name === 'SettingsConflictError'
}

/**
 * 0.1.7 forms 策略：订阅 settings/document-updated 事件，目标 namespace 变化时
 * 把 describe 最新值推给 hooks（setSource + onChange），替代旧 installSection 的
 * 变更回调；disposer 经 ctx.effect 随插件 fiber 卸载（热重载不泄漏）。
 * @author ddj 2026年09月22号
 * @param ctx DSH host 上下文
 * @param provider settings 服务（SettingsForms）
 * @param ns 目标设置命名空间
 * @param hooks 设置源绑定与变更回调
 */
function watchDocUpdates(ctx: Ctx, provider: SettingsProvider, ns: string, hooks: { setSource: (source: () => unknown) => void; onChange: () => void }): void {
  try {
    const bus = ctx as { on?: (name: string, handler: (updatedNs: unknown, revision: unknown) => void) => unknown; effect?: (fn: () => unknown) => unknown }
    if (typeof bus.on !== 'function') return
    const off = bus.on('settings/document-updated', (updatedNs: unknown) => {
      if (updatedNs !== ns) return
      hooks.setSource(() => readSectionValue(provider, ns))
      hooks.onChange()
    })
    if (typeof bus.effect === 'function' && typeof off === 'function') bus.effect(() => off)
  } catch (error) {
    log.warn('settings/document-updated 订阅失败：' + String(error))
  }
}

/**
 * 设置 section 版本自适应安装（核心策略分派）。
 * legacy：dsh-settings 仍导出 installSettingsSection（rc 线）→ 原样调用，行为与旧版一致。
 * service：该导出已移除（0.1.2-alpha 起）→ 经 ctx.inject(['settings']) 走服务方法
 *          provider.installSection(owner, ns, schema, entry, hooks)（等义封装，含
 *          base 层与 fiber 卸载回退）。
 * forms：0.1.7 起 installSection 移除，设置并入 profile 插件 Config（SettingsForms
 *          的 describe+update 在场即成立）→ 不装 section，改订阅 document-updated。
 * none：两条路由都不存在 → 仅记录并告警，调用方按配置值运行。
 * 全程不抛错、不产生未捕获 rejection。
 * @author ddj 2026年09月02号（2026年09月22号 增补 forms 策略）
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
        // 0.1.7：installSection 已移除；SettingsForms（describe+update）在场走 forms 策略
        const forms = provider as SettingsProvider | undefined
        if (typeof forms?.describe === 'function' && typeof forms?.update === 'function') {
          recordInstall('forms', INSTALL_FORMS)
          watchDocUpdates(ctx, forms, ns, hooks)
          return
        }
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

/**
 * 设置节 describe 项的形状校验：value 须为普通对象。
 * ns 在两代语义不同（旧=自装 section 名，0.1.7=profile entry id），同名撞车时
 * 以形状兜底防误命中非设置数据；0.1.7 下本插件 entry 的 Config 值与旧 section
 * 值同为设置键对象，两形状天然兼容。
 * @author ddj 2026年09月22号
 * @param value describe 项的 value 字段
 * @returns 是否具备设置节形状
 */
function isSectionShaped(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** describe 项最小形状（读写工具共用）。 */
export interface SectionDescriptor { ns?: string; value?: unknown; revision?: number }

/**
 * 按 ns + 形状校验查找设置节（host 读路径统一入口）。
 * @author ddj 2026年09月22号
 * @param provider settings 服务（可空）
 * @param ns 设置命名空间
 * @returns 命中的 describe 项；未命中返回 undefined
 */
export function sectionOf(provider: SettingsProvider | undefined, ns: string): SectionDescriptor | undefined {
  const items = provider?.describe?.({ redactSecrets: true })
  if (!items) return undefined
  return items.find((item) => item.ns === ns && isSectionShaped(item.value))
}

/** 读设置节存储值（未就绪/形状不符返回 undefined）。 */
function readSectionValue(provider: SettingsProvider | undefined, ns: string): unknown {
  return sectionOf(provider, ns)?.value
}

/** 设置写入结果（ok=false 时带原因；conflict=true 表示经冲突重试后成功）。 */
export interface SectionWriteResult { ok: boolean; conflict?: boolean; error?: string }

/**
 * 带冲突自愈的设置写入：0.1.7 SettingsConflictError（revision 拒写）时重读
 * revision 重试一次；其余错误与服务缺失一律结构化返回，绝不抛未捕获异常。
 * @author ddj 2026年09月22号
 * @param provider settings 服务（可空）
 * @param ns 设置命名空间
 * @param patch 写入字段
 * @param expectedRevision 读侧携带的 revision（缺省用 describe 最新值）
 * @returns 写入结果
 */
export async function updateSection(provider: SettingsProvider | undefined, ns: string, patch: object, expectedRevision?: number): Promise<SectionWriteResult> {
  if (!provider?.update) return { ok: false, error: 'settings 服务无 update' }
  const first = expectedRevision ?? sectionOf(provider, ns)?.revision
  try {
    await provider.update(ns, patch, first)
    return { ok: true }
  } catch (error) {
    if (!isConflictError(error)) return { ok: false, error: String(error) }
  }
  const fresh = sectionOf(provider, ns)?.revision
  try {
    await provider.update(ns, patch, fresh)
    return { ok: true, conflict: true }
  } catch (error) {
    return { ok: false, conflict: true, error: String(error) }
  }
}

/**
 * 构建设置 section schema（install 路径与插件 Config 声明共用，保证两代形状同源）。
 * 字段集 = fileOpenTool/keybindings/sidebarMinWidth/maxOpenEditors/integrationBaseUrl/
 * aiInline/aiProvider/aiModel/aiEffort/svnPath/tortoisePath/nativeOpenExts，全部带默认值
 * （Config 启动校验在 undefined/空配置下自动填充，rc/alpha 两代 cordis 均通过）。
 * options.volatile：DSH 0.1.7 线的 Config 导出专用——SettingsForms.describe 只下发
 * 含 volatile 字段的 entry（volatileForm 门槛），不标记则 ns 永不出现在 describe、
 * client configForms 恒 unavailable；且字段须位于固定 object 路径（keybindings 整个
 * object 标记、子键不标）。section 安装路径（legacy/service）**不标**：rc/0.1.6 的
 * register→resolve 无该门槛，标了反而让 scope.get() 返回引用污染读取。
 * 标记经 markVolatile 能力守卫：z 无 .volatile()（旧 schemastery）或调用抛错时保持
 * 原字段并记录观测态，模块加载绝不抛错（降级=维持现状，兼容性报告可见）。
 * @author ddj 2026年09月22号（2026年09月23号 增补 options.volatile 与观测）
 * @param z schemastery 命名空间（静态 import 或动态加载均可）
 * @param options volatile：是否按 0.1.7 Config 语义标记字段
 * @returns schemastery object schema
 */
export function buildSettingsSchema(z: SettingsDeps['z'], options?: { volatile?: boolean }): unknown {
  const wantVolatile = options?.volatile === true
  let marked = 0
  const withVol = (field: unknown): unknown => {
    if (!wantVolatile) return field
    const result = markVolatile(field)
    if (result.marked) marked += 1
    return result.field
  }
  const shape: Record<string, unknown> = {
    fileOpenTool: withVol(z.string().default(FILE_OPEN_DEFAULT)),
    keybindings: withVol(z.object(keybindingsShape(z)).default({ ...KEYBINDING_DEFAULTS })),
    sidebarMinWidth: withVol(z.number().default(300)),
    // 页签数量上限（0 = 不限制；超限时淘汰最久未使用的页签，固定页签除外）
    maxOpenEditors: withVol(z.number().default(EDITOR_LIMIT_DEFAULT)),
    integrationBaseUrl: withVol(z.string().default(INTEGRATION_BASE_DEFAULT)),
    // AI 内联补全（默认关；provider/model 空 = 自动路由；effort 空 = 跟随模型默认）
    aiInline: withVol(z.boolean().default(AI_CONFIG_DEFAULT.enabled)),
    aiProvider: withVol(z.string().default(AI_CONFIG_DEFAULT.provider)),
    aiModel: withVol(z.string().default(AI_CONFIG_DEFAULT.model)),
    aiEffort: withVol(z.string().default(AI_CONFIG_DEFAULT.effort)),
    // AI 任务模型（非补全场景如 AI 智能整理；空 = 跟随补全配置）
    aiTaskProvider: withVol(z.string().default(AI_CONFIG_DEFAULT.taskProvider)),
    aiTaskModel: withVol(z.string().default(AI_CONFIG_DEFAULT.taskModel)),
    aiTaskEffort: withVol(z.string().default(AI_CONFIG_DEFAULT.taskEffort)),
    // SVN 能力：svn CLI 覆盖（空 = PATH）与 TortoiseSVN 目录（Windows 过渡增强）
    svnPath: withVol(z.string().default('')),
    tortoisePath: withVol(z.string().default(TORTOISE_DIR_DEFAULT)),
    // 原生打开范围（逗号分隔后缀；默认 = 让位清单并集，csv/tsv 决策见 shared/nativeOpen.ts）
    nativeOpenExts: withVol(z.string().default(DEFAULT_NATIVE_CSV)),
  }
  if (wantVolatile) configVolatile = { requested: true, marked, total: Object.keys(shape).length }
  return z.object(shape)
}

/** Config volatile 标记观测（构建期记录；兼容报告读取，测试可复位）。 */
export interface ConfigVolatileState { requested: boolean; marked: number; total: number }

let configVolatile: ConfigVolatileState = { requested: false, marked: 0, total: 0 }

/**
 * 读取 Config volatile 标记观测（0.1.7 设置页可用性的构建期判据）。
 * @author ddj 2026年09月23号
 * @returns 观测态（requested=是否按 Config 语义构建；marked/total=成功标记字段数）
 */
export function configVolatileState(): ConfigVolatileState {
  return configVolatile
}

/**
 * 复位 volatile 标记观测（测试隔离用）。
 * @author ddj 2026年09月23号
 */
export function resetConfigVolatileState(): void {
  configVolatile = { requested: false, marked: 0, total: 0 }
}

/**
 * 为已完成 default 链的 schema 字段追加 volatile 标记（能力守卫）。
 * @author ddj 2026年09月23号
 * @param field schema 字段（两代 schemastery 兼容面，可能没有 volatile 方法）
 * @returns 处理后字段与是否成功标记
 */
function markVolatile(field: unknown): { field: unknown; marked: boolean } {
  const target = field as { volatile?: () => unknown } | null | undefined
  if (!target || typeof target.volatile !== 'function') return { field, marked: false }
  try {
    return { field: target.volatile(), marked: true }
  } catch {
    return { field, marked: false }
  }
}

/** cosmokit volatile 引用写协议符号（Symbol.for 跨拷贝一致，同 cosmokit.isVolatile 判据）。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * 解引用 0.1.7 volatile 配置引用（普通值直传）。
 * cordis resolveConfig 会把 .volatile() 字段解析成稳定引用，直接读会得到引用对象；
 * 不解引用则配置回退值全部落入默认值分支。
 * @author ddj 2026年09月23号
 * @param value 配置字段原始值
 * @returns 引用的当前快照，或原值
 */
export function unref(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && VOLATILE_WRITE in (value as object)) {
    return (value as { get: () => unknown }).get()
  }
  return value
}

/**
 * 读插件组合配置字段并解引用（配置读取唯一入口）。
 * @author ddj 2026年09月23号
 * @param config 插件组合配置（apply 收到的 Config 值）
 * @param key 字段名
 * @returns 字段值（引用已解包；缺失为 undefined）
 */
export function configField(config: unknown, key: string): unknown {
  return unref((config as Record<string, unknown> | null | undefined)?.[key])
}

function normalizeValue(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return FILE_OPEN_DEFAULT
  return value.trim()
}

function configValue(config: unknown): string {
  return normalizeValue(configField(config, 'fileOpenTool'))
}

/** 配置/设置里的深链基址（缺省/非法回退默认值）。 */
function baseValueOf(config: unknown): string {
  const raw = configField(config, 'integrationBaseUrl')
  return typeof raw === 'string' && raw.trim() ? raw.trim() : INTEGRATION_BASE_DEFAULT
}

/** 配置/设置里的 svn CLI 覆盖（空 = 从 PATH 解析 'svn'）。 */
function svnPathValueOf(config: unknown): string {
  const raw = configField(config, 'svnPath')
  return typeof raw === 'string' ? raw.trim() : ''
}

/** 配置/设置里的 TortoiseSVN 目录（空 = 默认安装目录）。 */
function tortoiseDirValueOf(config: unknown): string {
  const raw = configField(config, 'tortoisePath')
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
  const schema = buildSettingsSchema(deps.z)
  const strategy = await runSettingsInstall(ctx, ns, schema, entry, {
    setSource: (source) => hooks.setSource(source as () => FileOpenSettings),
    onChange: hooks.onChange,
  }, loader)
  return strategy === 'legacy' || strategy === 'service' || strategy === 'forms'
}

/** AI 配置脏值读取（settings 未就绪时回退默认）。 */
function aiValueOf(stored: unknown): { enabled: boolean; provider: string; model: string; effort: string; taskProvider: string; taskModel: string; taskEffort: string } {
  const raw = (stored ?? {}) as Record<string, unknown>
  return {
    enabled: raw.aiInline === true,
    provider: typeof raw.aiProvider === 'string' ? raw.aiProvider : AI_CONFIG_DEFAULT.provider,
    model: typeof raw.aiModel === 'string' ? raw.aiModel : AI_CONFIG_DEFAULT.model,
    effort: typeof raw.aiEffort === 'string' ? raw.aiEffort : AI_CONFIG_DEFAULT.effort,
    taskProvider: typeof raw.aiTaskProvider === 'string' ? raw.aiTaskProvider : AI_CONFIG_DEFAULT.taskProvider,
    taskModel: typeof raw.aiTaskModel === 'string' ? raw.aiTaskModel : AI_CONFIG_DEFAULT.taskModel,
    taskEffort: typeof raw.aiTaskEffort === 'string' ? raw.aiTaskEffort : AI_CONFIG_DEFAULT.taskEffort,
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
    revision = sectionOf(provider, FILE_OPEN_SETTINGS_NS)?.revision
  }
  const setSource = (source: () => FileOpenSettings): void => notify(source().fileOpenTool)
  const settingsChange = (): void => syncRevision()

  /** AI 配置当前值（settings 未就绪回退默认）。 */
  let aiCurrent: AiConfigView = { ...AI_CONFIG_DEFAULT }
  const aiSync = (): void => {
    const stored = readSectionValue(provider, FILE_OPEN_SETTINGS_NS)
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
    return readSectionValue(provider, FILE_OPEN_SETTINGS_NS)
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
    // 初值直读：settings/document-updated 首事件可能先于本订阅建立，只靠事件会漏初值
    const stored = storedValue()
    const section = stored as { fileOpenTool?: unknown } | undefined
    if (section?.fileOpenTool !== undefined) notify(section.fileOpenTool)
    aiCurrent = stored !== undefined ? aiValueOf(stored) : aiCurrent
    svnSync(stored)
    syncRevision()
  })

  return {
    get value() { return current },
    get revision() { return revision },
    update: async (value: string, expectedRevision?: number): Promise<void> => {
      const next = normalizeValue(value)
      const result = await updateSection(provider, FILE_OPEN_SETTINGS_NS, { fileOpenTool: next }, expectedRevision)
      if (!result.ok) log.warn('fileOpenTool 设置写入失败：' + (result.error ?? '未知原因'))
      const stored = readSectionValue(provider, FILE_OPEN_SETTINGS_NS) as { fileOpenTool?: unknown } | undefined
      notify(stored?.fileOpenTool ?? next)
      syncRevision()
    },
    ai: () => aiCurrent,
    svn: () => svnCurrent,
    aiUpdate: async (patch: AiConfigPatch, expectedRevision?: number): Promise<AiConfigView> => {
      const stored = { ...aiCurrent }
      const body: Record<string, unknown> = {}
      if (patch.enabled !== undefined) { stored.enabled = patch.enabled; body.aiInline = patch.enabled }
      if (patch.provider !== undefined) { stored.provider = patch.provider; body.aiProvider = patch.provider }
      if (patch.model !== undefined) { stored.model = patch.model; body.aiModel = patch.model }
      if (patch.effort !== undefined) { stored.effort = patch.effort; body.aiEffort = patch.effort }
      if (patch.taskProvider !== undefined) { stored.taskProvider = patch.taskProvider; body.aiTaskProvider = patch.taskProvider }
      if (patch.taskModel !== undefined) { stored.taskModel = patch.taskModel; body.aiTaskModel = patch.taskModel }
      if (patch.taskEffort !== undefined) { stored.taskEffort = patch.taskEffort; body.aiTaskEffort = patch.taskEffort }
      const result = await updateSection(provider, FILE_OPEN_SETTINGS_NS, body, expectedRevision)
      if (!result.ok) {
        // settings 不可用/写入失败：内存态生效（重启回落默认），与 fileOpenTool 降级语义一致
        aiCurrent = stored
        return aiCurrent
      }
      aiSync()
      return aiCurrent
    },
  }
}

export function normalizeFileOpenTool(value: unknown): string { return normalizeValue(value) }
