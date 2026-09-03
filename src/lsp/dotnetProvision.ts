/**
 * dsh-vscode-mode host — C# 服务器 .NET 运行时自动配置。
 * DotRush 等服务器需要 .NET 运行时；缺失时从官方 release 元数据解析下载地址，
 * sha512 校验后解压到用户级 dotnet 目录（win: %LOCALAPPDATA%\Microsoft\dotnet，
 * unix: ~/.dotnet），成功后通知监听者重载 provider——用户零手动操作。
 * 失败静默降级（保留原 reason 文案），10 分钟退避重试。
 * 安装全程有状态机（envInstallStates）供设置页一键安装与进度轮询使用。
 * 作者 ddj 2026年09月03号
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { dotnetWithRuntime } from './providers.js'
import type { LspEnvInstallState } from '../shared/lsp.js'
import { unzip } from './zip.js'

/** release 元数据 files 元素子集（官方 releases.json）。 */
export interface RuntimeAsset {
  name: string
  url: string
  hash: string
}

const META_BASE = 'https://builds.dotnet.microsoft.com/dotnet/release-metadata'
const RETRY_MS = 10 * 60 * 1000

/** 同 major 去重（in-flight）。 */
const inFlight = new Map<number, Promise<boolean>>()
/** 失败时间戳（退避重试）。 */
const failedAt = new Map<number, number>()
/** 配置成功监听者（重载 provider 缓存与服务器）。 */
const listeners = new Set<() => void>()
/** 安装进行态（major → phase/message），供设置页轮询展示。 */
const installStates = new Map<number, { phase: LspEnvInstallState['phase']; message?: string }>()

/** 需求 id（与 envRequirements 的 id 一致）。 */
export function runtimeRequirementId(major: number): string {
  return 'dotnet-runtime:' + major
}

/** 当前安装进行态快照（edrv.lsp.envState 载荷）。 */
export function envInstallStates(): LspEnvInstallState[] {
  return [...installStates.entries()].map(([major, state]) => ({
    id: runtimeRequirementId(major),
    phase: state.phase,
    message: state.message,
  }))
}

/** 注册配置成功监听（成功后由 rpc 侧清缓存并重置服务器）。 */
export function onRuntimeProvisioned(listener: () => void): void {
  listeners.add(listener)
}

/** 平台 → 官方运行时资产文件名。 */
function assetNameFor(platform: string, arch: string): string {
  const archPart = arch === 'arm64' ? 'arm64' : 'x64'
  if (platform === 'win32') return 'dotnet-runtime-win-' + archPart + '.zip'
  if (platform === 'darwin') return 'dotnet-runtime-osx-' + archPart + '.tar.gz'
  return 'dotnet-runtime-linux-' + archPart + '.tar.gz'
}

/** 用户级 dotnet 安装目录（与 providers 的发现候选位置一致）。 */
export function userDotnetDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Microsoft', 'dotnet')
  }
  return join(homedir(), '.dotnet')
}

/** 从 release 元数据 files 里挑当前平台资产（纯函数，测试可注入平台）。 */
export function pickRuntimeAsset(files: RuntimeAsset[], platform = process.platform, arch = process.arch): RuntimeAsset | null {
  const name = assetNameFor(platform, arch)
  return files.find((f) => f.name === name) ?? null
}

/** 是否允许自动配置（测试隔离 + 显式开关）。 */
function allowed(): boolean {
  if (process.env.DSH_LSP_AUTO_RUNTIME === '0') return false
  if (process.env.DSH_LSP_EXT_DIRS) return false // 测试环境不下载
  return true
}

function setState(major: number, phase: LspEnvInstallState['phase'], message?: string): void {
  installStates.set(major, { phase, message })
}

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch { /* 单个监听失败不影响其它 */ }
  }
}

/**
 * 触发运行时自动配置（幂等：同 major 去重；失败 10 分钟退避；已满足则直接成功回调）。
 * 静默自动路径与设置页一键安装共用；进度经 envInstallStates 暴露。
 * @author ddj 2026年09月03号
 * @param major 运行时大版本
 */
