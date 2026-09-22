/**
 * dsh-vscode-mode host — ripgrep 文件发现 provider。
 * 通过独立 argv 调用打包 rg，避免先构建巨型全量文件数组。
 * 作者 ddj 2026年08月24号
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { Ctx, Session } from '../store.js'
import { policyOf } from '../store.js'
import { prepareQuery, pathText } from './query.js'
import type { WorkspaceSearchInput, WorkspaceSearchProvider, WorkspaceSearchResult } from './types.js'

const STDOUT_CAP = 4 << 20
const STDERR_CAP = 64 << 10
const GRACE_MS = 20_000

/**
 * 默认排除目录（文件/内容搜索共用，导出供 provider 复用）。
 * 语义为**大小写敏感**的路径段匹配：`build` 只排除小写构建产物目录，
 * 不得用 `--glob-case-insensitive` 之类的全局开关，「Module/Build」这类
 * 源码目录（如 IslandSplash 的 Module/Build/Logic）必须保持可搜索。
 */
export const EXCLUDES = [
  'node_modules', '.git', '.tmp', '.cache', 'dist', 'build', 'vendor',
  'coverage', '__pycache__', '.pnpm-store', '.npm-cache', '.codegraph', '.workbuddy',
]

/**
 * 默认排除文件（glob 模式，文件/内容搜索共用）。
 * 插件自身 sidecar（内容搜索会命中其历史编辑文本，且单行巨型 JSON 会撑爆输出上限）；
 * *.map 源映射（纯构建产物，内容搜索无意义且常为单行巨文件）。
 */
export const FILE_EXCLUDES = [
  '**/.dsh-edit-review.json',
  '**/.dsh-edit-review-archive.json',
  '**/.dsh-edit-review-debug.log',
  '**/*.map',
]

interface SearchHandle {
  done: Promise<{ exitCode: number | null; code?: number | null }>
  collected?: {
    stdout?: { readFrom(offset: number): { text: string; lossy?: boolean } }
    stderr?: { readFrom(offset: number): { text: string } }
  }
}

interface SearchSubprocess {
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: { stdin: 'ignore'; stdout: { maxBytes: number }; stderr: { maxBytes: number } }
    graceMs: number
    signal?: AbortSignal
  }): SearchHandle
}

/**
 * 将查询文本转成大小写不敏感的 rg 正选 glob。
 * 逐字符把有大小写的字母展开成 `[aA]` 字符类，**不用**大小写不敏感开关：
 * ① 全局 `--glob-case-insensitive` 会把 `-g/--glob` 全部当成 `--iglob`，
 *    连带让 `!**\/build/**` 大小写不敏感，从而排除 `Module/Build/` 这类源码目录
 *    （Ctrl+P 搜 BuildLogic 恒「无匹配文件」）；
 * ② 把查询词改用 `--iglob` 也不行——rg 的正选 glob 会覆盖全部黑名单 glob，
 *    node_modules/.git 等排除项集体失效。
 * 字符类方案同时满足「查询不区分大小写」且「排除项保持大小写敏感」。
 * @author ddj 2026年08月24号 / 2026年09月20号
 * @param query 已规范化查询文本
 * @returns 安全 glob
 */
export function queryGlob(query: string): string {
  const value = pathText(query)
  let body = ''
  for (const char of value) {
    const lower = char.toLowerCase()
    const upper = char.toUpperCase()
    // 有大小写之分的字符（单字符映射，避开 ß→SS 这类长度变化）→ 字符类
    if (lower !== upper && lower.length === 1 && upper.length === 1) {
      body += '[' + lower + upper + ']'
      continue
    }
    body += /[\*?\[\]{}!]/.test(char) ? '\\' + char : char
  }
  return '**/*' + body + '*'
}

/**
 * 返回当前平台的 rg 可执行文件路径，不让可选依赖影响模块加载。
 * @author ddj 2026年08月24号
 * @returns rg 路径或 null
 */
export function ripgrepPath(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const ripgrep = require('@vscode/ripgrep') as { rgPath?: unknown }
    if (typeof ripgrep.rgPath !== 'string' || !existsSync(ripgrep.rgPath)) return null
    return join(ripgrep.rgPath)
  } catch (error) {
    return null
  }
}

/**
 * 解析会话搜索根目录，并转换到 subprocess 执行世界。
 * @author ddj 2026年08月24号
 * @param ctx DSH 上下文
 * @param session 当前会话
 * @returns subprocess 可访问的根目录
 */
export async function searchRoot(ctx: Ctx, session: Session): Promise<string> {
  const fs = ctx.get('fs')
  if (!fs) throw new Error('缺少 fs')
  const policy = policyOf(ctx, session)
  const cwd = session?.header?.cwd
  const rootTarget = await fs.resolve(policy?.workspaceRoot ?? '.', cwd ? { cwd } : {})
  return fs.processPath(rootTarget)
}

