/**
 * 批量替换目标预读：执行前按字面量求候选文件，供待审采集冻结写前基线。
 * @author ddj 2026年11月09号
 */
import type { Ctx, Session } from '../store.js'
import { searchRipgrepContent } from '../search/content.js'
import type { ContentSearchInput, ContentSearchResult } from '../search/types.js'

/** 单次批量替换最多预读的候选文件数，与待审采集预算一致。 */
export const BULK_LIMIT = 16
/** 内容搜索命中上限：只需文件集合，取够即可。 */
const SEARCH_RESULTS = 200

/** 批量替换工具参数里本模块关心的字段。 */
export interface BulkArgs {
  path?: unknown
  pattern?: unknown
  glob?: unknown
}

/** 一次候选求值所需的宿主信息与工具参数。 */
export interface BulkScope {
  ctx: Ctx
  session: Session
  cwd: string
  args: BulkArgs
}

/** 预读候选：绝对路径集合与去重后的候选总数。 */
export interface BulkCandidates {
  paths: string[]
  total: number
}

/** 内容搜索注入点；测试可替换，生产使用打包 ripgrep。 */
export type BulkSearcher = (input: ContentSearchInput) => Promise<ContentSearchResult>

/**
 * @private
 * @author ddj 2026年11月09号
 * @description: 取字符串参数，非字符串或空串退回缺省值。
 * @param value 原始参数值
 * @param fallback 缺省值
 * @returns 非空字符串
 */
function textOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

/**
 * @private
 * @author ddj 2026年11月09号
 * @description: 取 glob 过滤数组；空数组表示不限制，交由 rg 默认忽略规则。
 * @param value 原始参数值
 * @returns 去空后的 glob 列表；无有效项时为 undefined
 */
function globsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const globs = value.map((item) => String(item).trim()).filter(Boolean)
  return globs.length ? globs : undefined
}

/**
 * @private
 * @author ddj 2026年11月09号
 * @description: 解析替换作用域为绝对路径；缺省为工作区根。
 * @param scope 宿主信息与工具参数
 * @returns 作用域绝对路径
 * @throws 文件系统不可用或解析失败
 */
async function scopeRoot(scope: BulkScope): Promise<string> {
  const fs = scope.ctx.get('fs') as { resolve?: (path: string, opts: { cwd: string }) => Promise<unknown> } | undefined
  if (!fs || typeof fs.resolve !== 'function') throw new Error('文件系统不可用')
  const requested = textOf(scope.args.path, '.')
  return String(await fs.resolve(requested, { cwd: scope.cwd }))
}

/**
 * @private
 * @author ddj 2026年11月09号
 * @description: 搜索命中路径转绝对路径；rg 命中的路径相对搜索根。
 * @param root 搜索根（作用域绝对路径）
 * @param path 命中路径
 * @returns 绝对路径
 */
function targetOf(root: string, path: string): string {
  if (!path || path === '.') return root
  if (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)) return path
  return root.replace(/[\\/]+$/, '') + '/' + path
}

/**
 * @public
 * @author ddj 2026年11月09号
 * @description: 以替换作用域为搜索根按字面量求候选文件；作用域外的同名命中不进入候选。
 * @param scope 宿主信息、工作区与工具参数
 * @param search 可注入的内容搜索实现
 * @returns 候选绝对路径（最多 BULK_LIMIT 个）与去重后的候选总数
 * @throws 参数缺 pattern、文件系统不可用或搜索失败（由调用方转采集 gap）
 */
export async function replaceCandidates(scope: BulkScope, search: BulkSearcher = searchRipgrepContent): Promise<BulkCandidates> {
  const query = textOf(scope.args.pattern, '')
  if (!query) return { paths: [], total: 0 }

  const root = await scopeRoot(scope)
  const result = await search({
    ctx: scope.ctx,
    session: scope.session,
    cwd: scope.cwd,
    root,
    query,
    matchCase: true,
    regex: false,
    maxResults: SEARCH_RESULTS,
    include: globsOf(scope.args.glob),
  })

  const seen = new Set<string>()
  for (const match of result.matches) {
    seen.add(targetOf(root, match.path))
  }

  const paths = [...seen].sort()
  return { paths: paths.slice(0, BULK_LIMIT), total: paths.length }
}
