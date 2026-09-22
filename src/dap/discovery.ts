/**
 * dsh-vscode-mode host — 调试适配器发现（清单驱动，VSCode contributes.debuggers 同源语义）。
 * 扫描全部扩展根（复用 lsp 侧 vscodeExtensionsDirs：~/.vscode/extensions、
 * ~/.vscode-server/extensions、插件扩展目录），读各扩展 package.json 的
 * contributes.debuggers[] 声明，解析为 DapAdapterDecl：
 * - program 按平台取 windows/linux/osx 覆盖，相对扩展根解析；
 * - runtime='node' → 由 node 跑 js 入口；无 runtime → program 即可执行（args 为清单声明）；
 * - 同 type 多扩展并存 → 按「清单版本降序(numeric) → 路径升序」取唯一（与 LSP 候选口径一致）；
 * - 入口不存在 / runtime 不支持 → available=false + reason（如 DotRush 按需下载的 clrdbg，
 *   诚实标注不假成功，调用方据此在下拉置灰并提示原因）。
 * 作者 ddj 2026年09月21号
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { LSP_LANG_EXT, manifestVersionOf, vscodeExtensionsDirs } from '../lsp/providers.js'
import { dshHome } from '../paths.js'
import type { DapAdapterDecl } from '../shared/dap.js'

/** package.json contributes.debuggers 条目（本插件消费的子集）。 */
interface DebuggerEntry {
  type?: unknown
  label?: unknown
  program?: unknown
  args?: unknown
  runtime?: unknown
  languages?: unknown
  windows?: { program?: unknown }
  linux?: { program?: unknown }
  osx?: { program?: unknown }
  darwin?: { program?: unknown }
  configurationAttributes?: {
    attach?: { properties?: { ext?: { default?: unknown } } }
    launch?: { properties?: { ext?: { default?: unknown } } }
  }
}

/** 发现缓存（扩展清单会话内基本不变；测试用 force 重扫）。 */
let cacheReady = false
let cacheHome = ''
let cache: DapAdapterDecl[] = []

/**
 * 发现全部调试适配器声明（按 type 去重、type 字典序稳定输出）。
 * @author ddj 2026年09月21号
 * @param force 强制重扫（扩展安装后 / 测试隔离用）
 * @param home DSH home（缺省真实；测试可注入）
 */
export function debuggerDecls(force = false, home = dshHome()): DapAdapterDecl[] {
  if (cacheReady && !force && home === cacheHome) return cache
  cache = scanDecls(home)
  cacheHome = home
  cacheReady = true
  return cache
}

/** 清空发现缓存（扩展目录变更时；测试 afterEach 复位）。 */
export function clearDiscoveryCache(): void {
  cacheReady = false
  cacheHome = ''
  cache = []
}

/** 扫描全部扩展根并收集声明（同 type 去重后返回）。 */
function scanDecls(home: string): DapAdapterDecl[] {
  const hits: { decl: DapAdapterDecl; version: string }[] = []
  for (const root of vscodeExtensionsDirs(home)) {
    for (const extDir of subDirsOf(root)) {
      for (const entry of debuggersOf(extDir)) {
        const decl = declOf(extDir, entry)
        if (decl) hits.push({ decl, version: manifestVersionOf(extDir) ?? '' })
      }
    }
  }
  return pickPerType(hits)
}

/** 同 type 去重：清单版本降序（numeric）→ 路径升序；输出按 type 字典序。 */
function pickPerType(hits: { decl: DapAdapterDecl; version: string }[]): DapAdapterDecl[] {
  const byType = new Map<string, { decl: DapAdapterDecl; version: string }>()
  for (const hit of hits) {
    const prev = byType.get(hit.decl.type)
    if (!betterOf(hit, prev)) continue
    byType.set(hit.decl.type, hit)
  }
  return [...byType.values()].map((h) => h.decl).sort((a, b) => a.type.localeCompare(b.type))
}

/** 候选比较：版本降序优先，平版本路径升序（无前任直接胜出）。 */
function betterOf(hit: { decl: DapAdapterDecl; version: string }, prev?: { decl: DapAdapterDecl; version: string }): boolean {
  if (!prev) return true
  const byVersion = compareVersion(hit.version, prev.version)
  if (byVersion !== 0) return byVersion > 0
  return hit.decl.extensionPath.localeCompare(prev.decl.extensionPath) < 0
}

