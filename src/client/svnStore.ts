/**
 * dsh-vscode-mode client — SVN 数据源通用缓存层（scope 缓存 + 在途去重 + 事件广播）。
 *
 * 为什么抽工厂：status/changes 两套实现完全同形（cache/inFlight/latest/emit 四件套），
 * P3 的 log 与 P4 的 commitPlan 还要再来两遍。重复的不只是十几行样板，更关键的是
 * 「未加载(null) vs 已加载但为空([])」与「失败不写缓存」这两条语义——各写一遍必然漂移。
 *
 * 语义约定（所有 SVN 数据源一致）：
 * - `get` 未加载返回 null（调用方据此显示「读取中」而非「空」）
 * - 失败（ok:false / 抛错）**不写缓存**，保持「未加载」，避免把「未知」当「无数据」
 * - 在途请求按 key 去重：同一 key 并发只看一次 RPC
 * - `force` 绕过客户端缓存（host 侧 TTL 由 force 参数继续透传）
 * 作者 ddj 2026年09月16号
 */
import type { RpcMethod, RpcRequestMap, RpcResult } from '../shared/rpc.js'
import { rpc } from './rpc.js'

/**
 * 轻量诊断 trace（dsh-debug 埋点协议）：写入 window.__DSH_DEBUG_LOG__（环形 500 条），
 * 浏览器端 readback 定位 RPC/事件链路问题；异常静默，绝不干扰主流程。
 * @author ddj 2026年09月18号
 * @param event 事件名（建议 `模块.动作`）
 * @param data 附加诊断数据（不含敏感信息）
 */
export function dshTrace(event: string, data?: unknown): void {
  try {
    if (typeof window === 'undefined') return
    const w = window as unknown as { __DSH_DEBUG_LOG__?: Array<Record<string, unknown>> }
    const buf = (w.__DSH_DEBUG_LOG__ = w.__DSH_DEBUG_LOG__ || [])
    buf.push({ t: Date.now(), plugin: 'dsh-vscode-mode', event, data })
    if (buf.length > 500) buf.splice(0, buf.length - 500)
  } catch { /* 诊断不干扰主流程 */ }
}

/** 一个数据源的最小配置。 */
export interface SvnStoreConfig<M extends RpcMethod, T> {
  /** 对应的 RPC 方法名。 */
  method: M
  /**
   * 请求参数（除 sessionId/force 外的固定部分按 key 计算）。
   * @param key 缓存键（scope 或 `scope::目标` 复合键）
   */
  args?: (key: string) => Omit<RpcRequestMap[M], 'sessionId' | 'force'>
  /**
   * 从成功载荷中抽出要缓存的数据与附带标记。
   * @param res 成功响应
   */
  select: (res: ({ ok: true } & Record<string, unknown>)) => { value: T; meta?: Record<string, unknown> }
  /** 广播事件名（`edrv:svn-*`）；缺省不广播。 */
  event?: string
}

/** 数据源实例（供渲染层读取与命令判定）。 */
export interface SvnStore<M extends RpcMethod, T> {
  /**
   * 拉取（命中缓存或已在途则跳过）。
   * @param extra 调用期动态参数（如「加载更多」的 limit；覆盖 args 的同名字段，P1-8）
   */
  ensure: (sessionId: string | undefined, key: string | null | undefined, force?: boolean, extra?: Record<string, unknown>) => void
  /** 读缓存（未加载返回 null）。 */
  get: (key: string | null | undefined) => T | null
  /** 附带标记（如 truncated）。 */
  meta: (key: string | null | undefined) => Record<string, unknown>
  /** 最近一次加载的值（跨 key 镜像；命令可用性判定用）。 */
  latest: () => T | null
  /** 清缓存并强制重取。 */
  refresh: (sessionId: string | undefined, key: string | null | undefined, extra?: Record<string, unknown>) => void
  /** 丢弃缓存（不重取）。 */
  clear: (key?: string | null) => void
  /** 用现成数据直接写入（动作后本地乐观更新/就地改值）。 */
  put: (key: string, value: T, meta?: Record<string, unknown>) => void
}

/**
 * 创建 SVN 数据源缓存实例。
 * @author ddj 2026年09月16号
 * @param config 数据源配置
 * @returns 数据源实例
 */
export function createSvnStore<M extends RpcMethod, T>(config: SvnStoreConfig<M, T>): SvnStore<M, T> {
  const cache = new Map<string, T>()
  const metas = new Map<string, Record<string, unknown>>()
  const inFlight = new Map<string, Promise<void>>()
  let latestValue: T | null = null

  const emit = (key: string): void => {
    if (!config.event || typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent(config.event, { detail: { scope: key, key } }))
  }

  const ensure = (sessionId: string | undefined, key: string | null | undefined, force = false, extra?: Record<string, unknown>): void => {
    if (!key || inFlight.has(key)) return
    if (!force && cache.has(key)) return
    const fixed = config.args ? config.args(key) : {}
    const task = rpc(config.method, { ...fixed, ...extra, sessionId, force: force || undefined } as RpcRequestMap[M])
      .then((res) => {
        if (!res.ok) {
          dshTrace('svnStore.rpcError', { method: config.method, key, error: (res as { error?: string }).error })
          return
        }
        const picked = config.select(res as { ok: true } & Record<string, unknown>)
        cache.set(key, picked.value)
        if (picked.meta) metas.set(key, picked.meta)
        latestValue = picked.value
        emit(key)
      })
      .catch((err) => {
        // 拉取失败保持旧值；未加载过即保持「未加载」（诊断 trace 供 dsh-debug 读回定位）
        dshTrace('svnStore.fetchError', { method: config.method, key, error: String(err) })
      })
      .finally(() => {
        inFlight.delete(key)
      })
    inFlight.set(key, task as Promise<void>)
  }

  const refresh = (sessionId: string | undefined, key: string | null | undefined, extra?: Record<string, unknown>): void => {
    if (!key) return
    cache.delete(key)
    ensure(sessionId, key, true, extra)
  }

  return {
    ensure,
    get: (key) => (key ? cache.get(key) ?? null : null),
    meta: (key) => (key ? metas.get(key) ?? {} : {}),
    latest: () => latestValue,
    refresh,
    clear: (key) => {
      if (key) { cache.delete(key); metas.delete(key) }
      else { cache.clear(); metas.clear() }
    },
    put: (key, value, meta) => {
      cache.set(key, value)
      if (meta) metas.set(key, meta)
      latestValue = value
      emit(key)
    },
  }
}

/** 复合缓存键（同一数据源按多个维度缓存，如日志按 target 区分）。 */
export function svnStoreKey(scope: string, target?: string | null): string {
  return target ? scope + '\u0000' + target : scope
}

/** 类型守卫：成功响应（便于 select 里安全取字段）。 */
export function isOkResult<M extends RpcMethod>(res: RpcResult<M>): res is { ok: true } & Record<string, unknown> {
  return Boolean(res && (res as { ok?: unknown }).ok === true)
}
