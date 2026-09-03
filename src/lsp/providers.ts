/**
 * dsh-vscode-mode host — 语言服务器 provider 解析。
 * 优先级：手动配置 > extmgr 扩展源(Phase 2 挂载) > 自动发现(~/.vscode/extensions、
 * ~/.dsh/dsh-vscode-mode/extensions、PATH)。C# 自动发现覆盖 ms-dotnettools.csharp
 * （Roslyn/OmniSharp）与 DotRush（自带 DotRush.dll 服务器，需对应 .NET 运行时）。
 * 产物 LspProviderSpec：{ ready, argv, cwd, reason }，供 manager 启动服务器。
 * 作者 ddj 2026-08-27
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { isAbsolute } from 'node:path'
import { extensionsRoot } from './extmgr.js'
import { dshHome, lspSpecCacheFile } from '../paths.js'

/** provider 来源标记（与 shared/lsp.ts 的 status.source 一致）。 */
export type LspProviderKind = 'extension' | 'discover' | 'manual' | 'none'

export interface LspProviderSpec {
  languageId: string
  kind: LspProviderKind
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  /** 需自动配置的 .NET 运行时大版本（发现 DotRush 但缺运行时时设置，见 dotnetProvision.ts）。 */
  provisionRuntime?: number
  ready: boolean
  reason?: string
  version?: string
  providerName?: string
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

/**
 * VSCode 扩展目录（~/.vscode/extensions、~/.vscode-server/extensions + extmgr 目录；无则空数组）。
 * 测试可用 DSH_LSP_EXT_DIRS（平台路径分隔符分隔）完全覆盖扫描列表，避免受真实机器扩展影响。
 * @author ddj 2026年09月03号
 */
export function vscodeExtensionsDirs(home = dshHome()): string[] {
  const override = process.env.DSH_LSP_EXT_DIRS
  if (override) {
    return override.split(sep === '\\' ? ';' : ':').map((dir) => dir.trim()).filter((dir) => dir && existsSync(dir))
  }
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
  return { languageId, kind: 'extension', argv: p.argv, cwd: p.cwd, ready: true, version: p.version, providerName: '语言服务器扩展' }
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

/** dotnet 候选（PATH 命中 + 常见安装路径 + 用户级安装位置），仅保留真实存在者。 */
export function dotnetCandidates(): string[] {
  const localAppData = process.env.LOCALAPPDATA
  const out = [
    findInPath('dotnet'),
    'C:/Program Files/dotnet/dotnet.exe',
    'C:/Program Files (x86)/dotnet/dotnet.exe',
    localAppData ? join(localAppData, 'Microsoft', 'dotnet', 'dotnet.exe') : null,
  ]
  return out.filter((p): p is string => !!p && existsSync(p))
}

/** 查找 dotnet（PATH + 常见安装路径）。 */
export function findDotnet(): string | null {
  return dotnetCandidates()[0] ?? null
}

/**
 * 查找具备指定 .NET 运行时大版本的 dotnet（按 dotnetCandidates 顺序探测）。
 * @author ddj 2026年09月03号
 * @param minMajor 运行时最低大版本（如 10）
 * @param candidates dotnet 候选路径（缺省 dotnetCandidates()；测试可注入）
 * @returns 满足条件的 dotnet 路径；无满足者返回 null
 */
export function dotnetWithRuntime(minMajor: number, candidates: string[] = dotnetCandidates()): string | null {
  for (const dotnet of candidates) {
    const sharedDir = join(dirname(dotnet), 'shared', 'Microsoft.NETCore.App')
    let versions: string[] = []
    try {
      versions = readdirSync(sharedDir)
    } catch (error) {
      continue
    }
    const found = versions.some((name) => {
      const major = Number.parseInt(name.split('.')[0] ?? '', 10)
      return Number.isInteger(major) && major >= minMajor
    })
    if (found) return dotnet
  }
  return null
}

/**
 * 探测含 .NET SDK 的 dotnet 根目录（MSBuild 工程求值与 restore 需要，runtime-only 不够）。
 * @author ddj 2026年09月03号
 * @param candidates dotnet 候选路径（缺省 dotnetCandidates()；测试可注入）
 * @returns 含 SDK 的 dotnet 根目录；无则 null
 */
export function findSdkRoot(candidates: string[] = dotnetCandidates()): string | null {
  for (const dotnet of candidates) {
    const root = dirname(dotnet)
    if (sdkVersionOf(root)) return root
  }
  return null
}

/**
 * dotnet 根目录下最新 SDK 版本号（无 SDK 返回 null）。
 * @author ddj 2026年09月03号
 * @param root dotnet 根目录
 * @returns SDK 版本号
 */
export function sdkVersionOf(root: string): string | null {
  try {
    const versions = readdirSync(join(root, 'sdk')).filter((name) => /^\d+\.\d+/.test(name))
    if (!versions.length) return null
    return versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] ?? null
  } catch (error) {
    return null
  }
}

/**
 * C# 服务器所需的 MSBuild 环境变量（SDK 解析 + restore 的 muxer 定位）。
 * @author ddj 2026年09月03号
 * @param sdkRoot 含 SDK 的 dotnet 根目录
 * @returns 环境变量表
 */
export function sdkEnvOf(sdkRoot: string): Record<string, string> {
  const version = sdkVersionOf(sdkRoot)
  const env: Record<string, string> = {
    DOTNET_ROOT: sdkRoot,
    DOTNET_MSBUILD_SDK_RESOLVER_CLI_DIR: sdkRoot,
  }
  if (version) env.DOTNET_SDK_PATH = join(sdkRoot, 'sdk', version)
  return env
}

/** 读扩展目录 package.json 的 version（读取失败不影响入口使用，返回 undefined）。 */
function manifestVersionOf(extDir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(extDir, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch (error) {
    return undefined
  }
}

/** EmmyLua 自动发现候选（tangzx.emmylua-* / server/emmylua_ls）。 */
export function candidateEmmyLua(home = dshHome()): { path: string; version?: string } | null {
  const candidates: { path: string; version?: string }[] = []
  for (const dir of vscodeExtensionsDirs(home)) {
    for (const extDir of listMatchingDirs(dir, 'tangzx.emmylua-')) {
      const server = join(extDir, 'server', 'emmylua_ls' + exeSuffix())
      if (!existsSync(server)) continue
      candidates.push({ path: server, version: manifestVersionOf(extDir) })
    }
  }
  candidates.sort((a, b) => (b.version ?? '').localeCompare(a.version ?? '', undefined, { numeric: true }) || a.path.localeCompare(b.path))
  return candidates[0] ?? null
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

/** C# 服务器发现结果（ms-Roslyn / DotRush / OmniSharp + 系统 dotnet）。 */
export interface CSharpCandidates {
  roslynDll?: string
  dotrushDll?: string
  dotrushVersion?: string
  omnisharpExe?: string
  dotnet?: string
}

/**
 * C# 自动发现候选：ms-dotnettools.csharp 的 Roslyn dll（需 dotnet）/ OmniSharp 可执行，
 * 以及 DotRush 扩展自带服务器（extension/bin/LanguageServer/DotRush.dll，需对应 .NET 运行时）。
 * @author ddj 2026年09月03号
 * @param home DSH home（缺省真实；测试可注入临时目录）
 * @returns 发现结果
 */
export function candidateCSharpServers(home = dshHome()): CSharpCandidates {
  const out: CSharpCandidates = {}
  const dotrushHits: { dll: string; version?: string }[] = []
  for (const dir of vscodeExtensionsDirs(home)) {
    for (const extDir of listMatchingDirs(dir, 'ms-dotnettools.csharp-')) {
      const roslyn = join(extDir, '.roslyn', 'Microsoft.CodeAnalysis.LanguageServer.dll')
      if (!out.roslynDll && existsSync(roslyn)) out.roslynDll = roslyn
      const omni = join(extDir, '.omnisharp', 'OmniSharp' + exeSuffix())
      if (!out.omnisharpExe && existsSync(omni)) out.omnisharpExe = omni
    }
    for (const extDir of listMatchingDirs(dir, 'nromanov.dotrush-')) {
      const dll = join(extDir, 'extension', 'bin', 'LanguageServer', 'DotRush.dll')
      if (!existsSync(dll)) continue
      dotrushHits.push({ dll, version: manifestVersionOf(extDir) })
    }
  }
  // 多版本并存时取清单版本最高者（与 EmmyLua 发现的排序策略一致）
  const best = dotrushHits.sort((a, b) => (b.version ?? '').localeCompare(a.version ?? '', undefined, { numeric: true }) || a.dll.localeCompare(b.dll))[0]
  if (best) {
    out.dotrushDll = best.dll
    out.dotrushVersion = best.version
  }
  const dotnet = findDotnet()
  if (dotnet) out.dotnet = dotnet
  return out
}

/**
 * 从服务器 dll 同目录的 *.runtimeconfig.json 解析所需 .NET 运行时大版本。
 * @author ddj 2026年09月03号
 * @param dllDir 服务器 dll 所在目录
 * @returns 运行时大版本；无清单或解析失败返回 null
 */
export function runtimeMajorOf(dllDir: string): number | null {
  try {
    for (const name of readdirSync(dllDir)) {
      if (!name.endsWith('.runtimeconfig.json')) continue
      const config = JSON.parse(readFileSync(join(dllDir, name), 'utf8')) as { runtimeOptions?: { framework?: { version?: unknown } } }
      const version = config.runtimeOptions?.framework?.version
      if (typeof version !== 'string') continue
      const major = Number.parseInt(version.split('.')[0] ?? '', 10)
      if (Number.isInteger(major)) return major
    }
  } catch (error) { /* 清单读取失败按无约束处理 */ }
  return null
}

/**
 * 解析 DotRush 启动参数：优先扩展内置 SDK dotnet，否则找满足其运行时大版本的 dotnet。
 * @author ddj 2026年09月03号
 * @param dll DotRush.dll 绝对路径
 * @returns argv 可直接启动；reason 为不可启动的原因
 */
function dotrushLaunch(dll: string): { argv: string[] } | { reason: string } {
  const sdkDotnet = join(dirname(dirname(dll)), 'Sdk', 'dotnet' + exeSuffix())
  const major = runtimeMajorOf(dirname(dll))
  const dotnet = existsSync(sdkDotnet) ? sdkDotnet : major !== null ? dotnetWithRuntime(major) : findDotnet()
  if (dotnet) return { argv: [dotnet, dll] }
  return { reason: 'DotRush 需 .NET ' + (major ?? '') + ' 运行时，未找到满足的 dotnet' }
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
  return resolveCached('lua', manual, home, (h) => {
    const ext = extensionProviderFor('lua')
    if (ext) return ext
    const emmy = candidateEmmyLua(h)
    if (emmy) return { ...base, kind: 'extension', argv: [emmy.path], ready: true, version: emmy.version, providerName: 'EmmyLua' }
    const candidates = candidateLuaServers(h)
    if (candidates.length) return { ...base, kind: 'discover', argv: [candidates[0]], cwd: undefined, ready: true }
    const inPath = findInPath('lua-language-server' + exeSuffix())
    if (inPath) return { ...base, kind: 'discover', argv: [inPath], ready: true }
    return { ...base, kind: 'none', argv: [], ready: false, reason: manualResolved.reason ?? '未发现 lua-language-server（可安装 LuaLS 或手动指定路径）' }
  })
}

/**
 * 解析 C# provider（优先级：手动 > 扩展源 > 自动发现；Roslyn dll 需 dotnet；
 * DotRush 需满足其运行时的 dotnet；或 OmniSharp）。
 * @author ddj 2026年08月27号
 * @param manual 手动配置
 * @param home DSH home（缺省真实；测试可注入临时目录）
 * @returns provider 规格
 */
export function resolveCSharpProvider(manual?: { command?: string; path?: string }, home = dshHome()): LspProviderSpec {
  const base = { languageId: 'csharp' }
  const manualResolved = manualSpec(manual)
  if (manualResolved.ready) return { ...base, kind: 'manual', argv: manualResolved.argv, cwd: manualResolved.cwd, ready: true }
  return resolveCached('csharp', manual, home, (h) => {
    const ext = extensionProviderFor('csharp')
    if (ext) return ext
    const discovered = candidateCSharpServers(h)
    // SDK 环境注入：runtime-only 的 dotnet 会导致 MSBuild 求值/restore 退化
    const sdkRoot = findSdkRoot()
    const msbuildEnv = sdkRoot ? sdkEnvOf(sdkRoot) : undefined
    if (discovered.roslynDll && discovered.dotnet) {
      return { ...base, kind: 'discover', argv: [discovered.dotnet, discovered.roslynDll, '--stdio'], env: msbuildEnv, ready: true }
    }
    let dotrushReason: string | null = null
    let provisionMajor: number | undefined
    if (discovered.dotrushDll) {
      const major = runtimeMajorOf(dirname(discovered.dotrushDll))
      const launch = dotrushLaunch(discovered.dotrushDll)
      if ('argv' in launch) {
        return { ...base, kind: 'discover', argv: launch.argv, env: msbuildEnv, ready: true, version: discovered.dotrushVersion, providerName: 'DotRush' }
      }
      dotrushReason = launch.reason
      provisionMajor = major ?? undefined
    }
    if (discovered.omnisharpExe) {
      return { ...base, kind: 'discover', argv: [discovered.omnisharpExe, '--stdio'], ready: true }
    }
    const reasons: string[] = []
    if (dotrushReason) {
      reasons.push(dotrushReason)
    } else {
      if (!discovered.dotnet) reasons.push('未找到 dotnet')
      reasons.push('未发现 ms-dotnettools.csharp / DotRush 扩展')
    }
    return { ...base, kind: 'none', argv: [], ready: false, provisionRuntime: provisionMajor, reason: reasons.join('；') + '（可手动指定 Roslyn/OmniSharp 入口）' }
  })
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

// --region provider 发现结果缓存（进程级 + 磁盘持久化）
/**
 * 发现结果缓存：只缓存"自动发现/扩展源"结论，不缓存 manual（用户改配置要立即生效）。
 * 进程内 Map 命中优先；未命中读磁盘缓存（跨会话/跨重启共享）；仍无才真扫描。
 * 缓存条目按"配置签名 + 扩展目录指纹"校验，任一变化即失效重扫。
 * 作者 ddj 2026年08月28号
 */

/** 缓存条目：spec + 生成时的环境指纹。 */
interface SpecCacheEntry {
  spec: LspProviderSpec
  fingerprint: string
  at: number
}

/** 进程级缓存（home|languageId → 条目），同一 DSH home 的不同会话共享。 */
const specCache = new Map<string, SpecCacheEntry>()
/** 磁盘缓存是否已载入本进程（home → loaded），不同 profile 不串缓存。 */
const diskLoaded = new Set<string>()
/** 自动发现成功结果的复用时长；过期后才检查目录指纹。 */
const SPEC_CACHE_TTL_MS = 30 * 60 * 1000
/** 未发现结果的短缓存时长，避免缺失服务器时反复扫描 PATH。 */
const SPEC_NEGATIVE_CACHE_MS = 60 * 1000

/** 生成带 home 的缓存键，避免不同 profile 的 provider 结果串用。 */
function cacheEntryKey(home: string, languageId: string): string {
  return home + '|' + languageId
}

/**
 * 构造缓存 key：语言 + 手动配置（manual 结果不缓存，故只参与"是否走缓存"判定）。
 * @author ddj 2026年08月28号
 * @param languageId 语言 id
 * @param manual 手动配置
 * @returns 缓存 key（manual 有效时返回空串表示跳过缓存）
 */
function cacheKeyOf(languageId: string, manual?: { command?: string; path?: string }): string {
  const pathValue = manual?.path?.trim() ?? ''
  const commandValue = manual?.command?.trim() ?? ''
  if (pathValue || commandValue) return '' // 手动配置：不缓存，立即生效
  return languageId
}

/**
 * 环境指纹：扩展目录清单 + 平台。目录增删/换平台即失效（防缓存陈旧指向已删扩展）。
 * @author ddj 2026年08月28号
 * @param home DSH home
 * @returns 指纹串
 */
function fingerprintOf(home: string): string {
  const dirs = vscodeExtensionsDirs(home)
  const marks = dirs.map((dir) => {
    try {
      return readdirSync(dir).sort().join(',')
    } catch (error) {
      return '?'
    }
  })
  return process.platform + '|' + (findSdkRoot() ?? 'no-sdk') + '|' + marks.join('|')
}

/**
 * 读取磁盘缓存（幂等：每进程只载一次；schema 文件名已隔离版本）。
 * @author ddj 2026年08月28号
 * @param home DSH home
 */
function loadDiskCache(home: string): void {
  if (diskLoaded.has(home)) return
  diskLoaded.add(home)
  const file = lspSpecCacheFile(home)
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, SpecCacheEntry>
    for (const [languageId, entry] of Object.entries(raw)) {
      if (entry && typeof entry === 'object' && entry.spec && typeof entry.fingerprint === 'string') {
        specCache.set(cacheEntryKey(home, languageId), entry)
      }
    }
  } catch (error) { /* 首次运行/损坏：静默降级为真扫描 */ }
}

/**
 * 写回磁盘缓存（best-effort；写失败不影响本次解析结果）。
 * @author ddj 2026年08月28号
 * @param home DSH home
 */
function saveDiskCache(home: string): void {
  const file = lspSpecCacheFile(home)
  try {
    mkdirSync(dirname(file), { recursive: true })
    const out: Record<string, SpecCacheEntry> = {}
    const prefix = home + '|'
    for (const [key, entry] of specCache) if (key.startsWith(prefix)) out[key.slice(prefix.length)] = entry
    writeFileSync(file, JSON.stringify(out), 'utf8')
  } catch (error) { /* 写入失败静默 */ }
}

/**
 * 带缓存执行 provider 解析（自动发现路径专用）。
 * @author ddj 2026年08月28号
 * @param languageId 语言 id
 * @param manual 手动配置
 * @param home DSH home
 * @param resolve 真解析函数（未命中时调用）
 * @returns provider 规格
 */
function resolveCached(
  languageId: string,
  manual: { command?: string; path?: string } | undefined,
  home: string,
  resolve: (h: string) => LspProviderSpec,
): LspProviderSpec {
  const key = cacheKeyOf(languageId, manual)
  if (!key) return resolve(home) // 手动配置：不走缓存
  loadDiskCache(home)
  const fullKey = cacheEntryKey(home, key)
  const hit = specCache.get(fullKey)
  if (hit && isCacheFresh(hit)) return hit.spec
  const fingerprint = fingerprintOf(home)
  if (hit && hit.fingerprint === fingerprint) {
    hit.at = Date.now()
    return hit.spec
  }
  const spec = resolve(home)
  specCache.set(fullKey, { spec, fingerprint, at: Date.now() })
  saveDiskCache(home)
  return spec
}

/** 判断缓存条目是否仍可直接复用，不触发扩展目录扫描。 */
function isCacheFresh(entry: SpecCacheEntry): boolean {
  const age = Date.now() - entry.at
  const ttl = entry.spec.kind === 'none' ? SPEC_NEGATIVE_CACHE_MS : SPEC_CACHE_TTL_MS
  if (age < 0 || age >= ttl) return false
  const executable = entry.spec.argv[0]
  return !entry.spec.ready || !executable || existsSync(executable)
}

/**
 * 清空 provider 发现缓存（扩展安装/卸载、配置变更后调用；进程级 + 删磁盘文件）。
 * @author ddj 2026年08月28号
 * @param home DSH home（缺省真实）
 */
export function clearProviderCache(home = dshHome()): void {
  const prefix = home + '|'
  for (const key of specCache.keys()) if (key.startsWith(prefix)) specCache.delete(key)
  diskLoaded.delete(home)
  try {
    rmSync(lspSpecCacheFile(home), { force: true })
  } catch (error) { /* 删除失败静默 */ }
}
// --endregion
