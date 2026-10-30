/** 待审投影 RPC：Keep/Revert 走累计基线，旧官方审查入口不再承接写操作。 @author ddj 2026年10月29号 */
import type { RpcHandlerMap } from './shared/rpc.js'
import type { PendingRequest } from './shared/pendingReview.js'
import { resolveScope, sessionOf } from './registry.js'
import type { Registry } from './registry.js'
import { bucketOf } from './registry.js'
import { readText } from './pending/capture.js'
import { pendingRawId, trackPendingCover } from './pendingCompat.js'
import { loadEntries, saveEntry } from './pending/persist.js'
import { applyDecide, importFromVcs, itemOf, loadDetail, loadPage, refreshed, removeEntry, undoDecide } from './pending/store.js'
import type { ShellLike } from './pending/vcs.js'
import type { Ctx } from './store.js'
import { policyOf } from './store.js'

/**
 * @author ddj 2026年10月29号
 * @description: 待审投影处理器。读路径允许跨实例冷读，写路径必须本端 live 会话。
 * @param ctx Host 上下文
 * @param registry 工作区记录桶缓存
 * @returns 待审相关处理器表
 */
export function pendingHandlers(ctx: Ctx, registry: Registry): Partial<RpcHandlerMap> {
  /** @private @author ddj 2026年10月29号 @param sessionId 请求作用域 @returns 工作区 */
  async function workspace(sessionId: string): Promise<string> {
    const scope = await resolveScope(ctx, sessionId)
    if ('err' in scope) throw new Error('会话不存在或没有工作区')
    await bucketOf(registry, ctx, scope.cwd)
    return scope.cwd
  }

  /** @private @author ddj 2026年10月29号 @param sessionId 请求作用域 @returns 本端 live 会话的工作区 */
  async function liveWorkspace(sessionId: string): Promise<string> {
    const cwd = await workspace(sessionId)
    if (!sessionOf(ctx, sessionId)) throw new Error('写入要求本端活跃会话')
    return cwd
  }

  /**
   * @private
   * @author ddj 2026年10月30号
   * @description: 面板列表里的条目 id 带待审前缀（用于和官方条目区分），
   * 而待审内核按原始身份存取；各处理器统一走 pendingRawId 剥掉前缀。
   * @param id 请求里的条目 id
   * @returns 待审内核使用的原始 id
   */
  const rawId = pendingRawId

  return {
    'edrv.pending.list': async (args: PendingRequest) => {
      const cwd = await workspace(args.sessionId)
      const page = loadPage(cwd, args.sessionId)
      // 列表即登记接管关系；旧写入口守卫之后只读内存集合，不再产生数据库读
      for (const item of page.items) trackPendingCover(cwd, item.path, true)
      return { ok: true, page }
    },
    'edrv.pending.detail': async (args: PendingRequest & { id: string }) => {
      const cwd = await workspace(args.sessionId)
      const detail = loadDetail(cwd, rawId(args.id))
      return detail ? { ok: true, detail } : { ok: false, error: '待审条目不存在' }
    },
    'edrv.pending.decide': async (args) => {
      const cwd = await liveWorkspace(args.sessionId)
      try {
        const id = rawId(args.id)
        const result = await applyDecide(ctx.get('fs'), cwd, { ...args, id }, undefined, policyOf(ctx, sessionOf(ctx, args.sessionId)))
        if (!result.ok) return { ok: false, error: result.reason }
        const detail = loadDetail(cwd, id)
        if (!detail) return { ok: false, error: '待审条目不存在' }
        return { ok: true, item: detail.item, wrote: result.wrote }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    'edrv.pending.remove': async (args) => {
      const cwd = await liveWorkspace(args.sessionId)
      const id = rawId(args.id)
      const path = loadEntries(cwd).find((stored) => stored.entry.id === id)?.entry.path
      const removed = removeEntry(cwd, id, args.revision)
      // 移除后该路径不再由待审投影接管，旧入口守卫随之放行
      if (removed && path) trackPendingCover(cwd, path, false)
      return { ok: true, removed }
    },
    'edrv.pending.history': async (args) => {
      const cwd = await liveWorkspace(args.sessionId)
      try {
        const result = await undoDecide(ctx.get('fs'), cwd, args, undefined, policyOf(ctx, sessionOf(ctx, args.sessionId)))
        if (!result.ok) return { ok: false, error: result.reason }
        return { ok: true, item: result.item, wrote: result.wrote }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    'edrv.pending.import': async (args) => {
      const cwd = await liveWorkspace(args.sessionId)
      const raw = ctx.get('shell') as unknown as ShellLike | undefined
      if (!raw) return { ok: false, error: '当前环境没有 shell 能力，无法读取版本库基线' }
      // shell 执行器默认按 workspace-write 跑；本机没有可用沙箱后端时会直接拒绝，
      // 所以按会话策略显式下发（会话已放宽时命令才能跑起来）。
      const policy = policyOf(ctx, sessionOf(ctx, args.sessionId))
      const shell: ShellLike = {
        resolve: (request) => raw.resolve(policy ? { ...request, sandboxPolicy: policy } : request),
        execute: (spec) => raw.execute(spec),
      }
      try {
        const result = await importFromVcs(shell, cwd, args.sessionId, { includeUntracked: args.includeUntracked, path: args.path })
        const page = loadPage(cwd, args.sessionId)
        for (const item of page.items) trackPendingCover(cwd, item.path, true)
        return { ok: true, imported: result.imported, changes: result.changes }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    'edrv.pending.refresh': async (args: PendingRequest & { id: string }) => {
      const cwd = await liveWorkspace(args.sessionId)
      const id = rawId(args.id)
      const stored = loadEntries(cwd).find((entry) => entry.entry.id === id)
      if (!stored) return { ok: false, error: '待审条目不存在' }
      const session = sessionOf(ctx, args.sessionId)
      const fs = ctx.get('fs')
      const target = await fs.resolve(id, { cwd, agent: session })
      const content = await readText(fs, target).catch(() => undefined)
      if (content === undefined) return { ok: false, error: '读取失败' }
      const next = refreshed(stored, content, Date.now())
      if (next) saveEntry(cwd, next)
      return { ok: true, item: itemOf(next ?? stored) }
    },
  }
}
