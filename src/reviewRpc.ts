/** Session-scoped official review RPC. @author ddj 2026年10月26号 */
import type { RpcHandlerMap } from './shared/rpc.js'
import { decideReview, reviewDetail, reviewPage } from './reviewDb.js'
import { undoReview } from './reviewUndo.js'
import { bucketOf, cwdOfSession, sessionOf } from './registry.js'
import type { Registry } from './registry.js'
import type { Ctx } from './store.js'

/** @public @author ddj 2026年10月26号 @param ctx Host. @param registry Workspace cache. @returns Handlers resolving workspace from the live authenticated session, never caller cwd. */
export function reviewHandlers(ctx: Ctx, registry: Registry): Partial<RpcHandlerMap> {
  /** @private @author ddj 2026年10月26号 @param sessionId Request scope. @returns Migrated workspace, or explicit failure without fallback. */
  async function workspace(sessionId: string): Promise<string> {
    const session = sessionOf(ctx, sessionId)
    const cwd = cwdOfSession(ctx, session)
    if (!session || !cwd) throw new Error('会话不存在或没有工作区')
    await bucketOf(registry, ctx, cwd)
    return cwd
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
      const cwd = await workspace(args.sessionId)
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
