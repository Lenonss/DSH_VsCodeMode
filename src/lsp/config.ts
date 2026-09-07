/**
 * dsh-vscode-mode host — LSP 配置读取与 provider 解析装配。
 * 配置来源优先级：运行时覆盖（设置页保存，重启失效）> 插件组合配置 > 默认。
 * 原 settings section（ns dsh-vscode-mode.languageServers）命名空间不合法
 * （DSH settings 仅允许 /^[a-z][a-z0-9-]*$/，点号命名空间永久不可注册），
 * 已降级为配置值（插件组合配置 + 会话内运行时覆盖），不再尝试 settings 安装。
 * 作者 ddj 2026-08-27 / 2026-09-02
 */
import { PROVIDER_RESOLVERS, type LspProviderSpec } from './providers.js'
import { provisionRuntime } from './dotnetProvision.js'

/** 单语言配置。 */
export interface LspLangConfig {
  enabled?: boolean
  command?: string
  path?: string
}

/** LSP 配置（按语言）。 */
export interface LspConfig {
  lua?: LspLangConfig
  csharp?: LspLangConfig
  [languageId: string]: LspLangConfig | undefined
}

export const LSP_LANGUAGES = ['lua', 'csharp'] as const

/** 清洗单语言配置：仅保留合法字段并剥离 undefined（稀疏覆盖语义，清空字段即回落组合配置）。 */
export function sanitizeLang(raw: unknown): LspLangConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const out: LspLangConfig = {}
  if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled
  if (typeof obj.command === 'string') out.command = obj.command
  if (typeof obj.path === 'string') out.path = obj.path
  return out
}

/** 从插件组合配置读取。 */
export function configFromPlugin(config: unknown): LspConfig {
  const raw = (config as { languageServers?: unknown } | undefined)?.languageServers
  if (!raw || typeof raw !== 'object') return {}
  const out: LspConfig = {}
  for (const lang of LSP_LANGUAGES) {
    const v = sanitizeLang((raw as Record<string, unknown>)[lang])
    if (v) out[lang] = v
  }
  return out
}

/** 合并配置：上层（运行时覆盖/settings）覆盖插件组合配置。 */
export function mergeConfig(a: LspConfig, b: LspConfig): LspConfig {
  const out: LspConfig = { ...a }
  for (const lang of LSP_LANGUAGES) {
    const av = a[lang]
    const bv = b[lang]
    if (bv) out[lang] = { ...av, ...bv }
    else if (av) out[lang] = av
  }
  return out
}

/**
 * 解析某语言的 provider spec（插件组合配置 + 运行时覆盖层合并后）。
 * @author ddj 2026年08月27号 / 2026年09月02号
 * @param pluginConfig 插件组合配置
 * @param languageId 语言 id
 * @param override 运行时覆盖层（设置页保存值，重启失效；缺省为空）
 * @returns provider 规格
 */
export function resolveProviderSpec(pluginConfig: unknown, languageId: string, override?: LspConfig): LspProviderSpec {
  const resolver = PROVIDER_RESOLVERS[languageId]
  if (!resolver) return { languageId, kind: 'none', argv: [], ready: false, reason: '不支持的语言：' + languageId }
  const merged = mergeConfig(configFromPlugin(pluginConfig), override ?? {})
  const lang = merged[languageId]
  if (lang && lang.enabled === false) {
    return { languageId, kind: 'none', argv: [], ready: false, reason: '已在设置中禁用' }
  }
  const spec = resolver({ command: lang?.command, path: lang?.path })
  // DotRush 缺运行时：后台自动下载官方 .NET runtime（用户零操作），完成后经监听者重载
  if (spec.provisionRuntime) provisionRuntime(spec.provisionRuntime)
  return spec
}

/** 语言 → 扩展名（供客户端判断是否触发 LSP）。 */
export function langOfPath(path: string): string | null {
  const base = String(path || '').split(/[\\/]/).pop() || ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = base.slice(dot + 1).toLowerCase()
  for (const [lang, exts] of Object.entries({ lua: ['lua'], csharp: ['cs', 'csx'] })) {
    if (exts.includes(ext)) return lang
  }
  return null
}
