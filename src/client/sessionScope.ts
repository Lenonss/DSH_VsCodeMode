/**
 * dsh-vscode-mode client — 会话作用域解析（跨 DSH 版本适配）。
 *
 * 背景：DSH 0.1.6-alpha.2 随「客户端 Session 多实例共存」移除了 `sessions.list`
 * 快照的 `current` / `currentAddress` 字段（alpha.1 及更早仍发布 `current`）。
 * 官方替代面是 `ctx.uiSession.current`（`HostObservable<StandardSourceBinding>`，
 * 其 `key` 即当前会话 id；绑定行由官方 ui-session 依 retainInfo.mainView 推出）。
 *
 * 本模块把「当前会话」收敛为单一三级取值链，并附可订阅的变更通知：
 *   1. `uiSession.current.key`（0.1.6-alpha.2+ 权威）
 *   2. `sessions.list.current`（rc 线 / 0.1.6-alpha.1 及更早）
 *   3. `sessions.list.byId` 中 `retainedBy.mainView > 0` 的首行（新版兜底，与官方同判据）
 *   4. 槽位注入的 sessionId（最后兜底）
 *
 * 约束：`uiSession` 不进 `inject`（旧版 DSH 无此服务，进 inject 会让插件停等），
 * 一律 `ctx.get` 可选探测；任一来源缺失/异常都降级，不抛错、不阻断其他两级。
 * 取值纯逻辑（pickSessionScope 等）可在 node 环境单测。
 * 作者 ddj 2026年09月18号
 */

/** 解析出的会话作用域：sessionId 可能缺失；cwd 仅在 list 快照可读时给出。 */
export interface SessionScope {
  sessionId?: string
  cwd?: string
}

/** 取值链的候选来源（三者都可缺失，缺失即跳过该级）。 */
export interface ScopeSources {
  /** `ctx.uiSession.current` 快照（0.1.6-alpha.2+ 权威来源；binding.key = sessionId）。 */
  uiSession?: unknown
  /** `ctx.sessions.list` 快照（旧版含 `current`；新版只有 `ids`/`byId`）。 */
  list?: unknown
  /** 槽位注入的 sessionId（前几级都拿不到时的最后兜底）。 */
  fallbackSessionId?: unknown
}

