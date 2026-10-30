/**
 * 版本库导入：把工作副本相对基线的改动读成待审条目，来源对齐 dsh-diff-approval 的 vcs 内核（MIT）。
 * 只读命令，不修改工作副本；基线读取失败一律上报，不猜"文件不存在"。
 * @author ddj 2026年10月30号
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

/** 支持的版本库种类。 */
export type VcsKind = 'git' | 'svn' | 'p4'

/** 探测结果。 */
export interface VcsRoot {
  kind: VcsKind
  root: string
}

/** 一条导入改动：相对基线的旧内容与当前内容（删除时当前内容为 null）。 */
export interface VcsChange {
  path: string
  earlierVersion: 'file' | 'none'
  oldText: string
  newText: string | null
}

/** 导入选项。 */
export interface VcsImportOptions {
  includeUntracked?: boolean
  path?: string
}

/** shell 能力最小面（便于单测注入）。 */
export interface ShellLike {
  resolve(request: { command: string; workdir?: string; timeoutMs?: number; stdoutMaxBytes?: number; sandboxPolicy?: unknown }): unknown
  execute(spec: unknown): Promise<{ result(): Promise<{ exitCode: number | null; timedOut: boolean; aborted: boolean; stdout: { text: string }; stderr: { text: string } }> }>
}

/** 命令超时：与上游一致，避免大仓 status 卡死。 */
const COMMAND_TIMEOUT = 60_000
/** stdout 预算：够放一个常见源文件，超出交给上游判断为超大。 */
const STDOUT_BUDGET = 8 * 1024 * 1024
/** 只有这些 git 报错才算"该版本不存在"，其余一律抛出。 */
const ABSENT_AT_REVISION = /does not exist in|exists on disk, but not in|not a valid object name|invalid object name|unknown revision|bad revision/i
/** 只有这些 P4 报错才算"该版本不存在"，其余一律抛出。 */
const P4_ABSENT_AT_REVISION = /no such file|not opened|does not exist|no file\(s\) to print|invalid file|no revisions/i
/** git 相对路径用正斜杠。 */
const GIT_SEPARATOR = '/'

/**
 * @author ddj 2026年10月30号
 * @description: 向上查找版本库根目录，同目录 git 优先于 svn，最后才是 Perforce 配置。
 * @param cwd 工作区
 * @returns 探测结果，未找到时 undefined
 */
