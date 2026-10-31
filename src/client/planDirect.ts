/**
 * dsh-vscode-mode client — 计划地址直通。
 *
 * 背景：官方计划卡片「查看全文」调 `ctx.sidebarRight.openResource(planAddress)`，
 * 侧栏会先创建计划页签、再由本插件认领并立刻关闭，桌面端表现为「快速打开又迅速关闭」。
 * 本模块在装配时包装该服务方法：能直接拿到计划正文时改为把只读计划送进「文件编辑」，
 * 不再创建侧栏页签；地址不属于在屏会话、正文暂不可得、编辑器未回执或包装未生效时
 * 一律回落原方法，官方页签与原认领转交链路继续作为后备。
 * 作者 ddj 2026年10月31号
 */

import { log } from './log.js'
import { requestOpen } from './openReceipt.js'
import { cachedPlan, isPlanAddress, planDocument, rememberPlan, type PlanDocument } from './planState.js'
import { readSessionScope } from './sessionScope.js'

//region 对外结构面

/** 官方 openResource 的可选参数（临时回顾页签的正文在 params.planReview 里）。 */
export interface PlanOpenOptions { kind?: string; params?: unknown }

/** sidebarRight 的最小结构面：只接管 openResource 的调用。 */
export interface PlanServiceLike { openResource?: (address: string, options?: PlanOpenOptions) => void }

/** 直通装配结果：native 绕过包装回落原方法，dispose 中止在途并条件还原。 */
export interface PlanDirect {
  dispose: () => void
  native: (address: string, options?: PlanOpenOptions) => void
}

/** 资源流最小结构面（@deepseek-ai/dsh-client-resources 为可选依赖）。 */
interface ResourceStream { getSnapshot?: () => unknown; subscribe?: (listener: () => void) => unknown }

/** resources 服务最小结构面。 */
interface ResourcesLike { source?: (address: string) => ResourceStream | undefined }

//endregion

/** 正文解析上限：超过即回落官方页签，避免点击后长时间无反馈。 */
const RESOLVE_MS = 1_500
/** 编辑器回执上限：超过即回落官方页签。 */
const ROUTE_MS = 5_000

/** @public @author ddj 2026年10月31号
 * 可选探测客户端服务，缺失或抛错时返回 undefined。
 * @param ctx 客户端上下文（只需 get）。
 * @param name 服务名。
 * @returns 服务实例，或 undefined（不阻断装配）。
 */
export function optionalService(ctx: { get: (name: string) => unknown }, name: string): unknown {
  try { return ctx.get(name) } catch { return undefined }
}

/** @public @author ddj 2026年10月31号
 * 包装官方 openResource，把本会话的计划地址改为直通插件编辑器。
 * @param ctx 客户端上下文（可选服务一律 ctx.get 探测）。
 * @param service 官方 sidebarRight 服务；仅在赋值生效时留下包装。
 * @returns 供路由回退使用的原方法，以及卸载时中止在途并还原的清理函数。
 */
