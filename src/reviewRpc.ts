/** Session-scoped official review RPC. @author ddj 2026年10月26号 */
import type { RpcHandlerMap } from './shared/rpc.js'
import type { PendingPage } from './shared/pendingReview.js'
import { decideReview, reviewDetail, reviewPage } from './reviewDb.js'
import { undoReview } from './reviewUndo.js'
import { applyDecide, loadDetail, loadPage } from './pending/store.js'
import { PENDING_PREFIX, mergedPage, pendingDetailOf, pendingItemOf, pendingSamePath } from './pendingCompat.js'
import { bucketOf, resolveScope, sessionOf } from './registry.js'
import type { Registry } from './registry.js'
import type { Ctx } from './store.js'

/**
 * @public
 * @author ddj 2026年10月26号 / 2026年10月28号
 * @description: 审查 RPC 处理器。工作区一律由 host 解析，绝不采信调用方 cwd：
 * 读路径优先 live 会话、其次冷读持久化会话头（跨实例只读）；写路径仍须 live 会话。
 * @param ctx Host 上下文
 * @param registry 工作区记录桶缓存
 * @returns 审查相关处理器表
 */
export function reviewHandlers(ctx: Ctx, registry: Registry): Partial<RpcHandlerMap> {
  /** @private @author ddj 2026年10月28号 @param sessionId 请求作用域 @returns 已迁移工作区（允许跨实例冷读） */
  async function workspace(sessionId: string): Promise<string> {
    const scope = await resolveScope(ctx, sessionId)
    if ('err' in scope) throw new Error('会话不存在或没有工作区')
    await bucketOf(registry, ctx, scope.cwd)
    return scope.cwd
  }

  /** @private @author ddj 2026年10月28号 @param sessionId 请求作用域 @returns 本端 live 会话的工作区；冷读作用域一律拒绝写入 */
  async function liveWorkspace(sessionId: string): Promise<string> {
    const scope = await resolveScope(ctx, sessionId)
    if ('err' in scope || !scope.session) throw new Error('会话不存在或没有工作区')
    await bucketOf(registry, ctx, scope.cwd)
    return scope.cwd
  }

  /**
   * @private
   * @author ddj 2026年10月30号
   * @description: 读取待审页；待审库尚未建立或迁移失败时按空页处理。
   * 待审投影是增量能力，不能因为它让官方列表整体不可用。
   * @param cwd 工作区
   * @param sessionId 请求会话
   * @returns 待审页（失败为空页）
   */
  function pendingPageOf(cwd: string, sessionId: string): PendingPage {
    try { return loadPage(cwd, sessionId) }
    catch { return { items: [], pending: 0, nextCursor: null, gaps: [] } }
  }

  return {
    'edrv.review.list': async (args) => {
      const cwd = await workspace(args.sessionId)
      const official = reviewPage(cwd, args.cursor, args.history, args.path)
      const pending = pendingPageOf(cwd, args.sessionId)
      // 历史快照只属于官方通道；待审条目没有轮次历史，混进去会造出假的「轮次 0」。
      if (args.history) return { ok: true, page: official }
      if (args.path !== undefined) {
        // 单文件台账（差异栏「详情」展开处）必须并上该路径的待审条目，
        // 否则待审详情（块判定 + 批注 + 让 AI 应答）在这条入口上永远点不到。
        const key = args.path
        const own = pending.items.filter((item) => pendingSamePath(item.path, key)).map((item) => pendingItemOf(item, cwd))
        // 待审接管后同路径的官方轮次行只是旧口径残影：留着会让人点进只读详情，以为没有判定入口。
        const history = own.length ? official.items.filter((item) => !pendingSamePath(item.path, key)) : official.items
        return { ok: true, page: { ...official, items: [...own, ...history] } }
      }
      // 待审投影就位后由它承接被覆盖路径，官方旧行让位，同一路径只保留一个权威
      return { ok: true, page: mergedPage(official, pending, cwd) }
    },
    'edrv.review.detail': async (args) => {
      const cwd = await workspace(args.sessionId)
      if (args.id.startsWith(PENDING_PREFIX)) {
        const detail = loadDetail(cwd, args.id.slice(PENDING_PREFIX.length))
        if (!detail) return { ok: false, error: '待审条目不存在' }
        return { ok: true, detail: pendingDetailOf(detail, new Date(detail.item.updatedAt).toISOString(), cwd) }
      }
      const detail = reviewDetail(cwd, args.id)
      return detail ? { ok: true, detail } : { ok: false, error: '官方审查记录不存在' }
    },
    'edrv.review.decide': async (args) => {
      // 写类操作要求 live 会话：避免两端并发写同一工作区审查库，回滚也依赖本端会话内容
      const cwd = await liveWorkspace(args.sessionId)
      if (args.id.startsWith(PENDING_PREFIX)) {
        // 待审条目走累计基线：Keep 零写盘，Revert 写回并读回校验
        const result = await applyDecide(ctx.get('fs'), cwd, {
          sessionId: args.sessionId,
          id: args.id.slice(PENDING_PREFIX.length),
          revision: args.revision,
          operationId: args.operationId,
          decision: args.decision,
          scope: args.scope === 'hunk' ? 'block' : 'file',
          ...(args.blockId === undefined ? {} : { blockId: args.blockId }),
        })
        if (!result.ok) return { ok: false, error: result.reason }
        return { ok: true, revision: result.flags.revision }
      }
      try {
        const result = args.decision === 'rejected'
          ? await undoReview(ctx, sessionOf(ctx, args.sessionId), cwd, args)
          : decideReview(cwd, args)
        return { ok: true, ...result }
      } catch (error) {
        // Guard failures are review results, not transport failures: preserve their reason.
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
