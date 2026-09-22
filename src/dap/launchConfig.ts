/**
 * dsh-vscode-mode host — 调试配置文件通用解析（JSONC 清洗 + 全量配置透传）。
 * 纯函数，node 可测。读插件专属 `.dsh/launch.json`（格式与 VS Code launch.json 兼容；
 * 与 `.vscode/launch.json` 互不干扰，旧共用文件仅作首读迁移源）：
 * - 不再限定 emmylua：所有带 name/type 的 configuration 都保留（类型可用性由 discovery 裁决）；
 * - 未识别字段原样进 raw（attach/launch 请求参数透传给适配器，对齐 VS Code 语义）；
 * - ${workspaceFolder}/${cwd} 按工作区根替换；${command:...} 是 VS Code 命令占位，
 *   本插件无法解析——检出后由调用方明确报错（不做静默假解析）。
 * 作者 ddj 2026年09月29号 / 2026年09月21号
 */
import type { DapDebugConfig } from '../shared/dap.js'

/**
 * 清洗 JSONC 为可 JSON.parse 文本：去 // 与 /* *\/ 注释、去尾逗号（字符串字面量感知）。
 * @author ddj 2026年09月29号
 * @param text 原始 launch.json 文本
 * @returns 清洗后文本
 */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  let state: 'code' | 'string' = 'code'
  while (i < n) {
    const ch = text[i]
    const next = i + 1 < n ? text[i + 1] : ''
    if (state === 'string') {
      out += ch
      if (ch === '\\') { out += next; i += 2; continue }
      if (ch === '"') state = 'code'
      i += 1
      continue
    }
    if (ch === '"') { state = 'string'; out += ch; i += 1; continue }
    if (ch === '/' && next === '/') { while (i < n && text[i] !== '\n') i += 1; continue }
    if (ch === '/' && next === '*') { i += 2; while (i + 1 < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 2; continue }
    out += ch
    i += 1
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/**
 * 解析 launch.json 文本为全量调试配置列表（非法/缺 name/type 的条目跳过）。
 * @author ddj 2026年09月29号 / 2026年09月21号
 * @param text launch.json 文本（JSONC）
 * @param workspacePath 工作区根（${workspaceFolder}/${cwd} 替换基准；空 = 不替换）
 * @returns 全量配置（raw 原样透传）
 */
export function parseLaunchConfigs(text: string, workspacePath = ''): DapDebugConfig[] {
  let data: unknown
  try { data = JSON.parse(stripJsonc(text)) } catch { return [] }
  const list = (data as { configurations?: unknown })?.configurations
  if (!Array.isArray(list)) return []
  const out: DapDebugConfig[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const cfg = item as Record<string, unknown>
    const type = asString(cfg.type)
    const name = asString(cfg.name)
    if (!type || !name) continue
    out.push({
      name,
      type,
      request: asString(cfg.request),
      processName: asString(cfg.processName),
      pid: asPositive(cfg.pid),
      processId: asPositive(cfg.processId),
      host: asString(cfg.host),
      port: asPositive(cfg.port),
      sourcePaths: stringListOf(cfg.sourcePaths),
      ext: stringListOf(cfg.ext),
      captureLog: typeof cfg.captureLog === 'boolean' ? cfg.captureLog : undefined,
      raw: expandRaw(cfg, workspacePath),
    })
  }
  return out
}

/**
 * 配置是否含 ${command:...} 占位（VS Code 命令，本插件无法解析，需用户改为具体值）。
 * @author ddj 2026年09月21号
 * @param config 调试配置
 */
export function hasCmdPlaceholder(config: DapDebugConfig): boolean {
  return JSON.stringify(config.raw ?? {}).includes('${command:')
}

/** ${workspaceFolder}/${cwd} → 工作区根（大小写不敏感；其余占位保持原样交适配器）。 */
function expandLaunchVars(text: string, workspacePath: string): string {
  if (!workspacePath) return text
  return text
    .replace(/\$\{workspaceFolder\}/gi, workspacePath)
    .replace(/\$\{cwd\}/gi, workspacePath)
}

/** raw 逐字段递归展开（字符串内占位替换；数组/嵌套对象同口径）。 */
function expandRaw(raw: Record<string, unknown>, workspacePath: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) out[key] = expandValue(value, workspacePath)
  return out
}

/** 单值展开。 */
function expandValue(value: unknown, workspacePath: string): unknown {
  if (typeof value === 'string') return expandLaunchVars(value, workspacePath)
  if (Array.isArray(value)) return value.map((v) => expandValue(v, workspacePath))
  if (value && typeof value === 'object') return expandRaw(value as Record<string, unknown>, workspacePath)
  return value
}

/** unknown → 字符串（非字符串返回 undefined）。 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/** unknown → 正数（number 且 >0；其余 undefined）。 */
function asPositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** 字符串数组字段清洗（非字符串元素剔除；空数组返回 undefined）。 */
function stringListOf(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const items = raw.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return items.length ? items : undefined
}
