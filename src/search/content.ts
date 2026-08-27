/**
 * dsh-vscode-mode host — 工作区内容搜索（rg --json 主路径 + 有界编排）。
 * 命中列由 rg 行内字节偏移转 UTF-16（1-based），可直接供 Monaco 跳转/高亮。
 * 无 fallback：provider 失败抛错，由 RPC 层转错误响应（避免整树读文件）。
 * 作者 ddj 2026年08月26号
 */
import type { Ctx, Session } from '../store.js'
import { pathText } from './query.js'
import { EXCLUDES, FILE_EXCLUDES, readStderr, rgExitFailure, ripgrepPath, searchRoot } from './ripgrep.js'
import { SearchCache } from './orchestrator.js'
import type { ContentMatch, ContentSearchInput, ContentSearchProvider, ContentSearchResult } from './types.js'

const STDOUT_CAP = 16 << 20
const STDERR_CAP = 64 << 10
const GRACE_MS = 20_000
const DEFAULT_MAX_MATCHES = 500
const DEFAULT_MAX_FILES = 100
const CACHE_TTL = 60_000
const CACHE_LIMIT = 100
const PROVIDER_VERSION = 'content-ripgrep-v1'
/** 单行 JSON 记录上限：巨型单行文件（源映射/打包产物）的命中行对搜索 UI 无意义，直接跳过。 */
const MAX_RECORD_LINE = 1 << 20

/** rg --json 单条 match 记录的宽松形状（未知字段忽略）。 */
interface RgJsonItem {
  type?: string
  data?: {
    path?: { text?: string }
    lines?: { text?: string }
    line_number?: number
    submatches?: Array<{ start?: number; end?: number }>
  }
}

/** 内容搜索请求（RPC 参数映射）。 */
export interface ContentSearchRequest {
  session: Session
  cwd: string
  query: string
  matchCase?: boolean
  wholeWord?: boolean
  regex?: boolean
  maxResults?: number
  /** 正选 glob（仅在这些文件内搜索）。 */
  include?: string[]
  /** 排除 glob（这些文件不参与搜索）。 */
  exclude?: string[]
}

type ContentSearchResponse = { matches: ContentMatch[]; truncated: boolean; warning?: string }

/**
 * 把行内字节偏移转成 UTF-16 列（1-based；越界钳到行尾）。
 * @author ddj 2026年08月26号
 * @param text 行文本
 * @param byteOffset 行内字节偏移（rg submatches.start/end，实测为行相对）
 * @returns 1-based UTF-16 列
 */
export function byteToUtf16Col(text: string, byteOffset: number): number {
  let bytes = 0
  let col = 1
  for (const char of text) {
    if (bytes >= byteOffset) break
    bytes += Buffer.byteLength(char)
    col++
  }
  return col
}

/**
 * 根内绝对路径 → 工作区相对显示路径（供 edrv.read 与面板展示）。
 * @author ddj 2026年08月26号
 * @param value rg 输出路径
 * @param root 搜索根（subprocess 执行世界）
 * @returns 相对路径（根外路径原样返回）
 */
export function displayPathOf(value: string | undefined, root: string): string {
  const path = pathText(String(value ?? ''))
  if (!path) return path
  const base = pathText(root).replace(/\/$/, '')
  const lowerPath = path.toLocaleLowerCase('en-US')
  const lowerBase = base.toLocaleLowerCase('en-US')
  if (lowerPath === lowerBase) return '.'
  if (lowerPath.startsWith(lowerBase + '/')) return path.slice(base.length + 1)
  return path
}

/**
 * 解析 rg --json 输出为扁平命中列表（多子匹配展开，列转 UTF-16）。
 * @author ddj 2026年08月26号
 * @param text stdout 文本
 * @param root 搜索根
 * @returns 命中列表
 */
