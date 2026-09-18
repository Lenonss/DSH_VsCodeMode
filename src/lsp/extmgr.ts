/**
 * dsh-vscode-mode host — VSIX 扩展管理器（extmgr）。
 * 管理 DSH 专属扩展目录（~/.dsh/dsh-vscode-mode/extensions/），支持：
 * 本地 .vsix 安装、Open VSX 市场搜索/下载安装、卸载、更新检测与安装。
 * 已装扩展作为 LSP provider 的"扩展源"（kind=extension），见 providers.ts。
 * 作者 ddj 2026-08-27
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { unzip, type ZipEntry } from './zip.js'
import { dshHome, PLUGIN_ID } from '../paths.js'

/** 单个已装扩展信息（edrv.lsp.ext.list 载荷元素）。 */
export interface ExtInfo {
  id: string        // publisher.name
  namespace: string
  name: string
  version: string
  displayName?: string
  description?: string
  dirName: string   // 目录名 publisher.name-version
  dir: string       // 绝对路径
}

/** Open VSX 市场搜索结果（edrv.lsp.ext.market 载荷元素）。 */
export interface MarketItem {
  namespace: string
  name: string
  id: string
  version: string
  displayName?: string
  description?: string
  download?: string
}

const OPEN_VSX = 'https://open-vsx.org'
const META_FILE = 'package.json'
/** 当前平台（与 VSCode platform 命名对齐：win32-x64/darwin-arm64/linux-x64）。 */
const PLATFORM = (() => {
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'win32-arm64' : 'win32-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
})()

/** DSH 专属扩展目录。 */
export function extensionsRoot(home = dshHome()): string {
  return join(home, PLUGIN_ID, 'extensions')
}

/** 从 VSIX 字节里读 extension/package.json 清单。 */
export function vsixManifest(vsix: Buffer): Record<string, unknown> {
  for (const entry of unzip(vsix)) {
    if (entry.path === 'extension/package.json' || entry.path === 'extension\\package.json') {
      return JSON.parse(entry.data.toString('utf8')) as Record<string, unknown>
    }
  }
  throw new Error('VSIX 缺少 extension/package.json')
}

/**
 * 判定解包路径是否为可执行入口（无 mode 时的启发式兜底）。
 * 只认确定语义：`bin/` 段下的文件、语言服务器/运行时常见可执行名、`.sh` 脚本。
 * @author ddj 2026年09月18号
 * @param rel 相对路径（/ 分隔）
 * @returns 是否应补执行位
 */
export function looksExec(rel: string): boolean {
  const path = String(rel ?? '').replace(/\\/g, '/')
  if (!path) return false
  if (path.split('/').includes('bin')) return true
  if (/\.(sh|bash|zsh)$/i.test(path)) return true
  const name = path.split('/').pop() ?? ''
  const base = name.replace(/\.exe$/i, '')
  return ['lua-language-server', 'emmylua_ls', 'OmniSharp', 'dotnet', 'node'].includes(base)
}

/**
 * 计算解包后要施加的权限位（纯函数，可单测）。
 * 优先信任归档自带的 Unix mode 中的执行位（VS Code 自身解 VSIX 即此口径）；
 * 归档无 mode（Windows 打包的 VSIX）时按路径启发式补 0o755；
 * 其余保持 undefined（交给 umask 默认，不越权改动）。
 * @author ddj 2026年09月18号
 * @param entry 解压条目
 * @returns 目标权限位；无需处理返回 undefined
 */
export function execModeOf(entry: ZipEntry): number | undefined {
  if (entry.isDirectory) return undefined
  const mode = entry.mode
  if (mode !== undefined && (mode & 0o111) !== 0) return mode
  return looksExec(entry.path) ? 0o755 : undefined
}

/**
 * 落盘后补可执行位（POSIX 专属；Windows 无此概念，直接跳过）。
 * 必须 best-effort：只读文件系统/无权限时不能拖垮整个扩展安装。
 * @author ddj 2026年09月18号
 * @param target 落盘绝对路径
 * @param entry 解压条目
 * @param platform 目标平台（测试注入）
 */
export function applyExecBit(target: string, entry: ZipEntry, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') return
  const mode = execModeOf(entry)
  if (mode === undefined) return
  try {
    chmodSync(target, mode)
  } catch (error) {
    /* 权限补不上不阻塞安装（后续 spawn 会给出真实错误） */
  }
}

/**
 * 解包 VSIX 到目录（仅取 extension/ 子树，剥前缀；返回清单）。
 * @author ddj 2026年08月27号 / 2026年09月18号
 * @param vsix vsix 字节
 * @param dest 目标目录（已存在则先清空）
 * @returns 清单对象
 */
