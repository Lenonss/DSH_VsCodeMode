/**
 * dsh-vscode-mode host — 语言服务器 provider 解析。
 * 优先级：手动配置 > extmgr 扩展源(Phase 2 挂载) > 自动发现(~/.vscode/extensions、
 * ~/.dsh/dsh-vscode-mode/extensions、PATH)。产物 LspProviderSpec：{ ready, argv, cwd, reason }，
 * 供 manager 启动服务器。
 * 作者 ddj 2026-08-27
 */
import { existsSync, readdirSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { isAbsolute } from 'node:path'
import { extensionsRoot } from './extmgr.js'
import { dshHome } from '../paths.js'

/** provider 来源标记（与 shared/lsp.ts 的 status.source 一致）。 */
export type LspProviderKind = 'extension' | 'discover' | 'manual' | 'none'

export interface LspProviderSpec {
  languageId: string
  kind: LspProviderKind
  argv: string[]
  cwd?: string
  ready: boolean
  reason?: string
}

/** 语言 → 扩展名（用于判断哪些文件触发该语言服务器）。 */
export const LSP_LANG_EXT: Record<string, string[]> = {
  lua: ['lua'],
  csharp: ['cs', 'csx'],
}

/** 平台目录名（LuaLS/OmniSharp 的 server/bin/<平台>）。 */
export function platformServerDir(platform = process.platform): string {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  return 'Linux'
}

/** exe 后缀（Windows 为 .exe）。 */
export function exeSuffix(platform = process.platform): string {
  return platform === 'win32' ? '.exe' : ''
}

/** 列出目录下匹配前缀的子目录（如 ~/.vscode/extensions/sumneko.lua-*）。 */
export function listMatchingDirs(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return []
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return []
  }
  return entries.filter((e) => e.isDirectory() && e.name.startsWith(prefix)).map((e) => join(dir, e.name))
}

/** VSCode 扩展目录（~/.vscode/extensions、~/.vscode-server/extensions + extmgr 目录；无则空数组）。 */
export function vscodeExtensionsDirs(home = dshHome()): string[] {
  const userHome = homedir()
  return [
    join(userHome, '.vscode', 'extensions'),
    join(userHome, '.vscode-server', 'extensions'),
    extensionsRoot(home),
  ].filter((dir) => existsSync(dir))
}

// --region 扩展源 provider 挂载点（extmgr 安装扩展后注册；kind=extension）
/** 扩展源 provider 注册表：languageId → 启动参数。 */
const extProviders = new Map<string, { argv: string[]; cwd?: string; version?: string }>()

/**
 * 注册扩展源 provider（extmgr 安装的 VSIX 扩展调用；覆盖/清除传空 argv 可注销）。
 * @author ddj 2026年08月27号
 * @param languageId 语言 id
 * @param argv 启动参数（argv[0] 为可执行）
 * @param cwd 工作目录
 * @param version 扩展版本（诊断展示）
 */
export function registerExtensionProvider(languageId: string, argv: string[], cwd?: string, version?: string): void {
  if (!argv.length) {
    extProviders.delete(languageId)
    return
  }
  extProviders.set(languageId, { argv, cwd, version })
}

/** 取扩展源 provider spec（未注册返回 null）。 */
export function extensionProviderFor(languageId: string): LspProviderSpec | null {
  const p = extProviders.get(languageId)
  if (!p || !p.argv.length) return null
  return { languageId, kind: 'extension', argv: p.argv, cwd: p.cwd, ready: true }
}

/** 清空全部扩展源注册（插件卸载/扩展目录重建时）。 */
export function clearExtensionProviders(): void {
  extProviders.clear()
}
// --endregion

