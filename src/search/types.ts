/**
 * dsh-vscode-mode host — 文件搜索内部契约。
 * 不暴露给 shared RPC，供 provider、编排和排序层独立演进。
 * 作者 ddj 2026年08月24号
 */
import type { Ctx, Session } from '../store.js'

export type SearchSource = 'ripgrep' | 'fallback' | 'active-diff'

export interface WorkspaceSearchInput {
  ctx: Ctx
  session: Session
  cwd: string
  query: string
  maxResults: number
  signal?: AbortSignal
  root?: string
}

export interface WorkspaceSearchResult {
  files: string[]
  truncated: boolean
  complete: boolean
  source: SearchSource
  /** rg 遍历错误（退出码 2）时的部分结果提示；无则缺省。 */
  warning?: string
}

export interface WorkspaceSearchProvider {
  search(input: WorkspaceSearchInput): Promise<WorkspaceSearchResult>
}

export interface PreparedQuery {
  raw: string
  text: string
}

export interface SearchCandidate {
  path: string
  basename: string
  normalizedPath: string
  source: 'workspace' | 'active-diff' | 'history'
  score?: number
  matchRanges?: Array<{ start: number; end: number }>
}

export interface CandidateRanker {
  rank(candidates: SearchCandidate[], query: PreparedQuery): SearchCandidate[]
}

/** 内容搜索单条命中（列 = 1-based UTF-16，直接供 Monaco 跳转/高亮）。 */
export interface ContentMatch {
  path: string
  line: number
  startColumn: number
  endColumn: number
  text: string
}

/** 内容搜索输入（options 缺省 = 大小写不敏感、字面匹配、非全词；include/exclude 为 rg glob）。 */
export interface ContentSearchInput {
  ctx: Ctx
  session: Session
  cwd: string
  query: string
  matchCase?: boolean
  wholeWord?: boolean
  regex?: boolean
  maxResults?: number
  /** 正选 glob（仅在这些文件内搜索；逗号已在客户端拆分）。 */
  include?: string[]
  /** 排除 glob（这些文件不参与搜索）。 */
  exclude?: string[]
  signal?: AbortSignal
  root?: string
}

/** 内容搜索输出：扁平命中列表 + 截断标志（warning = rg 遍历错误时的部分结果提示）。 */
export interface ContentSearchResult {
  matches: ContentMatch[]
  truncated: boolean
  complete: boolean
  source: SearchSource
  warning?: string
}

/** 内容搜索 provider（rg JSON 主路径；无 fallback，失败抛错由调用方处理）。 */
export interface ContentSearchProvider {
  search(input: ContentSearchInput): Promise<ContentSearchResult>
}