/** 对象窄化（非对象返回 undefined，供后续安全取字段）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

/** 非空字符串取值（其他类型一律视为缺失）。 */
function strOf(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * 从 `uiSession.current` 快照读出 sessionId。
 * 兼容两种形态：绑定源本身（`{ key }`）与其包裹形态（`{ value: { key } }`）——
 * 官方 `createBindingSource` 的 `getSnapshot()` 返回绑定值本身，但跨版本包裹层存在差异，
 * 故两者都尝试。
 * @author ddj 2026年09月18号
 * @param snapshot `uiSession.current` 的 `getSnapshot()` 结果（任意形状）
 * @returns sessionId，或 undefined
 */
export function uiSessionIdOf(snapshot: unknown): string | undefined {
  const binding = asRecord(snapshot)
  if (!binding) return undefined
  return strOf(binding.key) ?? strOf(asRecord(binding.value)?.key)
}

/**
 * 从 `sessions.list` 快照读出 sessionId。
 * 先取旧版 `current`；缺失时回退 `byId` 中 `retainedBy.mainView > 0` 的首行
 * （与官方 ui-session 的 publishMain 同判据，故新版行为与官方视图一致）。
 * @author ddj 2026年09月18号
 * @param list `sessions.list` 的 `getSnapshot()` 结果（任意形状）
 * @returns sessionId，或 undefined
 */
export function listSessionId(list: unknown): string | undefined {
  const snap = asRecord(list)
  if (!snap) return undefined
  const current = strOf(snap.current)
  if (current) return current
  const byId = asRecord(snap.byId)
  if (!byId) return undefined
  for (const [id, row] of Object.entries(byId)) {
    const mainView = asRecord(asRecord(row)?.retainedBy)?.mainView
    if (typeof mainView === 'number' && mainView > 0) return id
  }
  return undefined
}

/**
 * 三级取值链（纯函数）：决定当前会话 id 与其 cwd。
 * 优先级 uiSession > list.current > list.byId.retainedBy > fallback。
 * @author ddj 2026年09月18号
 * @param sources 候选来源集合
 * @returns 会话作用域（字段缺失即省略该键，不写 undefined 占位）
 */
export function pickSessionScope(sources: ScopeSources): SessionScope {
  const sessionId = uiSessionIdOf(sources.uiSession)
    ?? listSessionId(sources.list)
    ?? strOf(sources.fallbackSessionId)
  if (!sessionId) return {}
  const byId = asRecord(asRecord(sources.list)?.byId)
  const cwd = strOf(asRecord(byId?.[sessionId])?.cwd)
  return cwd ? { sessionId, cwd } : { sessionId }
}

/** 读 `ctx.get(name)`（缺失/异常返回 undefined，不抛错）。 */
function safeGet(ctx: { get: (name: string) => unknown }, name: string): unknown {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** 取 `uiSession.current` 快照（服务或订阅面缺失时返回 undefined）。 */
function uiCurrentSnapshot(ctx: { get: (name: string) => unknown }): unknown {
  const uiSession = asRecord(safeGet(ctx, 'uiSession'))
  const current = asRecord(uiSession?.current)
  const getSnapshot = current?.getSnapshot
  if (typeof getSnapshot !== 'function') return undefined
  try {
    return (getSnapshot as () => unknown).call(current)
  } catch {
    return undefined
  }
}

/** 取 `sessions.list` 快照（服务缺失时返回 undefined）。 */
function listSnapshot(ctx: { get: (name: string) => unknown }): unknown {
  const sessions = asRecord(safeGet(ctx, 'sessions'))
  const list = asRecord(sessions?.list)
  const getSnapshot = list?.getSnapshot
  if (typeof getSnapshot !== 'function') return undefined
  try {
    return (getSnapshot as () => unknown).call(list)
  } catch {
    return undefined
  }
}

/**
 * 读当前会话作用域（服务面取值 + 三级链）。
 * @author ddj 2026年09月18号
 * @param ctx 客户端根上下文（只需 `get`）
 * @param fallbackSessionId 槽位注入的 sessionId（可选）
 * @returns 会话作用域
 */
export function readSessionScope(ctx: { get: (name: string) => unknown }, fallbackSessionId?: unknown): SessionScope {
  return pickSessionScope({
    uiSession: uiCurrentSnapshot(ctx),
    list: listSnapshot(ctx),
    fallbackSessionId,
  })
}

/**
 * 订阅会话切换（同时挂 `uiSession.current` 与新/旧 `sessions.list`）。
 * 旧版无 `uiSession`，新版 `list` 不再变（切会话只动 uiSession），故两条都要挂；
 * 回调可能因两条源先后触发而重复，调用方按上一次 sessionId 自行去重。
 * @author ddj 2026年09月18号
 * @param ctx 客户端根上下文（只需 `get`）
 * @param listener 变更回调
 * @returns 取消订阅函数（幂等）
 */
export function subscribeScope(ctx: { get: (name: string) => unknown }, listener: () => void): () => void {
  const disposers: Array<() => void> = []
  const attach = (owner: unknown): void => {
    const subscribe = asRecord(owner)?.subscribe
    if (typeof subscribe !== 'function') return
    try {
      const disposer = (subscribe as (fn: () => void) => unknown).call(owner, listener)
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
    } catch {
      /* 订阅面异常：放弃该源，不影响其他源 */
    }
  }
  attach(asRecord(asRecord(safeGet(ctx, 'uiSession'))?.current))
  attach(asRecord(asRecord(safeGet(ctx, 'sessions'))?.list))
  return () => {
    for (const disposer of disposers.splice(0)) {
      try {
        disposer()
      } catch {
        /* 卸载异常不影响其余清理 */
      }
    }
  }
}