export function parseRgJsonLines(text: string, root: string): ContentMatch[] {
  const matches: ContentMatch[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let item: RgJsonItem
    try {
      item = JSON.parse(trimmed) as RgJsonItem
    } catch {
      continue
    }
    if (item?.type !== 'match' || !item.data) continue
    const data = item.data
    const path = displayPathOf(data.path?.text, root)
    const lineText = (data.lines?.text ?? '').replace(/\r?\n$/, '').replace(/\r$/, '')
    if (lineText.length > MAX_RECORD_LINE) continue
    const lineNumber = data.line_number ?? 0
    for (const sub of data.submatches ?? []) {
      matches.push({
        path,
        line: lineNumber,
        startColumn: byteToUtf16Col(lineText, sub.start ?? 0),
        endColumn: byteToUtf16Col(lineText, sub.end ?? 0),
        text: lineText,
      })
    }
  }
  return matches
}

/**
 * 命中截断：匹配数/文件数双上限，超限标记 truncated。
 * @author ddj 2026年08月26号
 * @param matches 全部命中
 * @param maxMatches 匹配数上限
 * @param maxFiles 文件数上限
 * @returns 截断后的命中与标志
 */
export function applyCaps(matches: ContentMatch[], maxMatches: number, maxFiles: number): { matches: ContentMatch[]; truncated: boolean } {
  const seen = new Set<string>()
  const out: ContentMatch[] = []
  let truncated = false
  for (const match of matches) {
    if (out.length >= maxMatches) { truncated = true; break }
    if (!seen.has(match.path)) {
      if (seen.size >= maxFiles) { truncated = true; break }
      seen.add(match.path)
    }
    out.push(match)
  }
  return { matches: out, truncated }
}

/**
 * 构造 rg 内容搜索 argv（pattern 放 `--` 后首位置，支持前导 `-` 的查询）。
 * include/exclude 为用户 glob（gitignore 式，原样透传不转义），
 * 分别转正选 `--glob` 与排除 `--glob !`。
 * @author ddj 2026年08月26号
 * @param binary rg 路径
 * @param root 搜索根
 * @param input 搜索输入
 * @returns argv 数组
 */
export function contentArgv(binary: string, root: string, input: ContentSearchInput): string[] {
  const argv = [binary, '--no-config', '--json', '--line-number', '--no-heading', '--color', 'never', '--hidden', '--no-ignore']
  if (input.matchCase === true) argv.push('--case-sensitive')
  if (input.wholeWord === true) argv.push('--word-regexp')
  if (input.regex !== true) argv.push('--fixed-strings')
  for (const excluded of EXCLUDES) argv.push('--glob', '!**/' + excluded + '/**')
  for (const excluded of FILE_EXCLUDES) argv.push('--glob', '!' + excluded)
  for (const pattern of input.include ?? []) {
    const glob = String(pattern).trim()
    if (glob) argv.push('--glob', glob)
  }
  for (const pattern of input.exclude ?? []) {
    const glob = String(pattern).trim()
    if (glob) argv.push('--glob', '!' + glob)
  }
  argv.push('--', input.query, root)
  return argv
}

/**
 * 使用打包 ripgrep 搜索文件内容。
 * @author ddj 2026年08月26号
 * @param input provider 输入
 * @returns 有界内容搜索结果
 */
