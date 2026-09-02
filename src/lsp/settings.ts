/**
 * dsh-vscode-mode host — LSP 配置设置 section 安装（版本自适应；缺失/失败不抛错）。
 * ns：dsh-vscode-mode.languageServers；每语言 { enabled, command, path }。
 * 安装策略分派见 fileOpenSettings.runSettingsInstall（rc 线 legacy / alpha 线服务方法）。
 * 作者 ddj 2026-08-27 / 2026-09-02
 */
import type { Ctx } from '../store.js'
import { LSP_LANGUAGES, LSP_SETTINGS_NS, type LspConfig } from './config.js'
import { loadSettingsDeps, runSettingsInstall, type SettingsDeps } from '../fileOpenSettings.js'

/**
 * 安装 LSP 设置 section。
 * @author ddj 2026年08月27号
 * @param ctx DSH 上下文
 * @param entry 初始配置
 * @returns 是否成功安装
 */
export async function installLspSettingsSection(ctx: Ctx, entry: LspConfig): Promise<boolean> {
  let deps: SettingsDeps | null = null
  try {
    deps = await loadSettingsDeps()
  } catch {
    /* 装载失败按缺失处理 */
  }
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
    const strategy = await runSettingsInstall(ctx, LSP_SETTINGS_NS, schema, entry, {
      setSource: () => {},
      onChange: () => {},
    })
    return strategy === 'legacy' || strategy === 'service'
  } catch (error) {
    // 设置 section 安装失败不致命：降级为无设置 UI，LSP 核心功能不受影响
    console.error('[dsh-vscode-mode] LSP 设置 section 安装失败：' + String(error))
    return false
  }
}

export type { SettingsDeps }
