/**
 * dsh-vscode-mode host — 兼容层：与其他插件 / DSH 版本的统一探测、适配、护栏与自诊断。
 * 职责：身份常量（包名 / MCP 条目前缀 / 路由前缀）、外部插件探测、路由冲突与重复装配检测、
 *       兼容性报告构建（RPC edrv.compat 与启动日志共用）。
 * 注意：与 mcp.ts 存在模块环（compat 提供身份常量、mcp 提供 entriesOf），
 *       双方仅在函数体内交叉使用导出，模块求值期无依赖，ESM 安全。
 * 作者 ddj 2026-08-24
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { entriesOf } from './mcp.js'
import { loadSettingsDeps } from './fileOpenSettings.js'
import { readDevForm } from './devForm.js'
import type { CompatAdapter, CompatReport } from './shared/compat.js'
import type { Ctx } from './store.js'

export const PLUGIN_NAME = 'dsh-vscode-mode'
export const MCP_PACKAGE = '@deepseek-ai/dsh-mcp-client'
/** 项目级 MCP 的 loader entry id 固定前缀（区分 profile 全局 MCP；loader id 不能用 ':'，故用 '.'）。 */
export const PROJECT_ENTRY_PREFIX = 'vsm-mcp.'
/** 旧版项目 MCP 条目前缀（升级残留识别，不显示为全局 MCP）。 */
export const LEGACY_PROJECT_PREFIX = 'vsm-mcp:'
/** webServer 路由前缀（RPC 精确路由 + 静态资源前缀共用）。 */
export const ROUTE_PREFIX = '/edrv'

/** 判断新旧格式项目 MCP 条目 id（旧残留不被视为全局 MCP）。 */
export function isProjectEntryId(id: string): boolean {
  return id.startsWith(PROJECT_ENTRY_PREFIX) || id.startsWith(LEGACY_PROJECT_PREFIX)
}

/** 从项目条目 id 解析 workspace hash（新旧格式通用）。 */
export function entryHash(id: string): string | undefined {
  if (id.startsWith(PROJECT_ENTRY_PREFIX)) return id.slice(PROJECT_ENTRY_PREFIX.length).split('.')[0]
  if (id.startsWith(LEGACY_PROJECT_PREFIX)) return id.slice(LEGACY_PROJECT_PREFIX.length).split(':')[0]
  return undefined
}

/** 读取随包 package.json 版本号（缺失/解析失败降级为空串）。 */
export function pluginVersionOf(): string {
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** 探测外部插件/服务适配状态（depsAvailable 由调用方注入，便于测试）。 */
export function detectExternal(ctx: Ctx, depsAvailable: boolean): CompatAdapter[] {
  const mcpCount = entriesOf(ctx).length
  const settings = ctx.get('settings') as { describe?: unknown; update?: unknown } | undefined
  const hasSettings = Boolean(settings?.describe || settings?.update)
  return [
    { name: MCP_PACKAGE, active: mcpCount > 0, note: mcpCount > 0 ? mcpCount + ' 个 MCP 服务条目' : '未检测到 MCP 条目（MCP 管理页显示为空）' },
    { name: '设置持久化（@deepseek-ai/dsh-settings）', active: depsAvailable, note: depsAvailable ? '设置 section 已安装' : '未安装：fileOpenTool 持久化降级为配置值' },
    { name: 'settings 服务', active: hasSettings, note: hasSettings ? '可读写设置' : '不可用（设置读写走配置回退）' },
  ]
}

/** 本插件已注册的路由（kind → path 集合），冲突检测时排除自身，避免自误报。 */
const ownRoutes = { exact: new Set<string>(), prefixes: new Set<string>() }

/** 清空本插件路由记录（registerRoutes 装配开始时调用，热重载不残留）。 */
export function resetOwnRoutes(): void {
  ownRoutes.exact.clear()
  ownRoutes.prefixes.clear()
}

/** 记录本插件路由（routes.ts 注册成功时调用）。 */
export function noteOwnRoute(kind: 'exact' | 'prefix', path: string): void {
  const table = kind === 'exact' ? ownRoutes.exact : ownRoutes.prefixes
  table.add(path)
}

/** 检测路由前缀占用与重叠（排除本插件自有路由；内部表不可读视为无冲突）。 */
export function routeConflict(web: unknown, prefix: string): string | null {
  try {
    const w = web as { exact?: Map<unknown, unknown>; prefixes?: Map<unknown, unknown> } | undefined
    const exact = w?.exact
    const prefixes = w?.prefixes
    if (exact instanceof Map) {
      for (const path of exact.keys()) {
        const other = String(path)
        if (other.startsWith(prefix + '/') && !ownRoutes.exact.has(other)) {
          return '精确路由 ' + other + ' 与 ' + prefix + ' 前缀重叠（可能来自热重载残留或其他插件）'
        }
      }
    }
    if (prefixes instanceof Map) {
      for (const path of prefixes.keys()) {
        const other = String(path)
        if (other !== prefix && (other.startsWith(prefix + '/') || prefix.startsWith(other + '/')) && !ownRoutes.prefixes.has(other)) {
          return '路由前缀 ' + prefix + ' 与 ' + other + ' 重叠'
        }
      }
    }
  } catch {
    /* 内部表不可读时放弃检查 */
  }
  return null
}

/** 检测本插件是否被重复装配（bundle 层 + 用户层重复 insert 的自诊断）。 */
export function duplicateEntries(ctx: Ctx): string[] {
  const loader = ctx.get('loader') as { entries?: () => Iterable<{ id?: unknown; options?: { name?: unknown } }> } | undefined
  if (!loader || typeof loader.entries !== 'function') return []
  const own = [...loader.entries()].filter((entry) => String(entry.options?.name ?? entry.id ?? '') === PLUGIN_NAME)
  if (own.length > 1) {
    return ['检测到 ' + own.length + ' 个 ' + PLUGIN_NAME + ' loader 条目（重复装配）。请删除 profile 用户层 cordis.patch.yml 的重复 insert（或运行 dev_fix_patch 清理）']
  }
  return []
}

/** 护栏适配状态：路由前缀唯一性 + 插件装配唯一性。 */
export function detectGuards(ctx: Ctx): CompatAdapter[] {
  const web = ctx.get('webServer')
  const conflict = web ? routeConflict(web, ROUTE_PREFIX) : null
  const duplicates = duplicateEntries(ctx)
  return [
    { name: '路由前缀 ' + ROUTE_PREFIX, active: !conflict, note: conflict ?? '无冲突' },
    { name: '插件装配唯一性', active: duplicates.length === 0, note: duplicates[0] ?? '唯一装配' },
  ]
}

/**
 * 构建完整兼容性报告（RPC 与启动日志共用）。
 * @author ddj 2026年08月24号
 * @param ctx DSH host 上下文
 * @param options 测试注入：depsAvailable 跳过动态导入、version 固定版本号
 * @returns 兼容性报告
 */
export async function buildReport(
  ctx: Ctx,
  options?: { depsAvailable?: boolean; version?: string },
): Promise<CompatReport> {
  const deps = options?.depsAvailable ?? (await loadSettingsDeps()) !== null
  const external = detectExternal(ctx, deps)
  const guards = detectGuards(ctx)
  const warnings: string[] = []
  if (!deps) warnings.push('未安装 @deepseek-ai/dsh-settings：文件打开工具设置持久化不可用（降级为配置值）')
  for (const guard of guards) {
    if (!guard.active && guard.note) warnings.push(guard.note)
  }
  return { pluginVersion: options?.version ?? pluginVersionOf(), external, guards, warnings, devForm: readDevForm() }
}