export async function detectVcsRoot(cwd: string): Promise<VcsRoot | undefined> {
  let current = resolve(cwd)
  for (;;) {
    const git = await exists(join(current, '.git'))
    if (git) return { kind: 'git', root: current }
    if (await exists(join(current, '.svn'))) return { kind: 'svn', root: current }
    if (await isP4Root(current)) return { kind: 'p4', root: current }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * @author ddj 2026年10月30号
 * @description: 判断目录是否是 Perforce 工作区根（P4CONFIG 文件所在目录）。
 * @param dir 目录
 * @returns 是否 P4 根
 */
async function isP4Root(dir: string): Promise<boolean> {
  return (await exists(join(dir, '.p4config'))) || (await exists(join(dir, '.p4config.txt')))
}

/**
 * @author ddj 2026年10月30号
 * @description: 读出当前工作副本相对基线的改动，只返回给定范围（含未跟踪按选项）。
 * @param shell shell 能力
 * @param cwd 工作区
 * @param options 导入选项
 * @returns 改动列表
 */
export async function importVcsChanges(shell: ShellLike, cwd: string, options: VcsImportOptions = {}): Promise<VcsChange[]> {
  const detected = await detectVcsRoot(cwd)
  if (!detected) return []
  const changes = await readChanges(shell, detected, cwd, options)
  const only = options.path ? resolve(cwd, options.path) : undefined
  return changes.filter((change) => !only || samePath(change.path, only))
}

/**
 * @author ddj 2026年10月30号
 * @description: 按探测到的种类取改动，新增种类只在这里分流。
 * @param shell shell 能力
 * @param detected 版本库种类与根目录
 * @param cwd 工作区
 * @param options 导入选项
 * @returns 改动列表
 */
async function readChanges(shell: ShellLike, detected: VcsRoot, cwd: string, options: VcsImportOptions): Promise<VcsChange[]> {
  if (detected.kind === 'git') return gitChanges(shell, cwd, detected.root, options)
  if (detected.kind === 'svn') return svnChanges(shell, cwd, detected.root, options)
  return p4Changes(shell, cwd, detected.root, options)
}

/**
 * @author ddj 2026年10月30号
 * @description: git 改动：status -z 解析状态，基线取 HEAD 版本，未跟踪可按选项导入为新建。
 * @param shell shell 能力
 * @param cwd 工作区
 * @param root 仓库根
 * @param options 导入选项
 * @returns 改动列表
 */
async function gitChanges(shell: ShellLike, cwd: string, root: string, options: VcsImportOptions): Promise<VcsChange[]> {
  const command = 'git -c status.renames=false status --porcelain=v1 -z --untracked-files=all'
  const status = await runCommand(shell, command, root)
  if (!status.ok) throw new Error('git status 失败：' + status.stderr.slice(0, 200))
  const changes: VcsChange[] = []
  for (const entry of parseGitStatus(status.stdout)) {
    if (entry.status === '??' && !options.includeUntracked) continue
    const absolute = join(root, ...entry.path.split(GIT_SEPARATOR))
    if (!insideRoot(root, absolute)) continue
    const current = await readTextOf(absolute)
    if (entry.status === '??' || entry.status === 'A ') {
      changes.push({ path: absolute, earlierVersion: 'none', oldText: '', newText: current })
      continue
    }
    // 版本里确实没有该文件时按新建导入（earlierVersion='none'），不能丢掉这条改动
    const baseline = await gitBaseline(shell, root, entry.path)
    changes.push({
      path: absolute,
      earlierVersion: baseline === null ? 'none' : 'file',
      oldText: baseline ?? '',
      newText: current,
    })
  }
  return changes
}

/**
 * @author ddj 2026年10月30号
 * @description: svn 改动：status --xml 解析状态，基线取 BASE 版本。
 * @param shell shell 能力
 * @param cwd 工作区
 * @param root 工作副本根
 * @param options 导入选项
 * @returns 改动列表
 */
async function svnChanges(shell: ShellLike, cwd: string, root: string, options: VcsImportOptions): Promise<VcsChange[]> {
  const status = await runCommand(shell, 'svn status --xml', root)
  if (!status.ok) throw new Error('svn status 失败：' + status.stderr.slice(0, 200))
  const changes: VcsChange[] = []
  for (const entry of parseSvnStatus(status.stdout)) {
    if (entry.status === 'unversioned' && !options.includeUntracked) continue
    const absolute = resolve(root, entry.path)
    if (!insideRoot(root, absolute)) continue
    const current = await readTextOf(absolute)
    if (entry.status === 'added' || entry.status === 'unversioned' || entry.status === 'replaced') {
      changes.push({ path: absolute, earlierVersion: 'none', oldText: '', newText: current })
      continue
    }
    const baseline = await svnBaseline(shell, root, entry.path)
    changes.push({ path: absolute, earlierVersion: 'file', oldText: baseline, newText: current })
  }
  return changes
}

/**
 * @author ddj 2026年10月30号
 * @description: 取 HEAD 版本内容；仅"该版本确实没有此文件"时返回 null，其余失败抛出。
 * @param shell shell 能力
 * @param root 仓库根
 * @param relative 仓库相对路径（正斜杠）
 * @returns 基线内容或 null
 */
async function gitBaseline(shell: ShellLike, root: string, relative: string): Promise<string | null> {
  const size = await runCommand(shell, `git cat-file -s HEAD:${quote(relative)}`, root)
  const budget = size.ok ? Number(size.stdout.trim()) + 1024 : STDOUT_BUDGET
  const shown = await runCommand(shell, `git show HEAD:${quote(relative)}`, root, Math.min(budget, STDOUT_BUDGET))
  if (shown.ok) return shown.stdout
  if (ABSENT_AT_REVISION.test(shown.stderr)) return null
  throw new Error('读取 git 基线失败：' + shown.stderr.slice(0, 200))
}

/**
 * @author ddj 2026年10月30号
 * @description: 取 svn BASE 版本内容；失败一律抛出（svn 没有可靠的"不存在"判据）。
 * @param shell shell 能力
 * @param root 工作副本根
 * @param relative 相对路径
 * @returns 基线内容
 */
async function svnBaseline(shell: ShellLike, root: string, relative: string): Promise<string> {
  const shown = await runCommand(shell, `svn cat -r BASE ${quote(relative)}`, root)
  if (!shown.ok) throw new Error('读取 svn 基线失败：' + shown.stderr.slice(0, 200))
  return shown.stdout
}

/**
 * @author ddj 2026年10月30号
 * @description: Perforce 改动：opened（含 status 的未跟踪项）解析 depot 路径，再折成本地路径。
 * @param shell shell 能力
 * @param cwd 工作区
 * @param root P4 工作区根
 * @param options 导入选项
 * @returns 改动列表
 */
async function p4Changes(shell: ShellLike, cwd: string, root: string, options: VcsImportOptions): Promise<VcsChange[]> {
  const depotPaths = new Set<string>()
  const opened = await runCommand(shell, 'p4 opened', root)
  if (!opened.ok) throw new Error('p4 opened 失败：' + opened.stderr.slice(0, 200))
  for (const path of parseP4Opened(opened.stdout)) depotPaths.add(path)
  if (options.includeUntracked) {
    const status = await runCommand(shell, 'p4 status', root)
    if (!status.ok) throw new Error('p4 status 失败：' + status.stderr.slice(0, 200))
    for (const path of parseP4Status(status.stdout)) depotPaths.add(path)
  }
  const changes: VcsChange[] = []
  for (const depot of depotPaths) {
    const absolute = await p4LocalPath(shell, root, depot)
    if (!absolute || !insideRoot(root, absolute)) continue
    const current = await readTextOf(absolute)
    const baseline = await p4Baseline(shell, root, depot)
    changes.push({
      path: absolute,
      earlierVersion: baseline === null ? 'none' : 'file',
      oldText: baseline ?? '',
      newText: current,
    })
  }
  return changes
}

/**
 * @author ddj 2026年10月30号
 * @description: 解析 `p4 opened` 输出，只取 depot 路径（`//depot/x#3 - edit ...`）。
 * @param text 输出
 * @returns depot 路径列表
 */
function parseP4Opened(text: string): string[] {
  const paths: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\/\/[^#\s]+)#\d+/.exec(line.trim())
    if (match) paths.push(match[1]!)
  }
  return paths
}

/**
 * @author ddj 2026年10月30号
 * @description: 解析 `p4 status` 输出；每行以本地路径或 depot 路径开头，取路径本身。
 * @param text 输出
 * @returns depot 或本地路径列表
 */
function parseP4Status(text: string): string[] {
  const paths: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('-')) continue
    const head = trimmed.split(/\s+-\s+/)[0]?.trim()
    if (!head) continue
    paths.push(head)
  }
  return paths
}

