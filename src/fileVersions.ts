/**
 * dsh-vscode-mode host — 文件磁盘新鲜度观察（外部改动检测的 host 半）。
 *
 * 用途：客户端（编辑区）在无法感知外部写盘的前提下会把陈旧缓冲当权威内容，
 * 甚至在防抖自动保存时覆盖外部改动。本模块为客户端提供轻量批查：给一批路径
 * 返回当前磁盘版本令牌（ctx.fs.stat 的 version）+ 类型，客户端与本地基线比对后
 * 决定是否重载/提示/拒绝保存。
 *
 * 附带职责（文件树同步）：对每次都变化的路径调用 treeIndex.invalidateIndex，
 * 使「外部新增/删除文件」不再只依赖 60s TTL——已展开目录在下次展开时即为最新。
 *
 * 设计取舍：
 * - 不注册 fs.watch：句柄占用、网络盘/长路径兼容性差且难单测；批 stat 由系统
 *   缓存兜底，1–20 条/轮的代价可忽略，因此观察逻辑全部落在本模块且可确定性测试。
 * - 基准版本表（path → version）只用于「是否变化」判定，不参与客户端语义；
 *   每条记忆带 TTL（MEM_TTL_MS），超过即视为陈旧重新记基准；总量有上限兜底。
 * - 单条失败不影响整批：解析失败/不存在以 type='missing' 返回，响应始终 ok。
 *
 * 作者 ddj 2026-09-15
 */
import type { FileVersionItem } from './shared/rpc.js'
import type { Ctx } from './store.js'
import { cwdOf, sessionOf } from './registry.js'
import { invalidateIndex } from './treeIndex.js'
import { log } from './log.js'

// --region 常量

/** 基准版本记忆上限：超出按写入序逐出最旧（防长时间运行无界增长）。 */
export const MEM_MAX = 500
/** 基准版本记忆新鲜期：超过即视为陈旧（重记基准，不报一次假变化）。 */
export const MEM_TTL_MS = 5 * 60_000
/** 批量路径上限：超出只处理前 N 条（客户端只发已打开页签，正常远小于此值）。 */
export const MAX_PATHS = 200

// --endregion

// --region 类型

/** 版本观察器实例。 */
export interface FileVersions {
  /**
   * 批查路径的磁盘版本。
   * @param args 会话 id 与路径列表
   */
  versions(args: { sessionId?: string; paths: string[] }): Promise<{ ok: true; items: FileVersionItem[] }>
  /** 卸载收尾：清空基准表（会话销毁/插件卸载调用）。 */
  dispose(): void
}

/** 一条基准记忆（版本 + 记录时间）。 */
interface Memo {
  version: string
  at: number
}

// --endregion

// --region 基准表

/** 基准表键：工作区根 + 归一化路径。 */
function memoKey(cwd: string, path: string): string {
  return String(cwd).replace(/\\/g, '/') + '\u0000' + String(path).replace(/\\/g, '/')
}

/** 清理超期/超量记忆（每次写入前调用，摊还 O(1)）。 */
function sweep(memos: Map<string, Memo>, now: number): void {
  if (memos.size === 0) return
  for (const [key, memo] of memos) {
    if (now - memo.at > MEM_TTL_MS) memos.delete(key)
  }
  while (memos.size > MEM_MAX) {
    const oldest = memos.keys().next().value
    if (oldest === undefined) break
    memos.delete(oldest)
  }
}

// --endregion

// --region 观察器

/**
 * 创建文件版本观察器（host 单例，随插件装配创建、卸载 dispose）。
 * @author ddj 2026年09月15号
 * @param ctx DSH host 上下文
 * @returns 观察器实例
 */
export function createFileVersions(ctx: Ctx): FileVersions {
  /** 基准表：memoKey → 上次观察到的版本（仅用于变化判定与树失效）。 */
  const memos = new Map<string, Memo>()

  /**
   * 记录一次观察并按需失效目录树；返回本次是否为「变化」。
   * @author ddj 2026年09月15号
   * @param cwd 工作区根
   * @param path 请求路径
   * @param version 当前版本令牌（空串 = 后端不提供）
   * @param present 磁盘上是否存在
   * @returns 是否检测到变化
   */
  const syncTree = (cwd: string, path: string, version: string, present: boolean): boolean => {
    const now = Date.now()
    const key = memoKey(cwd, path)
    const prev = memos.get(key)
    sweep(memos, now)
    const changed = prev !== undefined && (prev.version !== version || !present)
    memos.set(key, { version, at: now })
    // 每个路径只在「检测到变化」时落一行（正常编辑频率，不会刷屏）：外部改动没跟上时先看这条日志
    if (changed) log.debug('检测到磁盘变化（已失效目录树）：' + path)
    if (changed) invalidateIndex(ctx, cwd, path)
    return changed
  }

  /**
   * 单条路径观察：解析 → stat → 组装条目（异常一律降级为 missing，不整批失败）。
   * @author ddj 2026年09月15号
   * @param fs host fs 服务
   * @param cwd 工作区根（为空表示会话无工作区，跳过变化判定）
   * @param path 请求路径
   * @returns 版本条目
   */
  const observe = async (fs: Ctx, cwd: string | null, path: string): Promise<FileVersionItem> => {
    try {
      const target = await fs.resolve(path, cwd ? { cwd } : {})
      const info = await fs.stat(target)
      if (!info || info.type === 'other') {
        if (cwd) syncTree(cwd, path, '', false)
        return { path, version: '', type: 'missing' }
      }
      const version = info.version ? String(info.version) : ''
      if (cwd) syncTree(cwd, path, version, true)
      return { path, version, size: typeof info.size === 'number' ? info.size : undefined, type: info.type }
    } catch (error) {
      if (cwd) syncTree(cwd, path, '', false)
      return { path, version: '', type: 'missing', error: String(error) }
    }
  }

  /**
   * 批查入口（RPC handler 直接委托）：同一会话的路径共享一次会话解析。
   * @author ddj 2026年09月15号
   * @param args 会话 id 与路径列表
   * @returns 始终 ok 的逐条结果
   */
  const versions = async (args: { sessionId?: string; paths: string[] }): Promise<{ ok: true; items: FileVersionItem[] }> => {
    const fs = ctx.get('fs')
    const paths = (Array.isArray(args.paths) ? args.paths : [])
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .slice(0, MAX_PATHS)
    if (!fs || !paths.length) return { ok: true, items: [] }
    const session = sessionOf(ctx, args.sessionId)
    const cwd = cwdOf(session)
    const items: FileVersionItem[] = []
    for (const path of paths) items.push(await observe(fs, cwd, path))
    return { ok: true, items }
  }

  return {
    versions,
    dispose() {
      memos.clear()
    },
  }
}

// --endregion