/**
 * 读取收集输出并解析为路径候选。
 * @author ddj 2026年08月24号
 * @param handle subprocess handle
 * @param maxResults 候选上限
 * @returns 路径与完整性状态
 */
export function parseOutput(handle: SearchHandle, maxResults: number): { files: string[]; truncated: boolean; complete: boolean } {
  const reader = handle.collected?.stdout
  if (!reader) return { files: [], truncated: false, complete: false }
  const output = reader.readFrom(0)
  const values = output.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const unique = [...new Set(values)]
  const truncated = Boolean(output.lossy) || unique.length > maxResults
  return { files: unique.slice(0, maxResults).map(pathText), truncated, complete: !truncated }
}

/**
 * 读取已收集的 stderr（无收集器 → 空文本）。
 * @author ddj 2026年08月27号
 * @param handle subprocess handle
 * @returns stderr 文本
 */
export function readStderr(handle: SearchHandle): { text: string } {
  const reader = handle.collected?.stderr
  return reader ? reader.readFrom(0) : { text: '' }
}

/**
 * 取 stderr 首条非空行（去 \r，截断 300 字符防撑爆 UI）。
 * @author ddj 2026年08月27号
 * @param text stderr 全文
 * @returns 首条诊断行（无则空串）
 */
export function firstStderrLine(text: string): string {
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    return line.length > 300 ? line.slice(0, 300) + '…' : line
  }
  return ''
}

/**
 * 分类 rg 非 0/1 退出：pattern=模式错误（正则/glob 无效，无结果），
 * partial=遍历错误（rg 已输出的命中仍有效，结果不完整），hard=硬失败（其他退出码/超时被杀）。
 * @author ddj 2026年08月27号
 * @param code 退出码（null/undefined = 被终止，通常为 20s 超时）
 * @param stderrText stderr 全文
 * @returns 分类与中文提示文案（partial 的 message 即 warning 内容）
 */
export function rgExitFailure(code: number | null | undefined, stderrText: string): { kind: 'pattern' | 'partial' | 'hard'; message: string } {
  const detail = firstStderrLine(stderrText)
  if (/regex parse error/i.test(detail)) return { kind: 'pattern', message: '正则表达式无效：' + detail }
  if (/error parsing glob/i.test(detail)) return { kind: 'pattern', message: '文件过滤模式无效：' + detail }
  if (code === 2) {
    const count = String(stderrText ?? '').split(/\r?\n/).filter((line) => line.trim()).length
    const suffix = count > 1 ? '（共 ' + count + ' 处）' : ''
    return { kind: 'partial', message: (detail ? '部分路径无法访问，结果可能不完整：' + detail + suffix : '部分路径无法访问，结果可能不完整') }
  }
  if (code === null || code === undefined) return { kind: 'hard', message: '搜索超时（20 秒内未完成，已终止）' }
  return { kind: 'hard', message: 'ripgrep 退出码：' + String(code) + (detail ? '（' + detail + '）' : '') }
}

/**
 * 构造文件搜索 rg argv（查询 glob 大小写不敏感，排除 glob 大小写敏感）。
 * 大小写不敏感**只能**靠 queryGlob 的字符类实现：全局 `--glob-case-insensitive`
 * 会波及排除项（误排除 `Module/Build/`），查询词用 `--iglob` 又会覆盖全部黑名单 glob。
 * @author ddj 2026年09月20号
 * @param binary rg 可执行文件路径
 * @param root 搜索根目录
 * @param query 已规范化查询文本
 * @returns 完整 argv（末位为根目录）
 */
export function filesArgv(binary: string, root: string, query: string): string[] {
  const argv = [binary, '--no-config', '--files', '--hidden', '--no-ignore', '--glob', queryGlob(query)]
  for (const excluded of EXCLUDES) argv.push('--glob', '!**/' + excluded + '/**')
  for (const excluded of FILE_EXCLUDES) argv.push('--glob', '!' + excluded)
  argv.push('--', root)
  return argv
}

/**
 * 使用打包 ripgrep 搜索工作区文件。
 * @author ddj 2026年08月24号
 * @param input provider 输入
 * @returns 有界搜索结果
 */
export async function searchRipgrep(input: WorkspaceSearchInput): Promise<WorkspaceSearchResult> {
  const sub = input.ctx.get('subprocess') as SearchSubprocess | undefined
  if (!sub) throw new Error('缺少 subprocess')
  const binary = ripgrepPath()
  if (!binary) throw new Error('ripgrep 不可用')
  const root = input.root ?? await searchRoot(input.ctx, input.session)
  const query = prepareQuery(input.query)
  const handle = sub.spawn({
    argv: filesArgv(binary, root, query.text),
    cwd: root,
    stdio: { stdin: 'ignore', stdout: { maxBytes: STDOUT_CAP }, stderr: { maxBytes: STDERR_CAP } },
    graceMs: GRACE_MS,
    signal: input.signal,
  })
  let outcome: { exitCode: number | null; code?: number | null }
  try {
    outcome = await handle.done
  } catch (error) {
    throw new Error('ripgrep 启动失败：' + String(error))
  }
  const code = outcome.exitCode ?? outcome.code
  if (code !== 0 && code !== 1) {
    const failure = rgExitFailure(code, readStderr(handle).text)
    if (failure.kind !== 'partial') throw new Error(failure.message)
    // 遍历错误：已收集的文件列表仍有效，保留并标记不完整（warning 供上层展示，编排层丢弃不抛错）
    const parsed = parseOutput(handle, input.maxResults)
    return { ...parsed, warning: failure.message, complete: false, source: 'ripgrep' }
  }
  const parsed = parseOutput(handle, input.maxResults)
  if (!handle.collected?.stdout) throw new Error('ripgrep stdout 不可用')
  return { ...parsed, source: 'ripgrep' }
}

