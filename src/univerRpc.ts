/** Session-authorized optional Univer handlers. @author ddj 2026年11月12号 */
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { cleanCache, listCache, openCache } from './univerCache.js'
import { univerCacheRoot } from './paths.js'
import type { Ctx } from './store.js'
import { cwdOfSession, policyOf } from './store.js'
import { sessionOf } from './registry.js'
import { importCopy, importPaths, insideRoot, univerService } from './univerBridge.js'
import type { UniverService } from './univerBridge.js'
import type { RpcHandlerMap } from './shared/rpc.js'
import type { UniverCapability, UniverImport, UniverImportResult } from './shared/univer.js'

interface SessionAccess {
  workspace: string
  writable: boolean
  policyRoot?: string
  service: UniverService | null
}
interface ImportEntry {
  request: string
  promise: Promise<UniverImportResult>
}
const imports = new Map<string, ImportEntry>()
const targets = new Map<string, Promise<UniverImportResult>>()
const cachedOps = new Map<string, { request: string; result: ReturnType<typeof openCache> }>()

/** @private @author ddj 2026年11月13号 @param access Authorized scope. @param args Explicit cache request. @returns Idempotent generation creation, including source refresh. */
async function cachedOnce(access: SessionAccess, args: { sessionId: string; source: string; operationId: string; refresh?: boolean }) {
  if (!access.service || !args.operationId || args.operationId.length > 100) throw new Error('缺少有效缓存操作标识或服务')
  const key = JSON.stringify([args.sessionId, args.operationId])
  const request = JSON.stringify([access.workspace, args.source, args.refresh === true])
  const previous = cachedOps.get(key)
  if (previous) {
    if (previous.request !== request) throw new Error('缓存操作标识已用于其他请求')
    return previous.result
  }
  if (cachedOps.size >= 512) throw new Error('缓存操作记录已达上限，请重新打开会话后检查已有缓存')
  const result = openCache(access.workspace, args.source, access.service, args.refresh)
  cachedOps.set(key, { request, result })
  return result
}

/** @private @author ddj 2026年11月12号 @param ctx Host context. @param sessionId Live session. @returns Verified session and optional service. @throws Missing session/workspace. */
function accessOf(ctx: Ctx, sessionId: string): SessionAccess {
  const session = sessionOf(ctx, sessionId)
  if (!session) throw new Error('会话不存在，联动要求本端活跃会话')
  const workspace = cwdOfSession(ctx, session)
  if (!workspace) throw new Error('当前会话没有工作区')
  const policy = policyOf(ctx, session)
  const writable = policy?.mode === 'workspace-write' || policy?.mode === 'danger-full-access'
  // Viewer state is authorized against header.cwd in upstream 0.4.0.
  if (session.header?.cwd !== workspace) throw new Error('当前目录已变化，Univer 0.4.0 仅支持会话初始工作区')
  return { workspace, writable, policyRoot: policy?.workspaceRoot, service: univerService(ctx.get('univer')) }
}

/** @private @author ddj 2026年11月12号 @param access Checked session. @returns Non-mutating capability state. */
async function capabilityOf(access: SessionAccess): Promise<UniverCapability> {
  if (!access.service) return { available: false, writable: false, reason: 'Univer Office 未启用或接口不兼容' }
  const gateway = await access.service.gatewayStatus()
  return { available: true, writable: access.writable, gateway: gateway.phase, reason: access.writable ? undefined : '当前会话为只读或策略不可用，未加载 Viewer' }
}

/** @private @author ddj 2026年11月12号 @param access Session access. @param args Import request. @returns Identifiable import result. @throws Permission and path refusal before mutation. */
async function runImport(access: SessionAccess, args: UniverImport): Promise<UniverImportResult> {
  if (!access.writable || !access.service) throw new Error('当前会话没有 Univer 写入能力')
  const paths = await importPaths(access.workspace, args.source, args.target)
  if (!access.policyRoot) throw new Error('无法确定会话写入边界')
  const policyRoot = await realpath(access.policyRoot)
  if (!insideRoot(policyRoot, paths.file) || !insideRoot(policyRoot, paths.source)) throw new Error('源或目标超出会话沙箱边界')
  return importCopy(access.service, paths)
}