/**
 * @author ddj 2026年10月30号
 * @description: `p4 where` 把小写 depot 路径折成本地绝对路径。
 * @param shell shell 能力
 * @param root P4 工作区根
 * @param depot depot 路径
 * @returns 本地路径，失败时 undefined
 */
async function p4LocalPath(shell: ShellLike, root: string, depot: string): Promise<string | undefined> {
  if (depot.startsWith('//')) {
    const where = await runCommand(shell, `p4 where ${quote(depot)}`, root)
    if (!where.ok) return undefined
    // 形如 "//depot/x //client/x C:\work\x"
    const tokens = where.stdout.trim().split(/\s+/)
    return tokens[tokens.length - 1] ?? undefined
  }
  return resolve(root, depot)
}

/**
 * @author ddj 2026年10月30号
 * @description: 取 `#have` 版本内容；只有明确"没有该版本"时返回 null，其余失败抛出。
 * @param shell shell 能力
 * @param root P4 工作区根
 * @param depot depot 路径
 * @returns 基线内容或 null
 */
async function p4Baseline(shell: ShellLike, root: string, depot: string): Promise<string | null> {
  if (!depot.startsWith('//')) return null
  const printed = await runCommand(shell, `p4 print -q ${quote(depot + '#have')}`, root)
  if (printed.ok) return printed.stdout
  if (P4_ABSENT_AT_REVISION.test(printed.stderr)) return null
  throw new Error('读取 p4 基线失败：' + printed.stderr.slice(0, 200))
}