/** PATH 中查找可执行文件（不含扩展名校验，交由 spawn 报错）。 */
export function findInPath(name: string): string | null {
  const pathEnv = process.env.PATH ?? ''
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const dir of pathEnv.split(sep === '\\' ? ';' : ':')) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** 查找 dotnet（PATH + 常见安装路径）。 */
export function findDotnet(): string | null {
  const inPath = findInPath('dotnet')
  if (inPath) return inPath
  const candidates = [
    'C:/Program Files/dotnet/dotnet.exe',
    'C:/Program Files (x86)/dotnet/dotnet.exe',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

/** LuaLS 自动发现候选（VSCode 扩展目录 + extmgr 目录下 sumneko.lua-* 的 server/bin 可执行）。 */
export function candidateLuaServers(home = dshHome()): string[] {
  const plat = platformServerDir()
  const suffix = exeSuffix()
  const out: string[] = []
  for (const dir of vscodeExtensionsDirs(home)) {
    for (const extDir of listMatchingDirs(dir, 'sumneko.lua-')) {
      const binDir = join(extDir, 'server', 'bin')
      const binName = 'lua-language-server' + suffix
      // 新布局（3.x 平台变体 vsix）：server/bin/xxx.exe；旧布局：server/bin/<平台>/xxx.exe
      const bin = existsSync(join(binDir, binName)) ? join(binDir, binName) : join(binDir, plat, binName)
      if (existsSync(bin) && !out.includes(bin)) out.push(bin)
    }
  }
  return out
}

/** C# 自动发现候选：Roslyn dll（需 dotnet）或 OmniSharp 可执行。 */
export function candidateCSharpServers(home = dshHome()): { roslynDll?: string; omnisharpExe?: string; dotnet?: string } {
  const out: { roslynDll?: string; omnisharpExe?: string; dotnet?: string } = {}
  for (const dir of vscodeExtensionsDirs(home)) {
    for (const extDir of listMatchingDirs(dir, 'ms-dotnettools.csharp-')) {
      const roslyn = join(extDir, '.roslyn', 'Microsoft.CodeAnalysis.LanguageServer.dll')
      if (!out.roslynDll && existsSync(roslyn)) out.roslynDll = roslyn
      const omni = join(extDir, '.omnisharp', 'OmniSharp' + exeSuffix())
      if (!out.omnisharpExe && existsSync(omni)) out.omnisharpExe = omni
    }
  }
  const dotnet = findDotnet()
  if (dotnet) out.dotnet = dotnet
  return out
}

/**
 * 手动配置归一化：path 指向可执行文件/目录，command 为可执行名（PATH 解析）。
 * 未配置时返回空 reason（由各 resolve 兜底输出语言相关安装指引文案）。
 * @author ddj 2026年08月27号
 */
export function manualSpec(manual: { command?: string; path?: string } | undefined): { argv: string[]; cwd?: string; ready: boolean; reason?: string } {
  if (!manual) return { argv: [], ready: false }
  const pathValue = typeof manual.path === 'string' && manual.path.trim() ? manual.path.trim() : ''
  const commandValue = typeof manual.command === 'string' && manual.command.trim() ? manual.command.trim() : ''
  if (!pathValue && !commandValue) return { argv: [], ready: false }
  if (pathValue) {
    if (!existsSync(pathValue)) return { argv: [], ready: false, reason: '路径不存在：' + pathValue }
    return { argv: [pathValue], ready: true }
  }
  const found = findInPath(commandValue)
  if (!found) return { argv: [], ready: false, reason: 'PATH 中找不到命令：' + commandValue }
  return { argv: [found], ready: true }
}

/**
 * 解析 Lua provider（优先级：手动 > 扩展源 > 自动发现）。
 * @author ddj 2026年08月27号
 * @param manual 手动配置
 * @param home DSH home（缺省真实；测试可注入临时目录）
 * @returns provider 规格
 */
export function resolveLuaProvider(manual?: { command?: string; path?: string }, home = dshHome()): LspProviderSpec {
  const base = { languageId: 'lua' }
  const manualResolved = manualSpec(manual)
  if (manualResolved.ready) return { ...base, kind: 'manual', argv: manualResolved.argv, cwd: manualResolved.cwd, ready: true }
  const ext = extensionProviderFor('lua')
  if (ext) return ext
  const candidates = candidateLuaServers(home)
  if (candidates.length) return { ...base, kind: 'discover', argv: [candidates[0]], cwd: undefined, ready: true }
  const inPath = findInPath('lua-language-server' + exeSuffix())
  if (inPath) return { ...base, kind: 'discover', argv: [inPath], ready: true }
  return { ...base, kind: 'none', argv: [], ready: false, reason: manualResolved.reason ?? '未发现 lua-language-server（可安装 LuaLS 或手动指定路径）' }
}

/**
 * 解析 C# provider（优先级：手动 > 扩展源 > 自动发现；需 dotnet + Roslyn dll；或 OmniSharp）。
 * @author ddj 2026年08月27号
 * @param manual 手动配置
 * @param home DSH home（缺省真实；测试可注入临时目录）
 * @returns provider 规格
 */
export function resolveCSharpProvider(manual?: { command?: string; path?: string }, home = dshHome()): LspProviderSpec {
  const base = { languageId: 'csharp' }
  const manualResolved = manualSpec(manual)
  if (manualResolved.ready) return { ...base, kind: 'manual', argv: manualResolved.argv, cwd: manualResolved.cwd, ready: true }
  const ext = extensionProviderFor('csharp')
  if (ext) return ext
  const discovered = candidateCSharpServers(home)
  if (discovered.roslynDll && discovered.dotnet) {
    return { ...base, kind: 'discover', argv: [discovered.dotnet, discovered.roslynDll, '--stdio'], ready: true }
  }
  if (discovered.omnisharpExe) {
    return { ...base, kind: 'discover', argv: [discovered.omnisharpExe, '--stdio'], ready: true }
  }
  const reasons: string[] = []
  if (!discovered.dotnet) reasons.push('未找到 dotnet')
  if (!discovered.roslynDll && !discovered.omnisharpExe) reasons.push('未发现 ms-dotnettools.csharp 扩展')
  return { ...base, kind: 'none', argv: [], ready: false, reason: reasons.join('；') + '（可手动指定 Roslyn/OmniSharp 入口）' }
}

/** 语言 → provider 解析器（可扩展；Phase 2 由 extmgr 注册扩展源 provider）。 */
export type ProviderResolver = (manual?: { command?: string; path?: string }) => LspProviderSpec

export const PROVIDER_RESOLVERS: Record<string, ProviderResolver> = {
  lua: resolveLuaProvider,
  csharp: resolveCSharpProvider,
}

/** 手动配置是否为绝对路径可执行（供设置页判断输入类型）。 */
export function looksAbsolute(value: string): boolean {
  return isAbsolute(value)
}