/** @private @author ddj 2026年11月12号 @param access Freshly checked session. @param args Request with operation identity. @returns Same outcome for duplicate requests, including partial failure. */
async function onceImport(access: SessionAccess, args: UniverImport): Promise<UniverImportResult> {
  if (!args.operationId || args.operationId.length > 100) throw new Error('缺少有效操作标识')
  const key = JSON.stringify([args.sessionId, args.operationId])
  const request = JSON.stringify([access.workspace, args.source, args.target])
  const previous = imports.get(key)
  if (previous) {
    if (previous.request !== request) throw new Error('操作标识已用于其他导入')
    return previous.promise
  }
  // Cap process-local outcomes; never evict and accidentally replay a completed mutation.
  if (imports.size >= 512) throw new Error('本进程导入操作记录已达上限，请打开已有副本')
  const targetKey = JSON.stringify([access.workspace, args.target])
  if (targets.has(targetKey)) throw new Error('该目标正在导入，请等待已有操作结束')
  const promise = runImport(access, args)
  imports.set(key, { request, promise })
  targets.set(targetKey, promise)
  try { return await promise } finally { targets.delete(targetKey) }
}

/** @private @author ddj 2026年11月13号 @param access Live session policy. @throws Read-only or cache root outside sandbox. */
async function cacheWrite(access: SessionAccess): Promise<void> {
  if (!access.writable || !access.policyRoot) throw new Error('当前会话没有缓存写入/清理权限')
  const workspace = await realpath(access.workspace)
  const policyRoot = await realpath(access.policyRoot)
  if (!insideRoot(policyRoot, univerCacheRoot(workspace))) throw new Error('缓存目录超出沙箱写入边界')
}

/** @public @author ddj 2026年11月12号 @param ctx Host context. @returns Optional capability and controlled import handlers. */
export function univerHandlers(ctx: Ctx): Partial<RpcHandlerMap> {
  return {
    'edrv.univer.cacheList': async (args) => {
      try {
        const access = accessOf(ctx, args.sessionId)
        return { ok: true, cache: { ...await listCache(access.workspace), workspace: access.workspace, writable: access.writable } }
      } catch (error) { return { ok: false, error: String(error) } }
    },
    'edrv.univer.cacheClean': async (args) => {
      try {
        const access = accessOf(ctx, args.sessionId)
        await cacheWrite(access)
        const gateway = await access.service?.gatewayStatus()
        // No per-file release API: unknown or running Gateway state is not safe to unlink.
        const busy = !!access.service && gateway?.phase !== 'stopped'
        return { ok: true, results: await cleanCache(access.workspace, args.entries, busy) }
      } catch (error) { return { ok: false, error: String(error) } }
    },
    'edrv.univer.openCached': async (args) => {
      try {
        const access = accessOf(ctx, args.sessionId)
        await cacheWrite(access)
        if (!access.service) throw new Error('Univer Office 未启用')
        const source = await realpath(resolve(access.workspace, args.source))
        const policyRoot = await realpath(access.policyRoot!)
        if (!insideRoot(policyRoot, source)) throw new Error('源文件超出会话沙箱边界')
        return { ok: true, cached: await cachedOnce(access, args) }
      } catch (error) { return { ok: false, error: String(error) } }
    },
    'edrv.univer.capabilities': async (args) => {
      try { return { ok: true, capability: await capabilityOf(accessOf(ctx, args.sessionId)) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'edrv.univer.importCopy': async (args) => {
      try {
        const access = accessOf(ctx, args.sessionId)
        if (!access.writable || !access.service) return { ok: false, error: '当前没有 Univer 写入能力' }
        return { ok: true, imported: await onceImport(access, args) }
      } catch (error) { return { ok: false, error: String(error) } }
    },
  }
}
