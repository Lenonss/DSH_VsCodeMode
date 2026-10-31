/** Session-scoped official review RPC. @author ddj 2026年10月26号 */
import type { RpcHandlerMap } from './shared/rpc.js'
import type { ReviewDetail, ReviewItem, ReviewPage } from './shared/review.js'
import type { PendingPage } from './shared/pendingReview.js'
import { addedFiles, decideReview, reviewDetail, reviewPage } from './reviewDb.js'
import { undoReview } from './reviewUndo.js'
import { applyDecide, loadDetail, loadPage } from './pending/store.js'
import { PENDING_PREFIX, mergedPage, pendingDetailOf, pendingItemOf, pendingSamePath } from './pendingCompat.js'
import { bucketOf, resolveScope, sessionOf } from './registry.js'
import type { Registry } from './registry.js'
import { resolveTargetIn } from './store.js'
import type { Ctx } from './store.js'
import { log } from './log.js'

/** 批量写入快照的硬上限：待审积压超过它说明状态异常，宁可拒绝也不做无界写循环。 */
const BATCH_LIMIT = 2000

/** 冷端 Undo 说明：Undo 会校验证据并写回源文件，只能在持有该会话的那一端执行。 */
const UNDO_NEEDS_LIVE = 'Undo 需要在本端活跃的会话上执行：该会话当前在另一端（Web / 桌面）激活。'
  + 'Keep 不受影响，可在任一端执行；或在本端打开该会话后重试。'

/** 冷端待审判定说明：待审库是按工作区的本地存储，判定需要与正在编辑的那一端保持一致。 */
const PENDING_NEEDS_LIVE = '待审条目的判定需要在本端活跃的会话上执行：该会话当前在另一端激活，'
  + '请在那一端处理，或在本端打开该会话后重试。'

/**
 * @private
 * @author ddj 2026年10月31号
 * @description: 批量写入用的一次性完整快照。合并口径与列表一致（待审投影优先、同路径官方旧行让位），
 * 但一次取全，且 items 与 pending 同源，客户端才能把它当成写前不变式。
 * @param cwd 工作区
 * @param pending 该会话可见的待审页
 * @returns 完整快照；待审积压超过上限或分页期间数量漂移时返回错误
 */
function batchSnapshot(cwd: string, pending: PendingPage): { ok: true; page: ReviewPage } | { ok: false; error: string } {
  const first = reviewPage(cwd)
  if (first.pending > BATCH_LIMIT) return { ok: false, error: `待审记录过多（${first.pending} 条，上限 ${BATCH_LIMIT}），请先分批处理后重试` }

  const official: ReviewItem[] = []
  let page: ReviewPage | undefined = first
  while (page) {
    for (const item of page.items) if (item.current && item.decision === 'pending') official.push(item)
    page = page.nextCursor === null ? undefined : reviewPage(cwd, page.nextCursor)
  }
  // 分页期间有记录被判定掉：数量对不上就不给客户端一份半截快照
  if (official.length !== first.pending) return { ok: false, error: '待审记录数量不完整，未执行批量操作' }

  // 待审投影已接管的路径，官方旧行必须让位，否则同一文件会被批量写两次
  const live = pending.items.filter((item) => !item.settled)
  const kept = official.filter((row) => !live.some((entry) => pendingSamePath(entry.path, row.currentPath) || pendingSamePath(entry.path, row.path)))
  const items = [...live.map((entry) => pendingItemOf(entry, cwd)), ...kept]
  return {
    ok: true,
    page: { items, pending: items.length, nextCursor: null, gaps: first.gaps, ...(first.overview ? { overview: first.overview } : {}) },
  }
}

/**
 * @private
 * @author ddj 2026年10月31号
 * @description: 文件已在磁盘删除时修正官方记录的能力说明。Keep 只写审查库、仍可结案，
 * Undo 需要读写源文件、必然不可用：把「缺少原始字节」这种误导性原因换成可执行说明。
 * 只改文案与 undo 位，不参与判定写入。
 * @param ctx Host 能力
 * @param cwd 工作区
 * @param detail 官方记录详情
 * @param capability 已按冷/热端调整过的能力
 * @returns 修正后的能力；无法确认删除时原样返回
 */
