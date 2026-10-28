/** Session-scoped official review RPC. @author ddj 2026年10月26号 */
import type { RpcHandlerMap } from './shared/rpc.js'
import { decideReview, reviewDetail, reviewPage } from './reviewDb.js'
import { undoReview } from './reviewUndo.js'
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
  return {
    'edrv.review.list': async (args) => {
      const cwd = await workspace(args.sessionId)
      return { ok: true, page: reviewPage(cwd, args.cursor, args.history, args.path) }
    },
    'edrv.review.detail': async (args) => {
      const cwd = await workspace(args.sessionId)
      const detail = reviewDetail(cwd, args.id)
      return detail ? { ok: true, detail } : { ok: false, error: '官方审查记录不存在' }
    },
    'edrv.review.decide': async (args) => {
      // 写类操作要求 live 会话：避免两端并发写同一工作区审查库，回滚也依赖本端会话内容
      const cwd = await liveWorkspace(args.sessionId)
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