export async function searchRipgrepContent(input: ContentSearchInput): Promise<ContentSearchResult> {
  const sub = input.ctx.get('subprocess') as { spawn(spec: unknown): { done: Promise<{ exitCode: number | null; code?: number | null }>; collected?: { stdout?: { readFrom(offset: number): { text: string; lossy?: boolean } }; stderr?: { readFrom(offset: number): { text: string } } } } } | undefined
  if (!sub) throw new Error('缺少 subprocess')
  const binary = ripgrepPath()
  if (!binary) throw new Error('ripgrep 不可用')
  const root = input.root ?? await searchRoot(input.ctx, input.session)
  const handle = sub.spawn({
    argv: contentArgv(binary, root, input),
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
  const failure = code !== 0 && code !== 1 ? rgExitFailure(code, readStderr(handle).text) : null
  if (failure && failure.kind !== 'partial') throw new Error(failure.message)
  const reader = handle.collected?.stdout
  if (!reader) throw new Error('ripgrep stdout 不可用')
  const output = reader.readFrom(0)
  const all = parseRgJsonLines(output.text, root)
  const maxMatches = Math.max(1, Math.min(input.maxResults ?? DEFAULT_MAX_MATCHES, DEFAULT_MAX_MATCHES))
  const capped = applyCaps(all, maxMatches, DEFAULT_MAX_FILES)
  const truncated = Boolean(output.lossy) || capped.truncated
  const result: ContentSearchResult = { ...capped, complete: !truncated, source: 'ripgrep' }
  // 遍历错误（退出码 2）：rg 已输出的命中仍有效，保留结果、标记不完整并附部分结果提示
  if (failure) {
    result.complete = false
    result.warning = failure.message
  }
  return result
}

/**
 * 内容搜索编排器：短期缓存 + 同根在途取消 + 会话清理。
 * @author ddj 2026年08月26号
 */
export class ContentSearcher {
  private readonly cache = new SearchCache<ContentSearchResult>((r) => ({ ...r, matches: [...r.matches] }))
  private readonly inflight = new Map<string, AbortController>()
  private readonly rootsByCwd = new Map<string, Set<string>>()

  /**
   * 创建内容搜索编排器。
   * @author ddj 2026年08月26号
   * @param ctx DSH 上下文
   * @param provider 内容搜索 provider（测试可替换）
   */
  constructor(private readonly ctx: Ctx, private readonly provider: ContentSearchProvider = { search: searchRipgrepContent }) {}

  /**
   * 执行一次工作区内容搜索。
   * @author ddj 2026年08月26号
   * @param request 搜索请求
   * @returns RPC 响应字段（provider 失败抛错，abort 返回空）
   */
  async search(request: ContentSearchRequest): Promise<ContentSearchResponse> {
    const query = String(request.query ?? '').trim()
    if (query.length < 2) return { matches: [], truncated: false }
    let root: string
    try {
      root = await searchRoot(this.ctx, request.session)
    } catch {
      return { matches: [], truncated: false }
    }
    const rootKey = pathText(root)
    const roots = this.rootsByCwd.get(request.cwd) ?? new Set<string>()
    roots.add(rootKey)
    this.rootsByCwd.set(request.cwd, roots)
    const includeKey = (request.include ?? []).join(',')
    const excludeKey = (request.exclude ?? []).join(',')
    const key = [rootKey, query, request.matchCase ? 'mc' : '', request.wholeWord ? 'ww' : '', request.regex ? 'rx' : '', includeKey, excludeKey, PROVIDER_VERSION].join('|')
    const cached = this.cache.get(key)
    if (cached) return { matches: cached.matches, truncated: cached.truncated, warning: cached.warning }
    this.inflight.get(root)?.abort()
    const controller = new AbortController()
    this.inflight.set(root, controller)
    try {
      const result = await this.provider.search({
        ctx: this.ctx,
        session: request.session,
        cwd: request.cwd,
        query,
        matchCase: request.matchCase,
        wholeWord: request.wholeWord,
        regex: request.regex,
        maxResults: request.maxResults,
        include: request.include,
        exclude: request.exclude,
        signal: controller.signal,
        root,
      })
      if (controller.signal.aborted) return { matches: [], truncated: false }
      this.cache.set(key, result)
      return { matches: result.matches, truncated: result.truncated, warning: result.warning }
    } catch (error) {
      if (controller.signal.aborted) return { matches: [], truncated: false }
      throw error
    } finally {
      if (this.inflight.get(root) === controller) this.inflight.delete(root)
    }
  }

  /**
   * 清理会话对应根目录的缓存和在途搜索。
   * @author ddj 2026年08月26号
   * @param cwd 会话工作区
   */
  dispose(cwd: string): void {
    const roots = this.rootsByCwd.get(cwd) ?? new Set<string>([cwd])
    for (const root of roots) {
      this.inflight.get(root)?.abort()
      this.inflight.delete(root)
      this.cache.clearRoot(root)
    }
    this.rootsByCwd.delete(cwd)
  }

  /**
   * 清理全部状态。
   * @author ddj 2026年08月26号
   */
  disposeAll(): void {
    for (const controller of this.inflight.values()) controller.abort()
    this.inflight.clear()
    this.rootsByCwd.clear()
    this.cache.clear()
  }
}

/**
 * 创建默认内容搜索编排器。
 * @author ddj 2026年08月26号
 * @param ctx DSH 上下文
 * @returns 内容搜索编排器
 */
export function newContentSearcher(ctx: Ctx): ContentSearcher {
  return new ContentSearcher(ctx)
}
