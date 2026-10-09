/** Optional DSH plan integration; no provider or approval UI replacement. @author ddj 2026年10月08号 */
import React from 'react'
import { requestOpen } from './openReceipt.js'
import { createPlanFeed, clearPlanState, isPlanAddress, planDocument, type PlanWindow, type PlanOpen } from './planState.js'
import { detectOfficial, OFFICIAL_SLOT_NAME, type OfficialSidebar } from './officialSidebar.js'
import { readSessionScope, subscribeScope } from './sessionScope.js'
import { log } from './log.js'

interface PlanContext {
  get: (name: string) => unknown
  slots: { inject: (name: string, callback: () => unknown) => unknown; register: (spec: object, body: unknown) => unknown }
}
interface EventSource { getSnapshot: () => PlanWindow; subscribe: (listener: () => void) => () => void }
interface Sessions { binding?: (id: string) => { eventSource: EventSource } | undefined }
interface PlanTab { navigation?: { address?: string; revision?: number; params?: { planReview?: unknown } }; actions?: { close?: () => void } }
interface PlanProps {
  sessionId?: string
  useTabInfo?: () => { tab?: PlanTab }
  useResource?: (address: string) => { status: string; value?: unknown }
}
const CLAIM_ID = 'dsh-vscode-mode/plan'
const CLAIM_KIND = 'edrvPlan'
const EMPTY_RESOURCE = { status: 'none' }