/**
 * @author ddj 2026年10月30号
 * @description: 解析 git status -z 输出；重命名/复制记录按目标路径处理。
 * @param text -z 输出
 * @returns 状态与仓库相对路径
 */
function parseGitStatus(text: string): Array<{ status: string; path: string }> {
  const parts = text.split('\0').filter((part) => part.length > 2)
  const entries: Array<{ status: string; path: string }> = []
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!
    const status = part.slice(0, 2)
    const path = part.slice(3)
    // 重命名/复制后紧跟原路径，跳过它
    if (status.includes('R') || status.includes('C')) index++
    entries.push({ status, path })
  }
  return entries
}

/**
 * @author ddj 2026年10月30号
 * @description: 解析 svn status --xml 输出。
 * @param xml xml 文本
 * @returns 条目状态与相对路径
 */
function parseSvnStatus(xml: string): Array<{ status: string; path: string }> {
  const entries: Array<{ status: string; path: string }> = []
  const pattern = /<entry\s+path="([^"]+)"([\s\S]*?)<\/entry>/g
  for (const match of xml.matchAll(pattern)) {
    const status = /<wc-status[^>]*\sitem="([^"]+)"/.exec(match[2] ?? '')?.[1]
    if (status) entries.push({ status, path: decodeXml(match[1]!) })
  }
  return entries
}

/**
 * @author ddj 2026年10月30号
 * @description: 执行一条只读命令并收集输出；超时/取消/非零退出都回 ok=false，不抛出。
 * @param shell shell 能力
 * @param command 命令
 * @param workdir 工作目录
 * @param stdoutMaxBytes stdout 预算
 * @returns 输出与状态
 */
async function runCommand(
  shell: ShellLike, command: string, workdir: string, stdoutMaxBytes = STDOUT_BUDGET,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const spec = shell.resolve({ command, workdir, timeoutMs: COMMAND_TIMEOUT, stdoutMaxBytes })
    const execution = await shell.execute(spec)
    const result = await execution.result()
    return {
      ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
      stdout: result.stdout.text,
      stderr: result.stderr.text,
    }
  } catch (error) {
    return { ok: false, stdout: '', stderr: String(error) }
  }
}

/**
 * @author ddj 2026年10月30号
 * @description: 读单元格文本，不存在时返回 null。
 * @param path 文件路径
 * @returns 内容或 null
 */
async function readTextOf(path: string): Promise<string | null> {
  try {
    const fileStat = await stat(path)
    if (!fileStat.isFile()) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * @author ddj 2026年10月30号
 * @description: 判断路径是否存在。
 * @param path 路径
 * @returns 是否存在
 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * @author ddj 2026年10月30号
 * @description: 判断目标是否位于仓库根之内（Windows 下按大小写不敏感比较）。
 * @param root 仓库根
 * @param target 目标绝对路径
 * @returns 是否在根内
 */
function insideRoot(root: string, target: string): boolean {
  const normalize = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const rootKey = normalize(resolve(root)).replace(/[\\/]+$/, '') + sep
  return normalize(resolve(target)).startsWith(rootKey)
}

/**
 * @author ddj 2026年10月30号
 * @description: 比较两个路径是否同一文件（Windows 下大小写不敏感）。
 * @param left 路径
 * @param right 路径
 * @returns 是否相同
 */
function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)
  return normalize(resolve(left)) === normalize(resolve(right))
}

/**
 * @author ddj 2026年10月30号
 * @description: 为 shell 命令参数加引号，避免空格与特殊字符改变命令含义。
 * @param value 参数
 * @returns 加引号后的参数
 */
function quote(value: string): string {
  return '"' + value.replace(/"/g, '\\"') + '"'
}

/**
 * @author ddj 2026年10月30号
 * @description: 还原 xml 实体（svn status 会转义非 ASCII 与空格）。
 * @param value 属性值
 * @returns 解码后的路径
 */
function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}
