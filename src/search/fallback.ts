/**
 * dsh-vscode-mode host — fs.listDir 查询感知 fallback。
 * provider 不可用时边遍历边匹配，不再伪装有限全量扫描为完整索引。
 * 作者 ddj 2026年08月24号
 */
import type { Ctx, Session } from '../store.js'
import { cwdOfSession, policyOf } from '../store.js'
import { pathText, pathMatch, prepareQuery } from './query.js'
import type { PreparedQuery, WorkspaceSearchInput, WorkspaceSearchProvider, WorkspaceSearchResult } from './types.js'

interface FsTarget { displayPath?: string }
interface FsEntry { name: string; type: 'file' | 'directory' | 'other'; target: FsTarget }
interface SearchFs {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsEntry[]>
}

const RESULT_CAP = 500
const EXCLUDED = new Set(['node_modules', '.git', '.tmp', '.cache', 'dist', 'build', 'vendor', 'coverage', '__pycache__', '.pnpm-store', '.npm-cache', '.codegraph', '.workbuddy', '.dsh-edit-review.json', '.dsh-edit-review-archive.json', '.dsh-edit-review-debug.log'])

/**
 * 在一个目录树中递归查找匹配文件。
 * @private
 * @author ddj 2026年10月14号
 * @param fs 文件系统能力
 * @param target 当前目录目标
 * @param input 搜索输入
 * @param files 已保留候选
 * @param signal 取消信号
 * @param query 已规范化查询
 * @param prefix 当前目录相对于搜索根的路径
 * @returns 是否因达到上限而截断
 */
async function walk(fs: SearchFs, target: FsTarget, input: WorkspaceSearchInput, files: string[], signal: AbortSignal, query: PreparedQuery, prefix = ''): Promise<boolean> {
  if (signal.aborted) throw new DOMException('搜索已取消', 'AbortError')
  const entries = await fs.listDir(target, signal)
  for (const entry of entries) {
    if (signal.aborted) throw new DOMException('搜索已取消', 'AbortError')
    const relative = prefix + entry.name
    if (entry.type === 'directory') {
      if (EXCLUDED.has(entry.name)) continue
      if (await walk(fs, entry.target, input, files, signal, query, relative + '/')) return true
      continue
    }
    if (entry.type !== 'file') continue
    const path = pathText(entry.target.displayPath ?? relative)
    if (!pathMatch(relative, query)) continue
    files.push(path)
    if (files.length >= Math.min(input.maxResults, RESULT_CAP)) return true
  }
  return false
}

/**
 * 使用 ctx.fs.listDir 搜索文件。
 * @author ddj 2026年08月24号
 * @param input provider 输入
 * @returns 有界 fallback 结果
 */
export async function searchFallback(input: WorkspaceSearchInput): Promise<WorkspaceSearchResult> {
  const fs = input.ctx.get('fs') as SearchFs | undefined
  if (!fs) throw new Error('缺少 fs')
  const policy = policyOf(input.ctx, input.session)
  const cwd = cwdOfSession(input.ctx, input.session)
  const rootTarget = await fs.resolve(policy?.workspaceRoot ?? '.', cwd ? { cwd, signal: input.signal } : { signal: input.signal })
  const signal = input.signal ?? new AbortController().signal
  const files: string[] = []
  const truncated = await walk(fs, rootTarget, input, files, signal, prepareQuery(input.query))
  return { files, truncated, complete: !truncated, source: 'fallback' }
}

/**
 * 构造 fallback provider。
 * @author ddj 2026年08月24号
 * @returns provider 实例
 */
export function newFallback(): WorkspaceSearchProvider {
  return { search: searchFallback }
}