export function unpackVsix(vsix: Buffer, dest: string): Record<string, unknown> {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  let manifest: Record<string, unknown> | null = null
  for (const entry of unzip(vsix)) {
    const rel = entry.path.replace(/^extension[\\/]/, '')
    if (!rel || entry.path.startsWith('..')) continue
    const safe = rel.split(/[\\/]/).filter((part) => part && part !== '..' && part !== '.').join('/')
    if (!safe) continue
    const target = join(dest, ...safe.split('/'))
    if (entry.isDirectory) {
      mkdirSync(target, { recursive: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.data)
    applyExecBit(target, entry)
    if (rel === 'package.json') manifest = JSON.parse(entry.data.toString('utf8')) as Record<string, unknown>
  }
  if (!manifest) throw new Error('VSIX 解包后缺少 package.json')
  return manifest
}

/** 扩展信息（清单 + 目录）。 */
export function extInfoOf(manifest: Record<string, unknown>, dir: string): ExtInfo {
  const namespace = String(manifest.publisher ?? 'unknown')
  const name = String(manifest.name ?? 'unknown')
  const version = String(manifest.version ?? '0.0.0')
  return {
    id: namespace + '.' + name,
    namespace,
    name,
    version,
    displayName: typeof manifest.displayName === 'string' ? manifest.displayName : undefined,
    description: typeof manifest.description === 'string' ? manifest.description : undefined,
    dirName: basename(dir),
    dir,
  }
}

/** 安装本地 .vsix 文件（已存在同 id 则升级替换）。 */
export async function installVsixFile(vsixPath: string, home = dshHome()): Promise<ExtInfo> {
  const vsix = readFileSync(vsixPath)
  return installVsixBuffer(vsix, home)
}

/** 安装 VSIX 字节（解包进 extensionsRoot；同名旧版本先清）。 */
export function installVsixBuffer(vsix: Buffer, home = dshHome()): ExtInfo {
  const manifest = vsixManifest(vsix)
  const info = extInfoOf(manifest, '')
  const target = join(extensionsRoot(home), info.id + '-' + info.version)
  const unpacked = unpackVsix(vsix, target)
  return extInfoOf(unpacked, target)
}
/** 扫描已装扩展目录。 */
export function listInstalled(home = dshHome()): ExtInfo[] {
  const root = extensionsRoot(home)
  if (!existsSync(root)) return []
  const out: ExtInfo[] = []
  for (const dir of readdirSync(root)) {
    const full = join(root, dir)
    const meta = join(full, META_FILE)
    if (!existsSync(meta)) continue
    try {
      const manifest = JSON.parse(readFileSync(meta, 'utf8')) as Record<string, unknown>
      out.push(extInfoOf(manifest, full))
    } catch (error) {
      /* 坏清单目录跳过 */
    }
  }
  return out
}

/** 卸载扩展（按 id）。 */
export function uninstall(id: string, home = dshHome()): boolean {
  const target = listInstalled(home).find((e) => e.id === id)?.dir
  if (!target) return false
  rmSync(target, { recursive: true, force: true })
  return true
}

/** Open VSX 单扩展元数据（latest + 下载 URL）。 */
export async function marketGet(namespace: string, name: string, version?: string): Promise<Record<string, unknown> | null> {
  const path = version ? namespace + '/' + name + '/' + version : namespace + '/' + name
  const res = await fetch(OPEN_VSX + '/api/' + path, { headers: { accept: 'application/json' } })
  if (!res.ok) return null
  return (await res.json()) as Record<string, unknown>
}

/** Open VSX 搜索。 */
export async function marketSearch(query: string, size = 12): Promise<MarketItem[]> {
  const url = OPEN_VSX + '/api/-/search?query=' + encodeURIComponent(query) + '&size=' + size
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error('市场搜索失败：HTTP ' + res.status)
  const data = (await res.json()) as { extensions?: unknown[] }
  return ((data.extensions ?? []) as Record<string, unknown>[]).map((item) => ({
    namespace: String(item.namespace ?? ''),
    name: String(item.name ?? ''),
    id: String(item.namespace ?? '') + '.' + String(item.name ?? ''),
    version: String(item.version ?? ''),
    displayName: typeof item.displayName === 'string' ? item.displayName : undefined,
    description: typeof item.description === 'string' ? item.description : undefined,
    download: typeof (item.files as { download?: unknown } | undefined)?.download === 'string' ? (item.files as { download: string }).download : undefined,
  }))
}

/** 平台匹配的 VSIX 下载 URL（探测平台变体，失败回退 API 默认）。 */
export async function resolveDownload(namespace: string, name: string, version: string): Promise<string> {
  const candidate = OPEN_VSX + '/api/' + namespace + '/' + name + '/' + PLATFORM + '/' + version +
    '/file/' + namespace + '.' + name + '-' + version + '@' + PLATFORM + '.vsix'
  try {
    const head = await fetch(candidate, { method: 'HEAD' })
    if (head.ok) return candidate
  } catch (error) {
    /* 探测失败走默认 */
  }
  const meta = await marketGet(namespace, name, version)
  const download = (meta?.files as { download?: unknown } | undefined)?.download
  if (typeof download === 'string') return download
  throw new Error('市场未提供 ' + namespace + '.' + name + '@' + version + ' 的下载地址')
}

/** 从 Open VSX 安装/更新扩展。 */
export async function installFromMarket(namespace: string, name: string, version?: string): Promise<ExtInfo> {
  const meta = await marketGet(namespace, name, version)
  if (!meta) throw new Error('市场找不到 ' + namespace + '.' + name + (version ? '@' + version : ''))
  const ver = version ?? String(meta.version ?? '')
  const url = await resolveDownload(namespace, name, ver)
  const res = await fetch(url)
  if (!res.ok) throw new Error('下载失败：HTTP ' + res.status)
  const vsix = Buffer.from(await res.arrayBuffer())
  return installVsixBuffer(vsix)
}

/** 更新已装扩展（对比市场最新版；返回 null 表示已最新）。 */
export async function updateExtension(id: string): Promise<ExtInfo | null> {
  const installed = listInstalled().find((e) => e.id === id)
  if (!installed) throw new Error('扩展未安装：' + id)
  const meta = await marketGet(installed.namespace, installed.name)
  const latest = String(meta?.version ?? '')
  if (!latest || latest === installed.version) return null
  return installFromMarket(installed.namespace, installed.name, latest)
}