/**
 * 构造 chunkname 定向查找的 rg argv。
 * 与 {@link filesArgv} 同源（同样的排除 glob 与大小写口径），差异只在查询 glob 由
 * chunkname 推导：chunkname 可能带 chunk 前缀（`@`）与无扩展名 stem，故先剥 `@`、
 * 取 basename、去掉扩展名后作为片段匹配，仍走 {@link queryGlob} 的字符类方案
 * ——避免 `--glob-case-insensitive` 波及排除项（见 queryGlob 注释）。
 * @author ddj 2026年09月21号
 * @param binary rg 可执行文件路径
 * @param root 搜索根目录
 * @param chunk 适配器上报的 chunkname
 * @returns 完整 argv（末位为根目录）；chunk 为空时返回 null
 */
export function chunkFilesArgv(binary: string, root: string, chunk: string): string[] | null {
  const clean = normalizeChunk(chunk)
  if (!clean) return null
  const argv = [binary, '--no-config', '--files', '--hidden', '--no-ignore', '--glob', queryGlob(clean)]
  for (const excluded of EXCLUDES) argv.push('--glob', '!**/' + excluded + '/**')
  for (const excluded of FILE_EXCLUDES) argv.push('--glob', '!' + excluded)
  argv.push('--', root)
  return argv
}

/**
 * chunkname → 用于片段匹配的纯文件名片段。
 * 剥 `@` 前缀、统一分隔符、取 basename、去掉扩展名（xLua chunkname 惯例不含扩展名），
 * 使 `GuideSystemMgr` 能命中 `GuideSystemMgr.lua`。
 * @author ddj 2026年09月21号
 * @param chunk 适配器上报的 chunkname
 * @returns 纯片段（空输入返回空串）
 */
export function normalizeChunk(chunk: string): string {
  const text = String(chunk ?? '').replace(/^@/, '').replaceAll('\\', '/').trim()
  if (!text) return ''
  const base = text.split('/').pop() ?? ''
  return base.replace(/\.[^.]+$/, '')
}

/**
 * 按 chunkname 定向查找工作区文件（DAP findFile 反向匹配专用）。
 *
 * 为什么不用工作区全量文件索引：22 万文件的 Unity 工程里，全量枚举按到达序截断，
 * `Assets/Scripts/Lua/**` 会被 `GameData`/`Entitas` 等目录挤出配额，导致断点命中后
 * 无法定位源文件（实测前 6000 条中 .lua 数为 0）。此处改为让 rg 在遍历时过滤，
 * 命中规模与工作区总规模无关（实测同一工作区 0.37s 返回正确结果）。
 * @author ddj 2026年09月21号
 * @param ctx DSH 上下文
 * @param root 工作区根（subprocess 可访问路径）
 * @param chunk 适配器上报的 chunkname
 * @param maxResults 候选上限
 * @returns 绝对路径候选（任何失败都返回空数组，不抛错）
 */
export async function findFilesByChunk(ctx: Ctx, root: string, chunk: string, maxResults = 50): Promise<string[]> {
  const sub = ctx.get('subprocess') as SearchSubprocess | undefined
  const binary = ripgrepPath()
  if (!sub || !binary || !root) return []
  const argv = chunkFilesArgv(binary, root, chunk)
  if (!argv) return []
  let handle: SearchHandle
  try {
    handle = sub.spawn({
      argv,
      cwd: root,
      stdio: { stdin: 'ignore', stdout: { maxBytes: STDOUT_CAP }, stderr: { maxBytes: STDERR_CAP } },
      graceMs: GRACE_MS,
    })
  } catch (error) {
    return []
  }
  let code: number | null | undefined
  try {
    const outcome = await handle.done
    code = outcome.exitCode ?? outcome.code
  } catch (error) {
    return []
  }
  // 0=有命中 1=无命中 2=部分不可访问（已收集结果仍有效）：其余视为失败
  if (code !== 0 && code !== 1 && code !== 2) return []
  return parseOutput(handle, maxResults).files
}

/**
 * 构造 ripgrep provider。
 * @author ddj 2026年08月24号
 * @returns provider 实例
 */
export function newRgProvider(): WorkspaceSearchProvider {
  return { search: searchRipgrep }
}
