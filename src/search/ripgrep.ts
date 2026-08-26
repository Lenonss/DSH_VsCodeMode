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

/** 默认排除目录（文件/内容搜索共用，导出供 provider 复用）。 */
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
 * 将 query 转成 rg 的字面 glob。
 * @author ddj 2026年08月24号
 * @param query 已规范化 query
 * @returns 安全 glob
 */
export function queryGlob(query: string): string {
  const value = pathText(query)
  const escaped = value.replace(/[\*?\[\]{}!]/g, (char) => '\\' + char)
  return '**/*' + escaped + '*'
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
  const argv = [binary, '--no-config', '--files', '--hidden', '--no-ignore', '--glob-case-insensitive', '--glob', queryGlob(query.text)]
  for (const excluded of EXCLUDES) argv.push('--glob', '!**/' + excluded + '/**')
  for (const excluded of FILE_EXCLUDES) argv.push('--glob', '!' + excluded)
  argv.push('--', root)
  const handle = sub.spawn({
    argv,
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
  if (code !== 0 && code !== 1) throw new Error('ripgrep 退出码：' + String(code))
  const parsed = parseOutput(handle, input.maxResults)
  if (!handle.collected?.stdout) throw new Error('ripgrep stdout 不可用')
  return { ...parsed, source: 'ripgrep' }
}

/**
 * 构造 ripgrep provider。
 * @author ddj 2026年08月24号
 * @returns provider 实例
 */
export function newRgProvider(): WorkspaceSearchProvider {
  return { search: searchRipgrep }
}
