/**
 * dsh-vscode-mode host — LSP 配置读取与 provider 解析装配。
 * 配置来源优先级：settings 持久化（ns dsh-vscode-mode.languageServers）> 插件组合配置 > 默认。
 * 作者 ddj 2026-08-27
 */
import type { Ctx } from '../store.js'
import { PROVIDER_RESOLVERS, type LspProviderSpec } from './providers.js'

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

export const LSP_SETTINGS_NS = 'dsh-vscode-mode.languageServers'
export const LSP_LANGUAGES = ['lua', 'csharp'] as const

function sanitizeLang(raw: unknown): LspLangConfig | undefined {
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

/** 从 settings 描述符读取（无 settings 服务/无该 section → {}）。 */
export function configFromSettings(ctx: Ctx): LspConfig {
  try {
    const settings = ctx.get('settings')
    const descriptor = settings?.describe?.({ redactSecrets: true })?.find((item: { ns?: string }) => item.ns === LSP_SETTINGS_NS)
    const value = descriptor?.value
    if (!value || typeof value !== 'object') return {}
    const out: LspConfig = {}
    for (const lang of LSP_LANGUAGES) {
      const v = sanitizeLang((value as Record<string, unknown>)[lang])
      if (v) out[lang] = v
    }
    return out
  } catch (error) {
    return {}
  }
}

/** 合并配置：settings 覆盖插件配置。 */
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
 * 解析某语言的 provider spec（合并配置后）。
 * @author ddj 2026年08月27号
 * @param ctx DSH 上下文
 * @param pluginConfig 插件组合配置
 * @param languageId 语言 id
 * @returns provider 规格
 */
export function resolveProviderSpec(ctx: Ctx, pluginConfig: unknown, languageId: string): LspProviderSpec {
  const resolver = PROVIDER_RESOLVERS[languageId]
  if (!resolver) return { languageId, kind: 'none', argv: [], ready: false, reason: '不支持的语言：' + languageId }
  const merged = mergeConfig(configFromPlugin(pluginConfig), configFromSettings(ctx))
  const lang = merged[languageId]
  if (lang && lang.enabled === false) {
    return { languageId, kind: 'none', argv: [], ready: false, reason: '已在设置中禁用' }
  }
  return resolver({ command: lang?.command, path: lang?.path })
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
