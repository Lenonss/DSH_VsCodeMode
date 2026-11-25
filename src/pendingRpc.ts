/** 待审投影 RPC：Keep/Revert 走累计基线，旧官方审查入口不再承接写操作。 @author ddj 2026年10月29号 */
import type { RpcHandlerMap } from './shared/rpc.js'
import type { PendingRequest } from './shared/pendingReview.js'
import { resolveScope, sessionOf } from './registry.js'
import type { Registry } from './registry.js'
import { bucketOf } from './registry.js'
import { pendingRawId, setPendingCovers, trackPendingCover } from './pendingCompat.js'
import { loadEntries, pendingVersion } from './pending/persist.js'
import { applyDecide, loadDetail, loadPage, purgePending, removeEntry, undoDecide } from './pending/store.js'
import { captureSync } from './pending/externalCapture.js'
import type { Ctx } from './store.js'
import { policyOf } from './store.js'

/** 处理器共享的作用域能力：读允许跨实例冷读，写必须本端 live 会话。 */
interface ScopeKit {
  ctx: Ctx
  read(sessionId: string): Promise<string>
  write(sessionId: string): Promise<string>
}

/**
 * @author ddj 2026年10月30号
 * @description: 解析会话工作区并预热记录桶；读路径也走它，避免冷读时桶未就绪。
 * @param ctx Host 上下文
 * @param registry 工作区记录桶缓存
 * @param sessionId 请求作用域
 * @returns 工作区路径
 */
async function workspaceOf(ctx: Ctx, registry: Registry, sessionId: string): Promise<string> {
  const scope = await resolveScope(ctx, sessionId)
  if ('err' in scope) throw new Error('会话不存在或没有工作区')
  await bucketOf(registry, ctx, scope.cwd)
  return scope.cwd
}

/**
 * @author ddj 2026年10月30号
 * @description: 写路径专用的工作区解析：本端没有该会话就直接拒绝，不做跨实例写。
 * @param ctx Host 上下文
 * @param registry 工作区记录桶缓存
 * @param sessionId 请求作用域
 * @returns 工作区路径
 */
async function writeWorkspaceOf(ctx: Ctx, registry: Registry, sessionId: string): Promise<string> {
  const cwd = await workspaceOf(ctx, registry, sessionId)
  if (!sessionOf(ctx, sessionId)) throw new Error('写入要求本端活跃会话')
  return cwd
}

/**
 * @author ddj 2026年10月30号
 * @description: 把异常归一成可播报文案，避免处理器各自重复三元表达式。
 * @param error 捕获到的异常
 * @returns 错误文案
 */
function failureOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @author ddj 2026年10月30号
 * @description: 读路径处理器：列表与详情，允许跨实例冷读。
 * @param kit 作用域能力
 * @returns 处理器表
 */
function readHandlers(kit: ScopeKit): Partial<RpcHandlerMap> {
  return {
    'edrv.pending.list': async (args: PendingRequest) => {
      const cwd = await kit.read(args.sessionId)
      // 与统一审查入口共用来源基线，不按查看者对话切分。
      const page = loadPage(cwd, args.sessionId)
      // 完整工作区列表重建唯一接管集合，清除所有来源的过期登记。
      setPendingCovers(cwd, args.sessionId, page.items.map((item) => item.path))
      return { ok: true, page }
    },
    'edrv.pending.detail': async (args: PendingRequest & { id: string }) => {
      const cwd = await kit.read(args.sessionId)
      const rawId = pendingRawId(args.id)
      const detail = loadDetail(cwd, rawId)
      return detail ? { ok: true, detail } : { ok: false, error: '待审条目不存在' }
    },
    'edrv.pending.version': async (args: PendingRequest) => {
      // 只读内存计数：供客户端用 1s 轻量轮询替代把整页列表拉到 5s 一次
      const cwd = await kit.read(args.sessionId)
      return { ok: true, version: pendingVersion(cwd) }
    },
  }
}

/**
 * @author ddj 2026年10月30号
 * @description: 判定处理器：Keep/Revert 与已解决条目移除，都会改变待审状态。
 * @param kit 作用域能力
 * @returns 处理器表
 */
