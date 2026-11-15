/**
 * dsh-vscode-mode host — 全局替换执行层（候选枚举 + 逐文件守卫写入）。
 *
 * 安全边界：
 * 1. 候选文件由 ripgrep `--files-with-matches` 枚举（复用搜索面板同一套排除/包含 glob），
 *    不自己遍历目录树；显式 `paths` 只用于「单文件替换」。
 * 2. 每个文件都按 `stat.version` 做 `replaceIfVersion` 守卫写入：写盘瞬间文件被外部改过
 *    就记为该文件冲突并继续，不覆盖别人的改动。
 * 3. 单文件 > 8MB、含 NUL 的二进制、非普通文件一律跳过并计入 skipped。
 * 4. `dryRun` 只统计不写盘（确认弹窗用），语义与真实执行完全同源（同一套 replaceInText）。
 *
 * @author ddj 2026年11月15号
 */
import { relative } from 'node:path'
import type { Ctx, Session } from '../store.js'
import { policyOf, resolveTarget } from '../store.js'
import { invalidateIndex } from '../treeIndex.js'
import { EXCLUDES, FILE_EXCLUDES, readStderr, rgExitFailure, ripgrepPath, searchRoot } from './ripgrep.js'
import { compileReplace, countInText, replaceInText } from './replacePlan.js'
import type { ReplaceQuery } from './replacePlan.js'

/** 单次替换最多处理的文件数（超出截断并提示）。 */
export const MAX_REPLACE_FILES = 200
/** 单文件大小上限（与 host 读文本上限一致）。 */
export const MAX_REPLACE_FILE_BYTES = 8 * 1024 * 1024
/** ripgrep 输出上限（候选路径列表，200 条接口上限远小于此）。 */
const STDOUT_CAP = 2 << 20
const STDERR_CAP = 64 << 10
const GRACE_MS = 20_000

/** 替换请求（RPC 入参）。 */
export interface ReplaceRequest extends ReplaceQuery {
  include?: string[]
  exclude?: string[]
  paths?: string[]
  dryRun?: boolean
}

/** 单个文件的替换结果。 */
export interface ReplaceFileChange {
  path: string
  replaced: number
}

/** 替换汇总。 */
export interface ReplaceOutcome {
  files: ReplaceFileChange[]
  totalFiles: number
  totalReplaced: number
  truncated: boolean
  dryRun: boolean
  skipped: number
  failed: Array<{ path: string; reason: string }>
  warning?: string
}

/** 执行输入。 */
export interface ReplaceRunInput {
  ctx: Ctx
  session: Session
  /** 会话工作区目录（invalidateIndex 的索引键）。 */
  cwd: string
  request: ReplaceRequest
  signal?: AbortSignal
}

interface SpawnHandle {
  done: Promise<{ exitCode: number | null; code?: number | null }>
  collected?: {
    stdout?: { readFrom(offset: number): { text: string; lossy?: boolean } }
    stderr?: { readFrom(offset: number): { text: string } }
  }
}

interface SpawnService {
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: { stdin: 'ignore'; stdout: { maxBytes: number }; stderr: { maxBytes: number } }
    graceMs: number
    signal?: AbortSignal
  }): SpawnHandle
}

/**
 * 构造「列出含命中文件」的 rg argv（与内容搜索同一套过滤口径）。
 * @author ddj 2026年11月15号
 * @param binary rg 路径
 * @param root 搜索根目录
 * @param request 替换请求
 * @returns argv 数组
 */
export function matchedFilesArgv(binary: string, root: string, request: ReplaceRequest): string[] {
  const argv = [binary, '--no-config', '--files-with-matches', '--hidden', '--no-ignore']
  argv.push(request.matchCase === true ? '--case-sensitive' : '--ignore-case')
  if (request.wholeWord === true) argv.push('--word-regexp')
  if (request.regex !== true) argv.push('--fixed-strings')
  for (const excluded of EXCLUDES) argv.push('--glob', '!**/' + excluded + '/**')
  for (const excluded of FILE_EXCLUDES) argv.push('--glob', '!' + excluded)
  for (const pattern of request.include ?? []) {
    const glob = String(pattern).trim()
    if (glob) argv.push('--glob', glob)
  }
  for (const pattern of request.exclude ?? []) {
    const glob = String(pattern).trim()
    if (glob) argv.push('--glob', '!' + glob)
  }
  argv.push('--', request.query, root)
  return argv
}