export function provisionRuntime(major: number): void {
  if (inFlight.has(major)) return
  const failed = failedAt.get(major)
  if (failed && Date.now() - failed < RETRY_MS) return
  const task = runProvision(major)
    .catch(() => false)
    .then((ok) => {
      inFlight.delete(major)
      if (ok) {
        failedAt.delete(major)
        setState(major, 'done')
        notifyListeners()
      } else {
        failedAt.set(major, Date.now())
        setState(major, 'failed')
      }
      return ok
    })
  inFlight.set(major, task)
}

/**
 * 一键安装入口（设置页按钮）：校验允许后触发 provisionRuntime。
 * @author ddj 2026年09月03号
 * @param major 运行时大版本
 * @returns 是否成功启动（已满足/进行中/被禁用时返回 false）
 */
export function startEnvInstall(major: number): boolean {
  if (dotnetWithRuntime(major)) {
    setState(major, 'done')
    return false
  }
  if (!allowed() || inFlight.has(major)) return false
  const failed = failedAt.get(major)
  if (failed && Date.now() - failed < RETRY_MS && installStates.get(major)?.phase === 'failed') {
    // 退避期内失败态：允许用户手动重试（清除退避标记）
    failedAt.delete(major)
  }
  provisionRuntime(major)
  return inFlight.has(major)
}

async function runProvision(major: number): Promise<boolean> {
  if (dotnetWithRuntime(major)) return true
  setState(major, 'downloading')
  const meta = await fetchJson(META_BASE + '/' + major + '.0/releases.json')
  const release = meta?.releases?.[0]
  const files = release?.runtime?.files
  if (!Array.isArray(files)) return false
  const asset = pickRuntimeAsset(files as RuntimeAsset[])
  if (!asset?.url || !asset.hash) return false
  const buf = await downloadVerified(asset.url, asset.hash)
  if (!buf) return false
  setState(major, 'extracting')
  const dir = userDotnetDir()
  const created = !existsSync(dir)
  try {
    const ok = await extractTo(buf, dir)
    if (!ok) throw new Error('解压失败')
  } catch (error) {
    if (created) rmSync(dir, { recursive: true, force: true })
    return false
  }
  return dotnetWithRuntime(major) !== null
}

/** 拉取 JSON（30s 超时，失败返回 null）。 */
async function fetchJson(url: string): Promise<{ releases?: { runtime?: { files?: unknown } }[] } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** 下载并按官方 sha512 校验（5 分钟超时，不匹配返回 null）。 */
async function downloadVerified(url: string, sha512: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(300000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    const actual = createHash('sha512').update(buf).digest('hex').toLowerCase()
    return actual === sha512.toLowerCase() ? buf : null
  } catch {
    return null
  }
}

/** 解压到目录：win 走 zip（PK 头），unix 落临时包交系统 tar。 */
async function extractTo(buf: Buffer, dir: string): Promise<boolean> {
  mkdirSync(dir, { recursive: true })
  if (buf.subarray(0, 2).toString('ascii') === 'PK') {
    for (const entry of unzip(buf)) {
      if (!entry.path || entry.path.startsWith('..')) continue
      const parts = entry.path.split(/[\\/]/).filter((p) => p && p !== '..' && p !== '.')
      if (!parts.length) continue
      const target = join(dir, ...parts)
      if (entry.isDirectory) {
        mkdirSync(target, { recursive: true })
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, entry.data)
    }
    return true
  }
  const tmp = join(tmpdir(), 'dsh-dotnet-' + Date.now() + '.tar.gz')
  try {
    writeFileSync(tmp, buf)
    return await new Promise<boolean>((resolve) => {
      const child = spawn('tar', ['-xzf', tmp, '-C', dir], { stdio: 'ignore' })
      child.on('exit', (code) => resolve(code === 0))
      child.on('error', () => resolve(false))
    })
  } finally {
    rmSync(tmp, { force: true })
  }
}