/** @private @author ddj 2026年10月08号 @param ctx Optional context. @param name Service name. @returns Service or undefined without gating plugin activation. */
function optional(ctx: PlanContext, name: string): unknown {
  try { return ctx.get(name) } catch { return undefined }
}
/** @private @author ddj 2026年10月08号 @param tab Current tab. @returns Native plan fallback options, preserving transient review parameters. */
function nativeOptions(tab: PlanTab | undefined): { kind: string; params?: unknown } {
  return { kind: 'plan', params: tab?.navigation?.params }
}
/** @private @author ddj 2026年10月08号 @param ctx Optional context. @param official Sidebar services. @returns Transfer component with native fallback and cancellable receipts. */
function planRouter(ctx: PlanContext, official: OfficialSidebar) {
  const transfers = new Map<string, { controller: AbortController; sessionId: string }>()
  /** @private @author ddj 2026年10月08号 @param all Plugin disposal. Cancel scope-stale transfers, not transfers merely hidden by the editor mount. */
  function cancel(all = false): void {
    for (const [key, transfer] of transfers) {
      if (!all && transfer.sessionId === readSessionScope(ctx).sessionId) continue
      transfer.controller.abort()
      transfers.delete(key)
    }
  }
  /** @private @author ddj 2026年10月08号 React to owning-session changes without cancelling on unrelated list updates. */
  function scopeChanged(): void { cancel() }
  const offScope = subscribeScope(ctx, scopeChanged)
  /** @private @author ddj 2026年10月08号 @param props Official slot props. @returns Transfer status; only closes after preview readiness. */
  function PlanRouter(props: PlanProps) {
    const tab = props.useTabInfo?.()?.tab
    const nav = tab?.navigation
    const address = nav?.address ?? ''
    const resource = props.useResource?.(address) ?? EMPTY_RESOURCE
    const review = nav?.params?.planReview
    const plan = planDocument(address, review ?? ('value' in resource ? resource.value : undefined))
    const [failed, setFailed] = React.useState(false)
    const done = React.useRef('')
    const key = address + ':' + nav?.revision

    /** @private @author ddj 2026年10月08号 Restore the official plan viewer; never re-claim our own fallback. */
    function openNative(): void {
      if (typeof official.service.openResource !== 'function') return
      try {
        official.service.openResource(address, nativeOptions(tab))
        tab?.actions?.close?.()
      } catch (error) { log.warn('计划官方查看器回退失败：' + String(error)) }
    }
    React.useEffect(() => {
      if (!plan || done.current === key || props.sessionId !== readSessionScope(ctx).sessionId) return
      const transferKey = props.sessionId + ':' + key
      if (transfers.has(transferKey)) return
      const controller = new AbortController()
      transfers.set(transferKey, { controller, sessionId: props.sessionId! })
      done.current = key
      setFailed(false)
      let mounted = true
      /** @private @author ddj 2026年10月08号 @param ok Preview readiness. Preserve the resource tab on failure; a successful cold mount may already have hidden this component. */
      function finish(ok: boolean): void {
        transfers.delete(transferKey)
        if (controller.signal.aborted) return
        if (ok) tab?.actions?.close?.()
        else if (mounted) setFailed(true)
      }
      /** @private @author ddj 2026年10月08号 @param error Unexpected routing failure. Keep the official fallback visible. */
      function reject(error: unknown): void { log.warn('计划预览转发失败：' + String(error)); finish(false) }
      void requestOpen(null, undefined, undefined, props.sessionId, { plan, preview: true, signal: controller.signal }).then(finish, reject)
      return () => { mounted = false }
    }, [key, plan?.markdown, props.sessionId])
    const unavailable = failed || (!plan && ['none', 'failed'].includes(resource.status))
    return React.createElement('div', { className: 'edrv-empty' },
      React.createElement('div', null, unavailable ? '计划暂未能在文件编辑器打开' : '正在打开计划预览…'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', onClick: openNative }, '在官方计划查看器打开'))
  }
  return { body: PlanRouter, dispose: () => { offScope(); cancel(true) } }
}
/** @private @author ddj 2026年10月08号 @param ctx Context. @param official Optional sidebar. @returns Atomic claim disposer; failures retain official ownership. */
function registerPlan(ctx: PlanContext, official: OfficialSidebar): () => void {
  const offType = official.tabs.register({
    id: CLAIM_ID, kind: CLAIM_KIND, priority: 'extension',
    patterns: ['dsh-resource://plan/**', 'dsh-resource://plan-review/**'],
    canOpen: isPlanAddress, title: () => '计划预览',
  })
  const router = planRouter(ctx, official)
  try {
    const offBody = ctx.slots.inject(OFFICIAL_SLOT_NAME, () => ctx.slots.register({ name: OFFICIAL_SLOT_NAME, key: CLAIM_ID }, router.body))
    return () => { router.dispose(); if (typeof offBody === 'function') offBody(); offType() }
  } catch (error) { router.dispose(); offType(); throw error }
}
/** @private @author ddj 2026年10月08号 @param ctx Context. @returns Current-session feed subscription, cancelling pending opens on scope change. */
function watchPlans(ctx: PlanContext): () => void {
  let source: EventSource | undefined
  let owner = ''
  let workspace = ''
  let offFeed: (() => void) | undefined
  let controller = new AbortController()

  /** @private @author ddj 2026年10月08号 @param id Owning session. @returns Valid borrowed feed, or undefined on older/incompatible services. */
  function sourceOf(id: string): EventSource | undefined {
    try {
      const sessions = optional(ctx, 'sessions') as Sessions | undefined
      if (!id || typeof sessions?.binding !== 'function') return undefined
      const feed = sessions.binding(id)?.eventSource
      return typeof feed?.getSnapshot === 'function' && typeof feed.subscribe === 'function' ? feed : undefined
    } catch { return undefined }
  }
  /** @private @author ddj 2026年10月08号 @param open Live plan target. Opens only in the still-current owning session. */
  function openPlan(open: PlanOpen): void {
    if (readSessionScope(ctx).sessionId !== owner || controller.signal.aborted) return
    void requestOpen(open.path ?? null, undefined, undefined, owner, { preview: true, plan: open.plan, signal: controller.signal })
      .catch(report)
  }
  /** @private @author ddj 2026年10月08号 @param error Open failure. Report without disrupting the Session event publisher. */
  function report(error: unknown): void { log.warn('计划自动预览失败：' + String(error)) }
  /** @private @author ddj 2026年10月08号 Borrow the retained binding, baseline history, and follow append deltas only. */
  function attach(): void {
    const scope = readSessionScope(ctx)
    const id = scope.sessionId ?? ''
    const cwd = scope.cwd ?? ''
    const next = sourceOf(id)
    if (next === source && id === owner && cwd === workspace) return
    offFeed?.()
    controller.abort()
    controller = new AbortController()
    source = next; owner = id; workspace = cwd
    if (!next || !id) return
    const feed = createPlanFeed(id, cwd)
    try { feed.consume(next.getSnapshot()) } catch (error) { source = undefined; report(error); return }
    /** @private @author ddj 2026年10月08号 Process a single synchronous window delta; no history scans. */
    function consume(): void {
      try { for (const open of feed.consume(next!.getSnapshot())) openPlan(open) } catch (error) { report(error) }
    }
    try { offFeed = next.subscribe(consume) } catch (error) { source = undefined; report(error) }
  }
  const offScope = subscribeScope(ctx, attach)
  attach()
  return () => { offScope(); offFeed?.(); controller.abort() }
}
/** @public @author ddj 2026年10月08号
 * Install optional plan routing and live generation detection with bounded service-arrival retries.
 * @param ctx Client context. @param schedule Lifecycle-owned timer scheduler. @returns Full cleanup for HMR/unload.
 */
export function installPlanBridge(ctx: PlanContext, schedule: (fn: () => void, delay: number) => unknown): () => void {
  let disposed = false
  let left = 15
  let offClaim: (() => void) | undefined
  const offWatch = watchPlans(ctx)
  /** @private @author ddj 2026年10月08号 Probe optional sidebar once, then bounded retries; never hold activation pending. */
  function probe(): void {
    if (disposed || offClaim) return
    const official = detectOfficial(ctx)
    if (official) {
      try { offClaim = registerPlan(ctx, official); return } catch (error) { log.warn('计划接入降级：' + String(error)) }
    }
    left -= 1
    if (left > 0) schedule(probe, 2000)
  }
  probe()
  return () => { disposed = true; offWatch(); offClaim?.(); clearPlanState() }
}
