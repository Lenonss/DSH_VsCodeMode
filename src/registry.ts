/**
 * dsh-vscode-mode host — 工作区记录桶注册表与会话助手。
 * 迁移自原 src/index.ts 的 registry/sessionOf/cwdOf/bucketOf，语义不改。
 * 作者 ddj 2026-08-20
 */
import type { DiffRecord } from './shared/types.js'
import type { Ctx, Session } from './store.js'
import { cwdOfSession, loadBucket } from './store.js'

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

/**
 * 会话工作区 cwd（跟随会话内 cd；服务缺失时回落 header.cwd）。
 * 定义在 store.ts 以避免 registry ↔ store 循环依赖，此处仅转出为会话助手入口。
 * @author ddj 2026年10月19号
 */
export { cwdOfSession }

/**
 * 会话头部的原始 cwd（不跟随 cd）。仅用于会话销毁等无上下文场景：
 * 此时投影可能已随会话卸载，读 header 才能保证拿到建会话时的目录。
 * @author ddj 2026年10月19号
 * @param session 目标会话
 * @returns 绝对路径或 null
 */
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
