/**
 * dsh-vscode-mode host — LSP 配置设置 section 安装（动态依赖，缺失不抛错）。
 * ns：dsh-vscode-mode.languageServers；每语言 { enabled, command, path }。
 * 作者 ddj 2026-08-27
 */
import type { Ctx } from '../store.js'
import { LSP_LANGUAGES, LSP_SETTINGS_NS, type LspConfig } from './config.js'
import { loadSettingsDeps, type SettingsDeps } from '../fileOpenSettings.js'

/**
 * 安装 LSP 设置 section。
 * @author ddj 2026年08月27号
 * @param ctx DSH 上下文
 * @param entry 初始配置
 * @returns 是否成功安装
 */
export async function installLspSettingsSection(ctx: Ctx, entry: LspConfig): Promise<boolean> {
  const deps = await loadSettingsDeps()
  if (!deps) return false
  try {
    // schemastery 无 .optional()，对象字段默认即可选；.default 必给避免 undefined 覆盖
    const z = deps.z
    const langShape: Record<string, unknown> = {}
    for (const lang of LSP_LANGUAGES) {
      langShape[lang] = z.object({
        enabled: z.boolean(),
        command: z.string(),
        path: z.string(),
      }).default({})
    }
    const schema = z.object(langShape).default({})
    deps.installSettingsSection(ctx, LSP_SETTINGS_NS, schema, entry, {
      setSource: () => {},
      onChange: () => {},
    })
    return true
  } catch (error) {
    // 设置 section 安装失败不致命：降级为无设置 UI，LSP 核心功能不受影响
    console.error('[dsh-vscode-mode] LSP 设置 section 安装失败：' + String(error))
    return false
  }
}

export type { SettingsDeps }