/** 清单版本比较（numeric 感知，与 LSP 候选排序同口径）：>0 表示 a 更新。 */
function compareVersion(a: string, b: string): number {
  return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true })
}

/** 枚举扩展根下的扩展子目录（根不存在返回空）。 */
function subDirsOf(root: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name))
}

/** 读某扩展的 contributes.debuggers 声明（无清单/无声明/解析失败返回空）。 */
function debuggersOf(extDir: string): DebuggerEntry[] {
  try {
    const text = readFileSync(join(extDir, 'package.json'), 'utf8').replace(/^\uFEFF/, '')
    const manifest = JSON.parse(text) as { contributes?: { debuggers?: unknown } }
    const list = manifest.contributes?.debuggers
    return Array.isArray(list) ? (list as DebuggerEntry[]) : []
  } catch {
    return []
  }
}

/** 清单条目 → 声明（缺 type/program 视为无效条目跳过）。 */
function declOf(extDir: string, entry: DebuggerEntry): DapAdapterDecl | null {
  const type = typeof entry.type === 'string' ? entry.type : ''
  if (!type || typeof entry.program !== 'string' || !entry.program) return null
  const languages = stringsOf(entry.languages)
  const resolved = resolveProgram(extDir, entry)
  const runtime = typeof entry.runtime === 'string' && entry.runtime ? entry.runtime : undefined
  const runtimeBad = runtime !== undefined && runtime !== 'node'
  const available = resolved.available && !runtimeBad
  const reason = !resolved.available
    ? resolved.reason
    : runtimeBad
      ? '暂不支持运行时 "' + runtime + '"（仅支持 node 与原生可执行）'
      : undefined
  return {
    type,
    label: typeof entry.label === 'string' && entry.label ? entry.label : type,
    extensionId: extensionIdOf(extDir),
    extensionPath: extDir,
    program: resolved.program,
    args: stringsOf(entry.args),
    runtime,
    languages,
    exts: extsOf(entry, languages),
    available,
    reason,
  }
}

/** 平台 program 解析：windows/linux/osx(darwin) 覆盖优先，相对扩展根（剥 ./）。 */
function resolveProgram(extDir: string, entry: DebuggerEntry): { program: string; available: boolean; reason?: string } {
  const plat = process.platform
  const override = plat === 'win32'
    ? entry.windows?.program
    : plat === 'darwin'
      ? (entry.osx?.program ?? entry.darwin?.program)
      : entry.linux?.program
  const rel = typeof override === 'string' && override ? override : entry.program
  if (typeof rel !== 'string' || !rel) return { program: '', available: false, reason: '清单未声明本平台 program' }
  const program = join(extDir, ...rel.replace(/^\.\//, '').split(/[\\/]/))
  if (!existsSync(program)) {
    return { program, available: false, reason: '适配器入口不存在（扩展可能需按需下载）：' + rel }
  }
  return { program, available: true }
}

/** 来源扩展 id（目录名 publisher.name-version 取 version 前段；解析失败回退目录名）。 */
function extensionIdOf(extDir: string): string {
  const base = extDir.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('-')
  return dot > 0 ? base.slice(0, dot) : base
}

/** 可下断点扩展名：优先清单 configurationAttributes 的 ext 缺省（emmylua 的 .lua 家族），
 * 否则按声明 languages 映射（LSP 侧同源）；两者皆空 = 不限（不过滤断点）。 */
function extsOf(entry: DebuggerEntry, languages: string[]): string[] {
  const attrs = entry.configurationAttributes
  const declared = attrs?.attach?.properties?.ext?.default ?? attrs?.launch?.properties?.ext?.default
  const fromManifest = stringsOf(declared)
  if (fromManifest.length) return fromManifest
  const out: string[] = []
  for (const lang of languages) {
    for (const ext of LSP_LANG_EXT[lang] ?? []) {
      const dotted = '.' + ext.replace(/^\./, '')
      if (!out.includes(dotted)) out.push(dotted)
    }
  }
  return out
}

/** unknown → 字符串数组（非字符串元素剔除）。 */
function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
}
