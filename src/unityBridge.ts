/**
 * dsh-vscode-mode host — Unity 内嵌包一键安装/更新。
 * 机制：把包源目录 unity/com.dsh.editor 复制为 <Unity项目根>/Packages/com.dsh.editor
 * （Unity 内嵌包自动发现，无需改 manifest.json）；安装/更新同入口（整目录替换）；
 * 卸载 = 删除目标目录。登记清单存 ~/.dsh/dsh-vscode-mode/unity-projects.json。
 * 安全：只触碰固定目标目录；项目根须含 Assets + ProjectSettings；目标已存在且
 * package.json name 不是本包 → 拒绝覆盖。纯路径构造与项目特征判定可单测。
 * 作者 ddj 2026-09-07
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome, PLUGIN_ID } from './paths.js'
import { UNITY_PACKAGE_NAME } from './shared/integration.js'
import type { UnityListPayload, UnityProjectEntry } from './shared/integration.js'

/** Unity 项目特征目录。 */
const UNITY_MARKERS = ['Assets', 'ProjectSettings']
/** 登记清单文件名。 */
const PROJECTS_FILE = 'unity-projects.json'
/** 包源目录相对插件包根的位置。 */
const UNITY_DIR_NAME = 'unity'

/**
 * 包源目录（随插件包分发的 unity/com.dsh.editor 绝对路径）。
 * @author ddj 2026年09月07号
 * @param moduleUrl 模块 URL（缺省 import.meta.url；测试注入）
 * @returns 包源目录绝对路径
 */
export function unitySourceDir(moduleUrl: string = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), '..', UNITY_DIR_NAME, UNITY_PACKAGE_NAME)
}

/**
 * 项目登记清单文件（~/.dsh/dsh-vscode-mode/unity-projects.json）。
 * @author ddj 2026年09月07号
 * @param home DSH home（测试可注入）
 * @returns 清单文件绝对路径
 */
export function unityProjectsFile(home = dshHome()): string {
  return join(home, PLUGIN_ID, PROJECTS_FILE)
}

/**
 * 归一化用户输入的项目根：去首尾空白/引号/尾部分隔符。
 * @author ddj 2026年09月07号
 * @param raw 原始输入
 * @returns 归一化绝对路径
 */
export function normalizeUnityRoot(raw: string): string {
  return String(raw ?? '').trim().replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '')
}

/**
 * 目录名清单是否满足 Unity 项目特征（Assets + ProjectSettings 同时存在）。
 * @author ddj 2026年09月07号
 * @param entries 项目根下的目录名清单
 * @returns 是否 Unity 项目根
 */
export function isUnityProject(entries: string[]): boolean {
  return UNITY_MARKERS.every((marker) => entries.includes(marker))
}

/**
 * 内嵌包目标目录（固定：<root>/Packages/com.dsh.editor）。
 * @author ddj 2026年09月07号
 * @param root Unity 项目根
 * @returns 目标目录绝对路径
 */
export function unityTargetOf(root: string): string {
  return join(root, 'Packages', UNITY_PACKAGE_NAME)
}

/**
 * 读 package.json 的 version（缺失/非法 → null）。
 * @author ddj 2026年09月07号
 * @param pkgFile package.json 绝对路径
 * @returns 版本号或 null
 */
export async function readPackageVersion(pkgFile: string): Promise<string | null> {
  try {
    const data = JSON.parse(await readFile(pkgFile, 'utf8')) as { version?: unknown }
    return typeof data?.version === 'string' && data.version ? data.version : null
  } catch {
    return null
  }
}

/** 登记清单单条记录。 */
interface ProjectRecord { path: string; addedAt: string }

/** 读登记清单（缺失/非法 → 空数组）。 */
async function readProjects(home = dshHome()): Promise<ProjectRecord[]> {
  try {
    const data: unknown = JSON.parse(await readFile(unityProjectsFile(home), 'utf8'))
    if (!Array.isArray(data)) return []
    return (data as unknown[])
      .filter((item): item is ProjectRecord => !!item && typeof (item as ProjectRecord).path === 'string')
      .map((item) => ({ path: String(item.path), addedAt: String(item.addedAt ?? '') }))
  } catch {
    return []
  }
}

/** 写登记清单（父目录按需创建）。 */
async function writeProjects(records: ProjectRecord[], home = dshHome()): Promise<void> {
  const file = unityProjectsFile(home)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(records, null, 2) + '\n', 'utf8')
}

/**
 * 单个项目的安装状态视图（版本对比 + 合法性）。
 * @author ddj 2026年09月07号
 * @param rawPath 项目路径（原始输入）
 * @param moduleUrl 模块 URL（测试注入）
 * @returns 项目状态
 */
