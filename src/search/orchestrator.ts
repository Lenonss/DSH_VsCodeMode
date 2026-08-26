/**
 * dsh-vscode-mode host — 搜索编排、缓存和旧任务取消。
 * 对外只返回旧 RPC 所需的 files/truncated，内部保留 provider 边界。
 * 作者 ddj 2026年08月24号
 */
import type { Ctx, Session } from '../store.js'
import { policyOf } from '../store.js'
import { pathKey, pathMatch, pathText, prepareQuery } from './query.js'
import { searchRoot } from './ripgrep.js'
import { newRgProvider } from './ripgrep.js'
import { newFallback } from './fallback.js'
import { candidateOf, rankCandidates } from './ranker.js'
import type { CandidateRanker, SearchCandidate, WorkspaceSearchProvider, WorkspaceSearchResult } from './types.js'

const CACHE_TTL = 60_000
const CACHE_LIMIT = 100
const RESULT_LIMIT = 50
const PROVIDER_VERSION = 'ripgrep-v1'
const POLICY_VERSION = 'search-policy-v1'

type CacheEntry<T> = { at: number; result: T }
type SearchRequest = { session: Session; cwd: string; query: string; activePaths: string[] }
type SearchResponse = { files: string[]; truncated: boolean }

/**
 * 短期有界搜索缓存（泛型：文件/内容搜索共用；clone 由调用方保证写隔离）。
 * @author ddj 2026年08月24号
 * @param clone 结果写隔离克隆（缺省恒等）
 */
export class SearchCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>()

  /**
   * 创建缓存。
   * @author ddj 2026年08月24号
   * @param clone 结果克隆函数（缺省直接引用）
   */
  constructor(private readonly clone: (value: T) => T = (value) => value) {}

  /**
   * 读取未过期条目。
   * @author ddj 2026年08月24号
   * @param key 缓存 key
   * @param now 当前时间
   * @returns 缓存结果或 undefined
   */
  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (now - entry.at >= CACHE_TTL) { this.entries.delete(key); return undefined }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return this.clone(entry.result)
  }

  /**
   * 写入成功 provider 结果。
   * @author ddj 2026年08月24号
   * @param key 缓存 key
   * @param result provider 结果
   * @param now 当前时间
   */
  set(key: string, result: T, now = Date.now()): void {
    this.entries.delete(key)
    this.entries.set(key, { at: now, result: this.clone(result) })
    while (this.entries.size > CACHE_LIMIT) this.entries.delete(this.entries.keys().next().value as string)
  }

  /**
   * 清理指定根目录的缓存。
   * @author ddj 2026年08月24号
   * @param root 工作区根目录
   */
  clearRoot(root: string): void {
    for (const key of this.entries.keys()) if (key.startsWith(root + '|')) this.entries.delete(key)
  }

  /**
   * 清空全部缓存。
   * @author ddj 2026年08月24号
   */
  clear(): void { this.entries.clear() }
}

/**
 * 获取 policy 版本，未知策略使用固定插件版本。
 * @author ddj 2026年08月24号
 * @param ctx DSH 上下文
 * @param session 当前会话
 * @returns 稳定版本文本
 */
function policyVersion(ctx: Ctx, session: Session): string {
  const policy = policyOf(ctx, session)
  const version = policy?.version ?? policy?.policyVersion
  return typeof version === 'string' || typeof version === 'number' ? String(version) : POLICY_VERSION
}

/**
 * 将 root 内绝对路径统一成相对显示路径。
 * @author ddj 2026年08月24号
 * @param value 原始路径
 * @param root 搜索根
 * @returns 兼容 edrv.read 的路径
 */
function displayPath(value: string, root: string): string {
  const path = pathText(value)
  const base = pathText(root).replace(/\/$/, '')
  const lowerPath = path.toLocaleLowerCase('en-US')
  const lowerBase = base.toLocaleLowerCase('en-US')
  if (lowerPath === lowerBase) return '.'
  if (lowerPath.startsWith(lowerBase + '/')) return path.slice(base.length + 1)
  return path
}

/**
 * 为显示路径生成跨绝对/相对形式的去重 key。
 * @author ddj 2026年08月24号
 * @param value 原始路径
 * @param root 搜索根
 * @returns 去重 key
 */
function displayKey(value: string, root: string): string {
  return pathKey(displayPath(value, root))
}

/**
 * 合并 provider 与 active diff 候选并去重。
 * @author ddj 2026年08月24号
 * @param result provider 结果
 * @param activePaths 活跃差异路径
 * @param root 搜索根
 * @param query 已规范化 query
 * @returns 候选列表
 */
function mergeCandidates(result: WorkspaceSearchResult, activePaths: string[], root: string, query: ReturnType<typeof prepareQuery>): SearchCandidate[] {
  const candidates = new Map<string, SearchCandidate>()
  for (const path of result.files) {
    const shown = displayPath(path, root)
    if (pathMatch(shown, query)) candidates.set(displayKey(path, root), candidateOf(shown, 'workspace'))
  }
  for (const path of activePaths) {
    const shown = displayPath(path, root)
    if (!pathMatch(shown, query)) continue
    const key = displayKey(path, root)
    if (!candidates.has(key)) candidates.set(key, candidateOf(shown, 'active-diff'))
  }
  return [...candidates.values()]
}

