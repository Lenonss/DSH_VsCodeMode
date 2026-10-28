/**
 * dsh-vscode-mode host — 工作区记录桶注册表与会话助手。
 * 迁移自原 src/index.ts 的 registry/sessionOf/cwdOf/bucketOf，语义不改。
 * 作者 ddj 2026-08-20
 */
import type { DiffRecord } from './shared/types.js'
import type { Ctx, Session } from './store.js'
import { cwdOfSession, loadBucket } from './store.js'
import { SESSION_MISSING_ERROR, SESSION_NO_WORKSPACE_ERROR } from './shared/rpc.js'

/** cwd → 记录桶（内存缓存；随会话销毁清理）。 */
export type Registry = Map<string, Map<string, DiffRecord>>

/** 会话作用域：本进程 live 会话可带 session；跨实例冷读只有已确认的 cwd。 */
export interface SessionScope {
  /** 本进程 live 会话；冷读持久化会话时为 undefined。 */
  session?: Session
  /** 已确认的绝对工作区路径。 */
  cwd: string
}

/** sessionQuery 会话记录的最小读取面：只取 header.cwd，不依赖 DSH 类型包。 */
interface ColdSessionRecord {
  header?: { id?: string; cwd?: string }
}

/** sessionId → cwd 冷读缓存：header.cwd 建会话后不可变，故只增不改。 */
const coldCwdCache = new Map<string, string>()
/** 冷读缓存上限：超出后整表清空，避免长跑实例无限累积。 */
const COLD_CWD_CACHE_MAX = 2048

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

/**
 * 解析会话作用域：优先本进程 live 会话；未命中时冷读持久化会话头取 cwd。
 * 仅供只读 RPC 使用——桌面端与 Web 端各有独立宿主，会话只在创建端 live，
 * 但审查数据按 cwd 落盘、跨实例可读；写类 RPC 必须另行要求 live 会话。
 * @author ddj 2026年10月28号
 * @param ctx DSH 上下文（可选探测 sessions 与 sessionQuery）
 * @param sessionId 目标会话 id（冷读必需；缺省时只认唯一活跃会话）
 * @returns 会话作用域，或与 requireSession 同源的错误文案
 */
export async function resolveScope(ctx: Ctx, sessionId: string | undefined): Promise<SessionScope | { err: string }> {
  const session = sessionOf(ctx, sessionId)
  if (session) {
    const cwd = cwdOfSession(ctx, session)
    return cwd ? { session, cwd } : { err: SESSION_NO_WORKSPACE_ERROR }
  }

  const cwd = await coldCwdOf(ctx, sessionId)
  return cwd ? { cwd } : { err: SESSION_MISSING_ERROR }
}

/**
 * 冷读持久化会话头的 cwd：走 DSH sessionQuery 的持久化视图，不读事件日志、不碰写句柄。
 * @author ddj 2026年10月28号
 * @param ctx DSH 上下文
 * @param sessionId 目标会话 id
 * @returns 绝对路径；服务缺失、查无此会话或读取失败时 null（失败语义等同 live 未命中）
 */
export async function coldCwdOf(ctx: Ctx, sessionId: string | undefined): Promise<string | null> {
  if (!sessionId) return null
  const cached = coldCwdCache.get(sessionId)
  if (cached) return cached

  const query = ctx?.get?.('sessionQuery')
  if (!query) return null

  try {
    const record = await findColdRecord(query, sessionId)
    const cwd = record?.header?.cwd
    if (typeof cwd !== 'string' || !cwd) return null
    rememberColdCwd(sessionId, cwd)
    return cwd
  } catch {
    // 冷读故障不改语义：仍按「会话不存在」上报，避免把存储异常说成权限问题
    return null
  }
}

/**
 * 在 sessionQuery 的持久化会话视图里定位一条记录（优先精确过滤，其次整表列举）。
 * 两种能力都缺失时返回 null，调用方回落原有「会话不存在」。
 * @author ddj 2026年10月28号
 * @param query ctx.sessionQuery 服务（不同 DSH 版本能力不同）
 * @param sessionId 目标会话 id
 * @returns 会话记录；无此会话或能力缺失时 null
 */
async function findColdRecord(query: Ctx, sessionId: string): Promise<ColdSessionRecord | null> {
  const filterable = typeof query.filterSessions === 'function'
  const listable = typeof query.listSessions === 'function'
  if (!filterable && !listable) return null

  const records = filterable
    ? await query.filterSessions([{ kind: 'id', values: [sessionId] }])
    : await query.listSessions()
  if (!Array.isArray(records)) return null

  return records.find((item: ColdSessionRecord) => item?.header?.id === sessionId) ?? null
}

/**
 * 记录冷读结果（header.cwd 不可变，可长期复用）。
 * @author ddj 2026年10月28号
 * @param sessionId 目标会话 id
 * @param cwd 已确认的绝对工作区路径
 */
function rememberColdCwd(sessionId: string, cwd: string): void {
  if (coldCwdCache.size >= COLD_CWD_CACHE_MAX) coldCwdCache.clear()
  coldCwdCache.set(sessionId, cwd)
}