/**
 * 把 rg 输出的执行世界路径还原成工作区相对路径（统一 `/` 分隔）。
 * @author ddj 2026年11月15号
 * @param root 搜索根（执行世界路径）
 * @param candidate rg 输出的一行路径
 * @returns 相对路径；无法还原时返回空串
 */
export function relativeCandidate(root: string, candidate: string): string {
  const text = String(candidate ?? '').trim()
  if (!text) return ''
  const rel = relative(root, text).split('\\').join('/')
  if (rel === '' || rel.startsWith('../')) return ''
  return rel
}

/**
 * 需求：显式 paths 时直接用；否则用 rg 枚举含命中文件（有界）。
 * @author ddj 2026年11月15号
 * @param input 执行输入
 * @returns 相对路径列表与截断标记
 */
async function listCandidates(input: ReplaceRunInput): Promise<{ files: string[]; truncated: boolean; warning?: string }> {
  const explicit = (input.request.paths ?? []).map((path) => String(path ?? '').trim()).filter(Boolean)
  if (explicit.length > 0) {
    const unique = [...new Set(explicit)]
    return { files: unique.slice(0, MAX_REPLACE_FILES), truncated: unique.length > MAX_REPLACE_FILES }
  }

  const sub = input.ctx.get('subprocess') as SpawnService | undefined
  const binary = ripgrepPath()
  if (!sub || !binary) throw new Error('替换需要 ripgrep，但当前环境不可用')
  const root = await searchRoot(input.ctx, input.session)
  const handle = sub.spawn({
    argv: matchedFilesArgv(binary, root, input.request),
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
  let warning: string | undefined
  if (code !== 0 && code !== 1) {
    const failure = rgExitFailure(code, readStderr(handle).text)
    if (failure.kind !== 'partial') throw new Error(failure.message)
    warning = failure.message
  }
  const reader = handle.collected?.stdout
  if (!reader) throw new Error('ripgrep stdout 不可用')
  const output = reader.readFrom(0)
  const rels = output.text.split(/\r?\n/).map((line) => relativeCandidate(root, line)).filter(Boolean)
  const unique = [...new Set(rels)]
  return { files: unique.slice(0, MAX_REPLACE_FILES), truncated: Boolean(output.lossy) || unique.length > MAX_REPLACE_FILES, warning }
}

/**
 * 单文件替换（读 → 校验 → 版本守卫写入）。
 * @author ddj 2026年11月15号
 * @param input 执行输入
 * @param relativePath 工作区相对路径
 * @param compiled 编译后的模式
 * @returns 该文件结果；跳过与失败通过 outcome 字段表达
 */
async function replaceOneFile(
  input: ReplaceRunInput,
  relativePath: string,
  compiled: ReturnType<typeof compileReplace>,
): Promise<{ replaced: number; skipped: boolean; reason?: string }> {
  const fs = input.ctx.get('fs')
  if (!fs) throw new Error('缺少 fs')
  const target = await resolveTarget(input.ctx, input.session, relativePath)
  const info = await fs.stat(target)
  if (!info || info.type !== 'file') return { replaced: 0, skipped: true, reason: '不是普通文件' }
  if (Number(info.size ?? 0) > MAX_REPLACE_FILE_BYTES) return { replaced: 0, skipped: true, reason: '文件过大（>8MB）' }

  const text = await fs.readText(target)
  if (typeof text !== 'string' || text.includes('\u0000')) return { replaced: 0, skipped: true, reason: '二进制文件' }
  const count = countInText(text, compiled)
  if (count === 0) return { replaced: 0, skipped: false }
  if (input.request.dryRun === true) return { replaced: count, skipped: false }

  const { text: next, count: replaced } = replaceInText(text, compiled)
  if (replaced === 0) return { replaced: 0, skipped: false }
  // BOM 可能已被读文本通道剥掉（UTF-8 BOM 在解码时常见地消失）：按原始字节判断并在写回时补回，
  // 否则替换会悄悄把带 BOM 的文件变成无 BOM（对依赖 BOM 构建/解析的工具是破坏性改动）。
  const raw = await readRawPrefix(fs, target)
  const hasBom = isBom(raw) || next.startsWith('\uFEFF')
  const payload = hasBom && !next.startsWith('\uFEFF') ? '\uFEFF' + next : next
  const intent = info.version ? { kind: 'replaceIfVersion', version: info.version } : undefined
  await fs.writeText(target, payload, intent, undefined, policyOf(input.ctx, input.session))
  // 目录树缓存失效是 best effort：索引不可用时不能把已经成功的写盘报成失败
  try { invalidateIndex(input.ctx, input.cwd, relativePath) } catch (error) { /* 索引失效失败不影响替换结果 */ }
  return { replaced, skipped: false }
}

/**
 * 执行替换（dryRun 只统计）。
 * @author ddj 2026年11月15号
 * @param input 执行输入
 * @returns 汇总结果
 */
export async function runReplace(input: ReplaceRunInput): Promise<ReplaceOutcome> {
  const compiled = compileReplace(input.request)
  const candidates = await listCandidates(input)
  const outcome: ReplaceOutcome = {
    files: [],
    totalFiles: 0,
    totalReplaced: 0,
    truncated: candidates.truncated,
    dryRun: input.request.dryRun === true,
    skipped: 0,
    failed: [],
    ...(candidates.warning ? { warning: candidates.warning } : {}),
  }
  for (const relativePath of candidates.files) {
    if (input.signal?.aborted === true) {
      outcome.warning = '替换已取消'
      break
    }
    try {
      const result = await replaceOneFile(input, relativePath, compiled)
      if (result.skipped) { outcome.skipped += 1; continue }
      if (result.replaced === 0) continue
      outcome.files.push({ path: relativePath, replaced: result.replaced })
      outcome.totalFiles += 1
      outcome.totalReplaced += result.replaced
    } catch (error) {
      outcome.failed.push({ path: relativePath, reason: describeFailure(error) })
    }
  }
  return outcome
}

/**
 * 读原始字节前缀（用于 BOM 判断；读取失败时返回 null，不阻塞替换）。
 * @author ddj 2026年11月15号
 * @param fs 文件服务
 * @param target 解析后的目标
 * @returns 原始字节或 null
 */
async function readRawPrefix(fs: any, target: unknown): Promise<unknown> {
  if (typeof fs?.readBytes !== 'function') return null
  try {
    return await fs.readBytes(target, undefined, MAX_REPLACE_FILE_BYTES)
  } catch (error) {
    return null
  }
}

/**
 * 判断字节序列是否以 UTF-8 BOM 开头。
 * @author ddj 2026年11月15号
 * @param bytes 文件原始字节
 * @returns 是否带 BOM
 */
export function isBom(bytes: unknown): boolean {
  const view = bytes as { length?: number; [index: number]: number } | null
  if (!view || typeof view.length !== 'number' || view.length < 3) return false
  return view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf
}

/**
 * 失败原因归一（版本冲突给可读提示，其余保留原始消息）。
 * @author ddj 2026年11月15号
 * @param error 捕获的异常
 * @returns 可读原因
 */
export function describeFailure(error: unknown): string {
  const source = error as { code?: unknown; message?: unknown } | null
  const message = typeof source?.message === 'string' ? source.message : String(error)
  if (source?.code === 'FS_STALE_VERSION' || message.includes('changed since it was read')) return '文件在替换期间被修改，已跳过'
  return message.length > 300 ? message.slice(0, 300) + '…' : message
}