/**
 * 搜索编排器。
 * @author ddj 2026年08月24号
 */
export class SearchOrchestrator {
  private readonly cache = new SearchCache<WorkspaceSearchResult>((r) => ({ ...r, files: [...r.files] }))
  private readonly inflight = new Map<string, AbortController>()
  private readonly rootsByCwd = new Map<string, Set<string>>()
  private readonly provider: WorkspaceSearchProvider
  private readonly fallback: WorkspaceSearchProvider
  private readonly ranker: CandidateRanker

  /**
   * 创建搜索编排器。
   * @author ddj 2026年08月24号
   * @param ctx DSH 上下文
   * @param provider 主 provider，可替换测试
   * @param fallback 降级 provider，可替换测试
   * @param ranker 排序器，可替换测试
   */
  constructor(private readonly ctx: Ctx, provider = newRgProvider(), fallback = newFallback(), ranker: CandidateRanker = { rank: rankCandidates }) {
    this.provider = provider
    this.fallback = fallback
    this.ranker = ranker
  }

  /**
   * 执行一次工作区搜索。
   * @author ddj 2026年08月24号
   * @param request 搜索请求
   * @returns 旧 RPC 响应字段
   */
  async search(request: SearchRequest): Promise<SearchResponse> {
    const query = prepareQuery(request.query)
    if (query.text.length < 2) return { files: [], truncated: false }
    let root: string
    try { root = await searchRoot(this.ctx, request.session) } catch (error) {
      return this.rankActive(request.activePaths, request.cwd, query)
    }
    const rootKey = pathText(root)
    const roots = this.rootsByCwd.get(request.cwd) ?? new Set<string>()
    roots.add(rootKey)
    this.rootsByCwd.set(request.cwd, roots)
    const key = [rootKey, query.text, policyVersion(this.ctx, request.session), PROVIDER_VERSION].join('|')
    const cached = this.cache.get(key)
    if (cached) return this.finish(cached, request.activePaths, root, query)
    this.inflight.get(root)?.abort()
    const controller = new AbortController()
    this.inflight.set(root, controller)
    try {
      let result: WorkspaceSearchResult
      let providerOk = true
      try {
        result = await this.provider.search({ ctx: this.ctx, session: request.session, cwd: request.cwd, query: query.raw, maxResults: 500, signal: controller.signal, root })
      } catch (error) {
        providerOk = false
        if (controller.signal.aborted) return { files: [], truncated: false }
        try {
          result = await this.fallback.search({ ctx: this.ctx, session: request.session, cwd: request.cwd, query: query.raw, maxResults: 500, signal: controller.signal, root })
        } catch (fallbackError) {
          return this.rankActive(request.activePaths, root, query)
        }
      }
      if (controller.signal.aborted) return { files: [], truncated: false }
      if (providerOk) this.cache.set(key, result)
      return this.finish(result, request.activePaths, root, query)
    } finally {
      if (this.inflight.get(root) === controller) this.inflight.delete(root)
    }
  }

  /**
   * 清理会话对应根目录的缓存和在途搜索。
   * @author ddj 2026年08月24号
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
   * @author ddj 2026年08月24号
   */
  disposeAll(): void {
    for (const controller of this.inflight.values()) controller.abort()
    this.inflight.clear()
    this.rootsByCwd.clear()
    this.cache.clear()
  }

  /**
   * 将 provider 结果与 active diff 合并、排序和截断。
   * @author ddj 2026年08月24号
   * @param result provider 结果
   * @param activePaths active diff 路径
   * @param root 搜索根
   * @param query 已规范化 query
   * @returns 旧 RPC 响应字段
   */
  private finish(result: WorkspaceSearchResult, activePaths: string[], root: string, query: ReturnType<typeof prepareQuery>): SearchResponse {
    const candidates = this.ranker.rank(mergeCandidates(result, activePaths, root, query), query)
    return { files: candidates.slice(0, RESULT_LIMIT).map((candidate) => candidate.path), truncated: result.truncated || candidates.length > RESULT_LIMIT }
  }

  /**
   * provider 失败时仅保留 active diff 命中。
   * @author ddj 2026年08月24号
   * @param paths active diff 路径
   * @param root 搜索根
   * @param query 已规范化 query
   * @returns 旧 RPC 响应字段
   */
  private rankActive(paths: string[], root: string, query: ReturnType<typeof prepareQuery>): SearchResponse {
    const result: WorkspaceSearchResult = { files: [], truncated: false, complete: true, source: 'active-diff' }
    return this.finish(result, paths, root, query)
  }
}

/**
 * 创建默认编排器。
 * @author ddj 2026年08月24号
 * @param ctx DSH 上下文
 * @returns 搜索编排器
 */
export function newSearcher(ctx: Ctx): SearchOrchestrator {
  return new SearchOrchestrator(ctx)
}
