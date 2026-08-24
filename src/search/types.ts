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