export async function unityEntryOf(rawPath: string, moduleUrl: string = import.meta.url): Promise<UnityProjectEntry> {
  const root = normalizeUnityRoot(rawPath)
  const entry: UnityProjectEntry = { path: root, title: basename(root) || root, installedVersion: null, upToDate: false, missingDir: false }
  let names: string[] = []
  try {
    names = await readdir(root)
  } catch {
    entry.missingDir = true
    return entry
  }
  if (!isUnityProject(names)) {
    entry.error = '不是 Unity 项目根（缺少 Assets 或 ProjectSettings 目录）'
    return entry
  }
  const installed = await readPackageVersion(join(unityTargetOf(root), 'package.json'))
  entry.installedVersion = installed
  const sourceVersion = await readPackageVersion(join(unitySourceDir(moduleUrl), 'package.json'))
  entry.upToDate = installed !== null && installed === sourceVersion
  return entry
}

/**
 * 列出登记项目与包源版本。
 * @author ddj 2026年09月07号
 * @param moduleUrl 模块 URL（测试注入）
 * @param home DSH home（测试注入）
 * @returns 列表载荷
 */
export async function unityList(moduleUrl: string = import.meta.url, home = dshHome()): Promise<UnityListPayload> {
  const source = unitySourceDir(moduleUrl)
  const records = await readProjects(home)
  const projects: UnityProjectEntry[] = []
  for (const record of records) projects.push(await unityEntryOf(record.path, moduleUrl))
  return { sourceVersion: await readPackageVersion(join(source, 'package.json')), sourcePath: source, projects }
}

/**
 * 登记一个 Unity 项目（校验通过才入清单，重复登记幂等）。
 * @author ddj 2026年09月07号
 * @param rawPath 项目路径（原始输入）
 * @param moduleUrl 模块 URL（测试注入）
 * @param home DSH home（测试注入）
 * @returns 项目状态
 */
export async function unityAdd(rawPath: string, moduleUrl: string = import.meta.url, home = dshHome()): Promise<UnityProjectEntry> {
  const root = normalizeUnityRoot(rawPath)
  const entry = await unityEntryOf(root, moduleUrl)
  if (entry.missingDir) throw new Error('目录不存在：' + root)
  if (entry.error) throw new Error(entry.error)
  const records = await readProjects(home)
  if (!records.some((record) => normalizeUnityRoot(record.path) === root)) {
    records.push({ path: root, addedAt: new Date().toISOString() })
    await writeProjects(records, home)
  }
  return entry
}

/**
 * 移除一个项目的登记（不删除已安装的包目录）。
 * @author ddj 2026年09月07号
 * @param rawPath 项目路径（原始输入）
 * @param home DSH home（测试注入）
 */
export async function unityRemove(rawPath: string, home = dshHome()): Promise<void> {
  const root = normalizeUnityRoot(rawPath)
  const records = await readProjects(home)
  await writeProjects(records.filter((record) => normalizeUnityRoot(record.path) !== root), home)
}

/**
 * 一键安装/更新：整目录替换 <root>/Packages/com.dsh.editor 为包源内容。
 * @author ddj 2026年09月07号
 * @param rawPath 项目路径（原始输入）
 * @param moduleUrl 模块 URL（测试注入）
 * @returns 安装后项目状态
 */
export async function unityInstall(rawPath: string, moduleUrl: string = import.meta.url): Promise<UnityProjectEntry> {
  const root = normalizeUnityRoot(rawPath)
  const source = unitySourceDir(moduleUrl)
  const target = unityTargetOf(root)
  await validateInstallTarget(root, source, target)
  await rm(target, { recursive: true, force: true })
  await mkdir(join(target, '..'), { recursive: true })
  await cp(source, target, { recursive: true })
  return unityEntryOf(root, moduleUrl)
}

/**
 * 安装前校验：Unity 项目根 + 目标不与包源重叠 + 已存在目标必须是本包。
 * @author ddj 2026年09月07号
 * @param root 项目根
 * @param source 包源目录
 * @param target 目标目录
 */
async function validateInstallTarget(root: string, source: string, target: string): Promise<void> {
  let names: string[] = []
  try {
    names = await readdir(root)
  } catch {
    throw new Error('目录不存在：' + root)
  }
  if (!isUnityProject(names)) throw new Error('不是 Unity 项目根（缺少 Assets 或 ProjectSettings 目录）')
  if (target === source || target.startsWith(source + sep) || source.startsWith(target + sep)) {
    throw new Error('目标目录与包源重叠，拒绝安装')
  }
  const text = await readFile(join(target, 'package.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (text === null) return
  let name: unknown = null
  try {
    name = (JSON.parse(text) as { name?: unknown }).name
  } catch { /* 解析失败按未知包处理 */ }
  if (name !== UNITY_PACKAGE_NAME) throw new Error('目标目录已存在且不是 DSH 包，拒绝覆盖：' + target)
}