function decideHandlers(kit: ScopeKit): Partial<RpcHandlerMap> {
  return {
    'edrv.pending.decide': async (args) => {
      const cwd = await kit.write(args.sessionId)
      const id = pendingRawId(args.id)
      try {
        const policy = policyOf(kit.ctx, sessionOf(kit.ctx, args.sessionId))
        const result = await applyDecide(kit.ctx.get('fs'), cwd, { ...args, id }, undefined, policy)
        if (!result.ok) return { ok: false, error: result.reason }
        const detail = loadDetail(cwd, id)
        return detail ? { ok: true, item: detail.item, wrote: result.wrote } : { ok: false, error: '待审条目不存在' }
      } catch (error) {
        return { ok: false, error: failureOf(error) }
      }
    },
    'edrv.pending.remove': async (args) => {
      const cwd = await kit.write(args.sessionId)
      const id = pendingRawId(args.id)
      const path = loadEntries(cwd).find((stored) => stored.entry.id === id)?.entry.path
      const removed = removeEntry(cwd, id, args.revision)
      // 移除后注销工作区唯一登记，其他对话不留过期副本。
      if (removed && path) trackPendingCover(cwd, path, false, args.sessionId)
      return { ok: true, removed }
    },
  }
}

/**
 * @author ddj 2026年10月30号
 * @description: 历史处理器：撤销/重做一次决定。
 * @param kit 作用域能力
 * @returns 处理器表
 */
function historyHandlers(kit: ScopeKit): Partial<RpcHandlerMap> {
  return {
    'edrv.pending.history': async (args) => {
      const cwd = await kit.write(args.sessionId)
      const policy = policyOf(kit.ctx, sessionOf(kit.ctx, args.sessionId))
      try {
        const result = await undoDecide(kit.ctx.get('fs'), cwd, args, undefined, policy)
        return result.ok ? { ok: true, item: result.item, wrote: result.wrote } : { ok: false, error: result.reason }
      } catch (error) {
        return { ok: false, error: failureOf(error) }
      }
    },
  }
}

/**
 * @author ddj 2026年10月30号 / 2026年11月25号
 * @description: 投影维护处理器：校准追踪窗口、清理旧通道条目。
 * @param kit 作用域能力
 * @returns 处理器表
 */
function refreshHandlers(kit: ScopeKit): Partial<RpcHandlerMap> {
  return {
    'edrv.pending.align': async (args) => {
      // 手动校准：把开窗文件与磁盘对齐一次，补上漏掉的 watch 事件；不受 scan 开关限制
      const cwd = await kit.write(args.sessionId)
      const outcome = await captureSync(cwd)
      const page = loadPage(cwd, args.sessionId)
      setPendingCovers(cwd, args.sessionId, page.items.map((item) => item.path))
      return { ok: true, checked: outcome.checked, folded: outcome.folded, gaps: outcome.gaps }
    },
    /**
     * @author ddj 2026-11-24
     * @description: 清掉指定通道的幽灵记录。dryRun 只报数；真删后按需 VACUUM，
     * 并重建「待审接管」集合，避免旧路径继续顶掉官方行。
     * @param args 清理请求
     * @returns 命中、删除、保留条数与 VACUUM 耗时
     */
    'edrv.pending.purge': async (args) => {
      const cwd = await kit.write(args.sessionId)
      const outcome = purgePending(cwd, {
        sources: args.sources,
        baseKinds: args.baseKinds,
        before: args.before,
      }, { dryRun: args.dryRun === true, vacuum: true })
      const page = loadPage(cwd, args.sessionId)
      setPendingCovers(cwd, args.sessionId, page.items.map((item) => item.path))
      return { ok: true, matched: outcome.matched, removed: outcome.removed, kept: outcome.kept, vacuumMs: outcome.vacuumMs }
    },
  }
}

/**
 * @author ddj 2026年10月29号
 * @description: 待审投影处理器表：按用途拆成读/判定/历史/维护四组，便于分别收敛权限。
 * @param ctx Host 上下文
 * @param registry 工作区记录桶缓存
 * @returns 待审相关处理器表
 */
export function pendingHandlers(ctx: Ctx, registry: Registry): Partial<RpcHandlerMap> {
  const kit: ScopeKit = {
    ctx,
    read: (sessionId) => workspaceOf(ctx, registry, sessionId),
    write: (sessionId) => writeWorkspaceOf(ctx, registry, sessionId),
  }
  return {
    ...readHandlers(kit),
    ...decideHandlers(kit),
    ...historyHandlers(kit),
    ...refreshHandlers(kit),
  }
}