async function absenceCapability(ctx: Ctx, cwd: string, detail: ReviewDetail, capability: ReviewDetail['capability']): Promise<ReviewDetail['capability']> {
  if (!capability.keep) return capability
  // 记录本身就是删除（after=false）：Undo 要整文件内容，官方差异只有片段
  if (detail.diff.kind === 'text' && !detail.diff.after) {
    return { ...capability, undo: false, reason: '该记录删除了这个文件：Keep 按删除结案；Undo 需要完整文件内容，官方差异只有片段，不可用。' }
  }

  // 文件已被删除时，Undo 的失败原因是「文件不在」，不是「缺少原始字节」：先查磁盘再谈证据
  const fs = ctx.get('fs')
  if (!fs) return capability
  try {
    const target = await resolveTargetIn(ctx, cwd, detail.item.currentPath)
    if (await fs.stat(target)) return capability
  } catch { return capability }
  return { ...capability, undo: false, reason: '文件已在磁盘删除：Keep 按删除结案；Undo 需要读写该文件，当前不可用。' }
}

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
  /**
   * @private
   * @author ddj 2026年10月31号
   * @description: 解析会话作用域，并标明本端是否持有该会话的活跃实例。
   * 工作区一律由 host 解析，绝不采信调用方 cwd；冷读作用域只带 cwd，不带会话实例。
   * @param sessionId 请求作用域
   * @returns 已迁移工作区与活跃标记
   * @throws 会话不存在、会话无工作区或活跃库迁移未完成
   */
  async function scopeOf(sessionId: string): Promise<{ cwd: string; live: boolean }> {
    const scope = await resolveScope(ctx, sessionId)
    if ('err' in scope) throw new Error('会话不存在或没有工作区')

    await bucketOf(registry, ctx, scope.cwd)
    return { cwd: scope.cwd, live: !!scope.session }
  }

  /**
   * @private
   * @author ddj 2026年10月31号
   * @description: 本端是否持有该会话的活跃实例（纯诊断用，不解析工作区）。
   * @param sessionId 请求作用域
   * @returns 本端加载了该会话时为 true
   */
  function liveOf(sessionId: string): boolean {
    return !!sessionOf(ctx, sessionId)
  }

  /**
   * @private
   * @author ddj 2026年10月31号
   * @description: 按本端是否活跃覆写面板能力位。活跃端保持数据库结论；
   * 冷端关闭依赖会话的操作（Undo、待审判定）并给出跨端原因，Keep 仍按数据库结论放行。
   * @param capability 数据库推导的能力位
   * @param live 本端是否持有活跃会话
   * @param pending 是否为待审投影条目
   * @returns 面板可用的能力位
   */
  function liveCapabilityOf(
    capability: { keep: boolean; undo: boolean; reason: string },
    live: boolean,
    pending: boolean,
  ): { keep: boolean; undo: boolean; reason: string; live: boolean } {
    if (live) return { ...capability, live: true }
    if (pending) return { keep: false, undo: false, reason: PENDING_NEEDS_LIVE, live: false }
    return { ...capability, undo: false, live: false, reason: capability.undo ? UNDO_NEEDS_LIVE : capability.reason }
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
    try {
      // 本会话新建的文件由官方首个块判为整文件新增，待审基线必须跟着置空：
      // 否则同一次新建会同时存在「官方说全加 516 行」与「待审说改 8 处」两套相反口径。
      const page = loadPage(cwd, sessionId, addedFiles(cwd, sessionId))
      // 已结算（老文本与新文本一致）的投影没有净变化可审：留着会顶掉同路径的官方待审记录，
      // 让差异栏选中一条 Keep 不可用的条目，表现为「按钮亮着却点不动」。
      return page.items.some((item) => item.settled === true)
        ? { ...page, items: page.items.filter((item) => item.settled !== true) }
        : page
    } catch { return { items: [], pending: 0, nextCursor: null, gaps: [] } }
  }

  return {
    'edrv.review.list': async (args) => {
      const { cwd } = await scopeOf(args.sessionId)
      // 批量通道要的是一次性完整快照：分页口径的 pending 只是页内展示计数，不能当完整性不变式
      if (args.all && !args.history && args.path === undefined) {
        return batchSnapshot(cwd, pendingPageOf(cwd, args.sessionId))
      }
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
      const merged = mergedPage(official, pending, cwd)
      log.debug(`[review] list live=${liveOf(args.sessionId) ? 1 : 0} path=${args.path ?? '(all)'}`
        + ` items=${merged.items.length} pending=${merged.pending} covered=${merged.overview?.coveredPaths.length ?? -1}`)
      return { ok: true, page: merged }
    },
    'edrv.review.detail': async (args) => {
      const scope = await scopeOf(args.sessionId)
      const cwd = scope.cwd
      if (args.id.startsWith(PENDING_PREFIX)) {
        const entryId = args.id.slice(PENDING_PREFIX.length)
        // 详情侧与列表侧必须同一口径：整文件新增的文件用空基线渲染，差异块才是全绿一整块
        const detail = loadDetail(cwd, entryId, addedFiles(cwd, args.sessionId).has(entryId))
        if (!detail) return { ok: false, error: '待审条目不存在' }

        const mapped = pendingDetailOf(detail, new Date(detail.item.updatedAt).toISOString(), cwd)
        // 待审判定走本地待审库，跨端会与另一端 agent 的写入抢同一份 JSON，故冷端一律关闭
        return { ok: true, detail: { ...mapped, capability: liveCapabilityOf(mapped.capability, scope.live, true) } }
      }

      const detail = reviewDetail(cwd, args.id)
      if (!detail) {
        log.debug(`[review] detail live=${scope.live ? 1 : 0} id=${args.id} found=0`)
        return { ok: false, error: '官方审查记录不存在' }
      }
      // Keep 只写共享库，冷端放行；Undo 依赖会话证据与源文件写回，冷端关闭
      const capability = await absenceCapability(ctx, cwd, detail, liveCapabilityOf(detail.capability, scope.live, false))
      log.debug(`[review] detail live=${scope.live ? 1 : 0} id=${args.id} found=1`
        + ` keep=${capability.keep ? 1 : 0} undo=${capability.undo ? 1 : 0}`)
      return { ok: true, detail: { ...detail, capability } }
    },
    'edrv.review.decide': async (args) => {
      // Keep 只写共享审查库（CAS + operationId 幂等 + WAL），冷端也放行；
      // Undo 与待审判定依赖本端会话内容或本地待审库，冷端返回可读原因而不是 500。
      try {
        const scope = await scopeOf(args.sessionId)
        if (args.id.startsWith(PENDING_PREFIX)) {
          if (!scope.live) return { ok: false, error: PENDING_NEEDS_LIVE }
          // 待审条目走累计基线：Keep 零写盘，Revert 写回并读回校验
          const result = await applyDecide(ctx.get('fs'), scope.cwd, {
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

        if (args.decision === 'rejected') {
          if (!scope.live) return { ok: false, error: UNDO_NEEDS_LIVE }
          const result = await undoReview(ctx, sessionOf(ctx, args.sessionId), scope.cwd, args)
          return { ok: true, ...result }
        }

        const result = decideReview(scope.cwd, args)
        if (!scope.live) log.info(`[review] 冷端 Keep 官方记录 ${args.id}`)
        return { ok: true, ...result }
      } catch (error) {
        // Guard failures are review results, not transport failures: preserve their reason.
        const message = error instanceof Error ? error.message : String(error)
        log.warn(`[review] decide 失败 id=${args.id} decision=${args.decision}: ${message}`)
        return { ok: false, error: message }
      }
    },
  }
}
