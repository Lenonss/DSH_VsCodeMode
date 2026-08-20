/**
 * dsh-vscode-mode host — 工作区记录桶注册表与会话助手。
 * 迁移自原 src/index.ts 的 registry/sessionOf/cwdOf/bucketOf，语义不改。
 * 作者 ddj 2026-08-20
 */
import type { DiffRecord } from './shared/types.js'
import type { Ctx, Session } from './store.js'
import { loadBucket } from './store.js'

/** cwd → 记录桶（内存缓存；随会话销毁清理）。 */
export type Registry = Map<string, Map<string, DiffRecord>>

/** 按 sessionId 取会话；缺省时仅当唯一活跃会话才返回。 */
export function sessionOf(ctx: Ctx, sessionId?: string): Session | undefined {
  const sessions = ctx.get('sessions')
  if (!sessions) return undefined
  if (sessionId) return sessions.get(sessionId)
  const live = sessions.list().filter((s: Session) => s.id)
  return live.length === 1 ? live[0] : undefined
}

/** 会话工作区 cwd。 */
export function cwdOf(session: Session | undefined): string | null {
  return session?.header?.cwd ?? null
}

/** 取（或加载）某工作区记录桶。 */
export function bucketOf(registry: Registry, ctx: Ctx, cwd: string): Promise<Map<string, DiffRecord>> {
  const existing = registry.get(cwd)
  if (existing) return Promise.resolve(existing)
  return loadBucket(ctx, cwd).then((map) => {
    registry.set(cwd, map)
    return map
  })
}