export function installPlanDirect(ctx: { get: (name: string) => unknown }, service: PlanServiceLike): PlanDirect {
  const original = service.openResource
  const pending = new Map<string, () => void>()
  let closed = false
  let installed = false

  //region 判定与参数

  /** @private @author ddj 2026年10月31号
   * 解码地址段（畸形编码一律视为不可接管）。
   * @param address 官方资源地址。
   * @returns 去掉协议前缀后的解码段。
   */
  function decode(address: string): string[] | undefined {
    try { return address.split('/').slice(3).map(decodeURIComponent) } catch { return undefined }
  }

  /** @private @author ddj 2026年10月31号
   * 判断该地址是否由本插件接管：只认两段式计划地址，且归属当前在屏会话。
   * @param address 官方资源地址。
   * @returns 可接管的会话 id，其他情况 undefined（回落原方法）。
   */
  function take(address: string): string | undefined {
    if (closed || !isPlanAddress(address)) return undefined

    const segments = decode(address)
    if (segments?.length !== 2) return undefined

    const current = readSessionScope(ctx).sessionId ?? ''
    return current !== '' && segments[0] === current ? current : undefined
  }

  /** @private @author ddj 2026年10月31号
   * 读官方参数里随页签携带的计划正文（临时回顾页签走这里）。
   * @param address 官方资源地址。
   * @param options 官方 openResource 参数。
   * @returns 计划正文，或不带正文时 undefined。
   */
  function inline(address: string, options?: PlanOpenOptions): PlanDocument | undefined {
    const params = options?.params
    if (params === null || typeof params !== 'object') return undefined
    return planDocument(address, (params as { planReview?: unknown }).planReview)
  }

  //endregion

  //region 资源解析

  /** @private @author ddj 2026年10月31号
   * 打开计划资源流。
   * @param services resources 服务。
   * @param address 官方资源地址。
   * @returns 资源流；服务缺失或抛错时 undefined。
   */
  function streamOf(services: ResourcesLike | undefined, address: string): ResourceStream | undefined {
    try { return services?.source?.(address) } catch { return undefined }
  }

  /** @private @author ddj 2026年10月31号
   * 从资源快照读已就绪的计划正文。
   * @param address 官方资源地址。
   * @param stream 计划资源流。
   * @returns 计划正文；未就绪、失败或内容不完整时 undefined。
   */
  function planOf(address: string, stream: ResourceStream): PlanDocument | undefined {
    let snapshot: unknown
    try { snapshot = stream.getSnapshot?.() } catch { return undefined }

    const state = snapshot !== null && typeof snapshot === 'object' ? snapshot as { status?: unknown; value?: unknown } : {}
    return state.status === 'live' ? planDocument(address, state.value) : undefined
  }

  /** @private @author ddj 2026年10月31号
   * 订阅资源快照变化。
   * @param stream 计划资源流。
   * @param listener 变更监听。
   * @returns 退订函数；订阅面缺失或抛错时为 no-op。
   */
  function watchStream(stream: ResourceStream, listener: () => void): () => void {
    try {
      const off = stream.subscribe?.(listener)
      return typeof off === 'function' ? off as () => void : () => undefined
    } catch { return () => undefined }
  }

  //endregion

  //region 直通与回落

  /** @private @author ddj 2026年10月31号
   * 回落官方方法（包装外的原入口）。
   * @param address 官方资源地址。
   * @param options 官方参数。
   * @returns 无；失败只记日志，不影响点击链路。
   */
  function native(address: string, options?: PlanOpenOptions): void {
    if (typeof original !== 'function') return
    try { original.call(service, address, options) } catch (error) { log.warn('官方计划页签回退失败：' + String(error)) }
  }

  /** @private @author ddj 2026年10月31号
   * 把已解析的计划送进插件编辑器；地址级在途合并，重复点击不叠开。
   * @param plan 计划正文。
   * @param session 归属会话。
   * @param address 官方资源地址。
   * @param options 官方参数（回落时原样透传）。
   * @returns 无；未就绪或失败时回落官方页签，但不劫持已切换的会话。
   */
  function direct(plan: PlanDocument, session: string, address: string, options?: PlanOpenOptions): void {
    if (closed || pending.has(address)) return

    const controller = new AbortController()
    pending.set(address, () => { pending.delete(address); controller.abort() })
    rememberPlan(plan)

    /** @private @author ddj 2026年10月31号 @param ok 编辑器是否就绪。 @returns 无；失败时回落官方页签。 */
    function settle(ok: boolean): void {
      pending.delete(address)
      if (ok || closed || readSessionScope(ctx).sessionId !== session) return
      native(address, options)
    }
    requestOpen(null, undefined, undefined, session, { preview: true, plan, signal: controller.signal, timeoutMs: ROUTE_MS })
      .then(settle, (error: unknown) => { log.warn('计划直通失败：' + String(error)); settle(false) })
  }

  /** @private @author ddj 2026年10月31号
   * 从计划资源异步解析正文，就绪后直通；超时或无法解析回落官方页签。
   * @param address 官方资源地址。
   * @param session 归属会话。
   * @param options 官方参数。
   * @returns 无。
   */
  function lookup(address: string, session: string, options?: PlanOpenOptions): void {
    const stream = streamOf(optionalService(ctx, 'resources') as ResourcesLike | undefined, address)
    if (stream === undefined) { native(address, options); return }

    const early = planOf(address, stream)
    if (early !== undefined) { direct(early, session, address, options); return }
    if (closed || pending.has(address)) return

    let timer: ReturnType<typeof setTimeout> | undefined
    let stop: (() => void) | undefined
    let done = false

    /** @private @author ddj 2026年10月31号 @param ok 是否已拿到正文。 @returns 无；幂等收尾，清定时器、退订、释放地址。 */
    function finish(ok: boolean): void {
      if (done) return
      done = true
      if (timer !== undefined) clearTimeout(timer)
      stop?.()
      pending.delete(address)
      if (!ok && !closed) native(address, options)
    }
    pending.set(address, () => finish(false))
    timer = setTimeout(() => finish(false), RESOLVE_MS)
    stop = watchStream(stream, () => {
      const plan = planOf(address, stream)
      if (plan === undefined) return
      finish(true)
      direct(plan, session, address, options)
    })
  }

  //endregion

  //region 装配

  /** @private @author ddj 2026年10月31号 @param address 官方资源地址。 @param options 官方参数。 @returns 无；包装后的 openResource 入口。 */
  function open(address: string, options?: PlanOpenOptions): void {
    const session = take(address)
    if (session === undefined) { native(address, options); return }

    const known = inline(address, options) ?? cachedPlan(address)
    if (known !== undefined) { direct(known, session, address, options); return }
    lookup(address, session, options)
  }

  /** @private @author ddj 2026年10月31号 @returns 无；赋值后校验，未生效即降级为原认领转交链路。 */
  function mount(): void {
    if (typeof original !== 'function') return
    try { service.openResource = open } catch (error) { log.warn('计划直通装配失败：' + String(error)) }
    installed = service.openResource === open
    if (installed) return
    try { service.openResource = original } catch { /* 只读服务：保持原状 */ }
  }

  /** @private @author ddj 2026年10月31号 @returns 无；仅在包装仍是自己时还原（HMR 安全）。 */
  function unmount(): void {
    if (!installed || service.openResource !== open) return
    try { service.openResource = original } catch (error) { log.warn('计划直通还原失败：' + String(error)) }
    installed = false
  }

  /** @private @author ddj 2026年10月31号 @returns 无；卸载时先标记关闭，再中止在途并还原官方方法。 */
  function dispose(): void {
    if (closed) return
    closed = true
    for (const cancel of [...pending.values()]) { try { cancel() } catch { /* 收尾失败不影响卸载 */ } }
    pending.clear()
    unmount()
  }

  mount()
  return { dispose, native }

  //endregion
}
