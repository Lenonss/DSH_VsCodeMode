/** 待审投影 RPC：Keep/Revert 走累计基线，旧官方审查入口不再承接写操作。 @author ddj 2026年10月29号 */
import type { RpcHandlerMap } from './shared/rpc.js'
import type { PendingRequest } from './shared/pendingReview.js'
import { resolveScope, sessionOf } from './registry.js'
import type { Registry } from './registry.js'
import { bucketOf } from './registry.js'
import { readText } from './pending/capture.js'
import { pendingRawId, trackPendingCover } from './pendingCompat.js'
import { loadEntries, saveEntry } from './pending/persist.js'
import { applyDecide, importFromVcs, itemOf, loadDetail, loadPage, refreshed, removeEntry, undoDecide } from './pending/store.js'
import { addedFiles } from './reviewDb.js'
import type { ShellLike } from './pending/vcs.js'
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
 * @description: 按会话策略包装 shell：执行器默认按 workspace-write 跑，本机无可用沙箱后端会直接拒绝。
 * @param raw 原始 shell 能力
 * @param policy 会话沙箱策略
 * @returns 带策略的 shell 视图
 */
function shellOf(raw: ShellLike, policy: unknown): ShellLike {
  return {
    resolve: (request) => raw.resolve(policy ? { ...request, sandboxPolicy: policy } : request),
    execute: (spec) => raw.execute(spec),
  }
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
      // 与官方入口同口径：本会话新建的文件基线置空，列表里的增删行数才等于整文件行数
      const page = loadPage(cwd, args.sessionId, addedFiles(cwd, args.sessionId))
      // 列表即登记接管关系；旧写入口守卫之后只读内存集合，不再产生数据库读
      for (const item of page.items) trackPendingCover(cwd, item.path, true)
      return { ok: true, page }
    },
    'edrv.pending.detail': async (args: PendingRequest & { id: string }) => {
      const cwd = await kit.read(args.sessionId)
      const rawId = pendingRawId(args.id)
      const detail = loadDetail(cwd, rawId, addedFiles(cwd, args.sessionId).has(rawId))
      return detail ? { ok: true, detail } : { ok: false, error: '待审条目不存在' }
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
      // 移除后该路径不再由待审投影接管，旧入口守卫随之放行
      if (removed && path) trackPendingCover(cwd, path, false)
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
 * @author ddj 2026年10月30号
 * @description: 投影维护处理器：从版本库导入、按磁盘现状刷新单条。
 * @param kit 作用域能力
 * @returns 处理器表
 */
function refreshHandlers(kit: ScopeKit): Partial<RpcHandlerMap> {
  return {
    'edrv.pending.import': async (args) => {
      const cwd = await kit.write(args.sessionId)
      const raw = kit.ctx.get('shell') as unknown as ShellLike | undefined
      if (!raw) return { ok: false, error: '当前环境没有 shell 能力，无法读取版本库基线' }
      const policy = policyOf(kit.ctx, sessionOf(kit.ctx, args.sessionId))
      try {
        const shell = shellOf(raw, policy)
        const result = await importFromVcs(shell, cwd, args.sessionId, { includeUntracked: args.includeUntracked, path: args.path })
        for (const item of loadPage(cwd, args.sessionId).items) trackPendingCover(cwd, item.path, true)
        return { ok: true, imported: result.imported, changes: result.changes }
      } catch (error) {
        return { ok: false, error: failureOf(error) }
      }
    },
    'edrv.pending.refresh': async (args: PendingRequest & { id: string }) => {
      const cwd = await kit.write(args.sessionId)
      const id = pendingRawId(args.id)
      const stored = loadEntries(cwd).find((entry) => entry.entry.id === id)
      if (!stored) return { ok: false, error: '待审条目不存在' }
      const fs = kit.ctx.get('fs')
      const session = sessionOf(kit.ctx, args.sessionId)
      const target = await fs.resolve(id, { cwd, agent: session })
      const content = await readText(fs, target).catch(() => undefined)
      if (content === undefined) return { ok: false, error: '读取失败' }
      const next = refreshed(stored, content, Date.now())
      if (next) saveEntry(cwd, next)
      return { ok: true, item: itemOf(next ?? stored) }
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
