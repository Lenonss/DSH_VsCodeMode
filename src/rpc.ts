/**
 * dsh-vscode-mode host — RPC 分发：类型化方法表替代巨型 switch。
 * 迁移自原 src/index.ts 的 handleRpc，方法名/载荷/错误文案一字不改。
 * 新功能 = shared/rpc.ts 加方法 + 这里加一个 handler，不改其他模块。
 * 作者 ddj 2026-08-20
 */
import type { RpcHandlerMap, RpcMethod, RpcRequestMap, RpcResult } from './shared/rpc.js'
import type { DiffRecord, RecordView } from './shared/types.js'
import type { Ctx, Session } from './store.js'
import {
  READ_CAP,
  appendArchiveEntries,
  archiveRecords,
  autoArchiveStale,
  parseArchive,
  policyOf,
  readArchiveText,
  resolveTarget,
  saveBucket,
} from './store.js'
import { archiveEntryFor, markDecision, recordResolved, reconstructOriginal } from './model.js'
import type { Registry } from './registry.js'
import { bucketOf, cwdOf, sessionOf } from './registry.js'
import type { SearchOrchestrator } from './search/orchestrator.js'
import { newSearcher } from './search/orchestrator.js'
import { restoreFile, revertCall, revertHunk } from './revert.js'
import { listMcp, refreshMcp, removeMcp, saveMcp, toggleMcp } from './mcp.js'
import { listProjects, projectRefresh, projectRemove, projectSave, projectToggle } from './mcpProject.js'
import { normalizeFileOpenTool, FILE_OPEN_DEFAULT, FILE_OPEN_SETTINGS_NS } from './fileOpenSettings.js'

/** cwd → Promise 链：串行化 debug 日志追加（fs read+write 非原子，避免并发丢行）。 */
const debugWriteQueues = new Map<string, Promise<void>>()

/** 记录 → 客户端视图（不含 before 全文，仅长度）。 */
function recView(record: DiffRecord): RecordView {
  return {
    callId: record.callId,
    toolName: record.toolName,
    path: record.path,
    beforeLen: typeof record.before === 'string' ? record.before.length : 0,
    create: record.create === true,
    callHunk: record.callHunk,
    hunks: record.hunks,
    decisions: record.decisions,
    note: record.note ?? null,
    superseded: record.superseded === true,
    after: record.after ?? null,
    baseFingerprint: record.baseFingerprint ?? null,
    afterFingerprint: record.afterFingerprint ?? null,
    conflict: record.conflict === true,
    legacy: record.legacy === true,
    at: record.at,
  }
}

/** 会话/工作区公共前置：返回 {session,cwd} 或错误文案。 */
async function requireSession(ctx: Ctx, sessionId: string | undefined): Promise<
  { session: Session; cwd: string } | { err: string }
> {
  const session = sessionOf(ctx, sessionId)
  if (!session) return { err: '会话不存在' }
  const cwd = cwdOf(session)
  if (!cwd) return { err: '会话无工作区' }
  return { session, cwd }
}

/** 各方法 handler 表（类型由 shared/rpc 的 RpcHandlerMap 约束）。 */
export function buildHandlers(ctx: Ctx, registry: Registry, searcher = newSearcher(ctx)): RpcHandlerMap {
  return {
    'edrv.list': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const bucket = await bucketOf(registry, ctx, sc.cwd)
      const want = Array.isArray(args.callIds) ? new Set(args.callIds) : null
      if (!want) await autoArchiveStale(ctx, sc.session, sc.cwd, bucket) // 全量轮询时自动清理 stale 幽灵差异
      const out: RecordView[] = []
      for (const rec of bucket.values()) {
        // 面板全量查询过滤已归档；聊天条按 callId 查询保留（状态徽章仍需正确显示）
        if (!want && rec.archived) continue
        if (want && !want.has(rec.callId)) continue
        out.push(recView(rec))
      }
      out.sort((a, b) => (a.at < b.at ? -1 : 1))
      return { ok: true, records: out }
    },
    'edrv.accept': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const bucket = await bucketOf(registry, ctx, sc.cwd)
      const record = bucket.get(args.callId)
      if (!record) return { ok: false, error: '记录不存在' }
      markDecision(record, args.scope ?? 'call', args.hunkIndex, 'accepted')
      if (recordResolved(record)) await archiveRecords(ctx, sc.session, sc.cwd, bucket, [record], '已处理')
      else await saveBucket(ctx, sc.cwd, bucket, sc.session)
      return { ok: true, record: recView(record) }
    },
    'edrv.reject': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const bucket = await bucketOf(registry, ctx, sc.cwd)
      const record = bucket.get(args.callId)
      if (!record) return { ok: false, error: '记录不存在' }
      const scope = args.scope ?? 'call'
      const outcome = scope === 'hunk' ? await revertHunk(ctx, sc.session, record, args.hunkIndex ?? -1) : await revertCall(ctx, sc.session, record)
      if (!outcome.ok) return { ok: false, error: outcome.error }
      markDecision(record, scope, args.hunkIndex, 'rejected')
      record.at = new Date().toISOString()
      if (recordResolved(record)) await archiveRecords(ctx, sc.session, sc.cwd, bucket, [record], '已处理（回滚）')
      else await saveBucket(ctx, sc.cwd, bucket, sc.session)
      return { ok: true, record: recView(record) }
    },
    'edrv.read': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const fs = ctx.get('fs')
      if (!fs) return { ok: false, error: '缺少 fs' }
      try {
        const target = await resolveTarget(ctx, sc.session, args.path)
        const info = await fs.stat(target)
        if (!info || info.type !== 'file') return { ok: false, error: '文件不存在' }
        if ((info.size ?? 0) > READ_CAP) return { ok: false, error: '文件过大（>8MB），不支持整文件预览' }
        const content = await fs.readText(target)
        return { ok: true, content, size: content.length }
      } catch (error) {
        return { ok: false, error: '读取失败：' + String(error) }
      }
    },
    'edrv.original': async (args) => {
      // 重建"本批次修改前"内容：DiffEditor 原始侧。仅反解 pending 块；
      // 全部反解失败时回退到最早记录的整体 before（若存在）。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const fs = ctx.get('fs')
      if (!fs) return { ok: false, error: '缺少 fs' }
      try {
        const target = await resolveTarget(ctx, sc.session, args.path)
        const info = await fs.stat(target)
        if (!info || info.type !== 'file') return { ok: false, error: '文件不存在' }
        if ((info.size ?? 0) > READ_CAP) return { ok: false, error: '文件过大（>8MB），不支持差异重建' }
        const content = await fs.readText(target)
        const bucket = await bucketOf(registry, ctx, sc.cwd)
        const records = [...bucket.values()].filter((r) => r.path === args.path && !r.archived).sort((a, b) => (a.at < b.at ? -1 : 1))
        if (!records.length) return { ok: true, content, size: content.length, stale: [], fallback: false }
        const rebuilt = reconstructOriginal(records, content)
        if (rebuilt.stale.length && records[0].before !== null) {
          return { ok: true, content: records[0].before, size: records[0].before.length, stale: rebuilt.stale, fallback: true }
        }
        return { ok: true, content: rebuilt.content, size: rebuilt.content.length, stale: rebuilt.stale, fallback: false }
      } catch (error) {
        return { ok: false, error: '重建失败：' + String(error) }
      }
    },
    'edrv.save': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const fs = ctx.get('fs')
      if (!fs) return { ok: false, error: '缺少 fs' }
      try {
        const target = await resolveTarget(ctx, sc.session, args.path)
        await fs.writeText(target, args.content, void 0, void 0, policyOf(ctx, sc.session))
        const bucket = await bucketOf(registry, ctx, sc.cwd)
        let changed = false
        for (const rec of bucket.values()) {
          if (rec.path === args.path && rec.superseded !== true) { rec.superseded = true; rec.at = new Date().toISOString(); changed = true }
        }
        if (changed) {
          const done: DiffRecord[] = []
          for (const rec of bucket.values()) if (rec.path === args.path && rec.superseded) done.push(rec)
          if (done.length) await archiveRecords(ctx, sc.session, sc.cwd, bucket, done, '被手动编辑覆盖')
          else await saveBucket(ctx, sc.cwd, bucket, sc.session)
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, error: '保存失败：' + String(error) }
      }
    },
    'edrv.archiveList': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const batches = parseArchive(await readArchiveText(ctx, sc.cwd)).filter((b) => b.cwd === sc.cwd)
      const entries = batches.map((b) => {
        const recs = Array.isArray(b.records) ? b.records : []
        const sum = recs.reduce((s, r) => {
          const sm = r.summary || { accepted: 0, rejected: 0, pending: 0, superseded: false }
          s.accepted += sm.accepted || 0
          s.rejected += sm.rejected || 0
          s.pending += sm.pending || 0
          if (sm.superseded) s.superseded++
          return s
        }, { accepted: 0, rejected: 0, pending: 0, superseded: 0 })
        return { at: b.at, lastAt: b.lastAt || b.at, path: b.path, batch: b.batch ?? null, reason: b.reason ?? null, nRecords: recs.length, summary: sum }
      })
      entries.sort((a, b) => (Number(b.batch ?? -1) - Number(a.batch ?? -1)) || (a.at < b.at ? 1 : -1))
      return { ok: true, entries }
    },
    'edrv.archiveRead': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const batchPath = args.path
      const batches = parseArchive(await readArchiveText(ctx, sc.cwd)).filter((b) => b.cwd === sc.cwd && (!batchPath || b.path === batchPath))
      return { ok: true, batches }
    },
    'edrv.rollback': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const fs = ctx.get('fs')
      if (!fs) return { ok: false, error: '缺少 fs' }
      const batch = args.batch
      const bucket = await bucketOf(registry, ctx, sc.cwd)
      let affected: DiffRecord[] = []
      let beforeRec: DiffRecord | null = null
      if (batch !== undefined) {
        const all = parseArchive(await readArchiveText(ctx, sc.cwd)).filter((b) => b.cwd === sc.cwd && b.path === args.path)
        const recs: DiffRecord[] = []
        for (const b of all) if (b.batch === batch) for (const r of (b.records || [])) recs.push(r as unknown as DiffRecord)
        if (!recs.length) return { ok: false, error: '归档中找不到该批次' }
        recs.sort((a, b2) => (a.at < b2.at ? -1 : 1))
        beforeRec = recs[0]
        affected = recs
      } else {
        for (const r of bucket.values()) if (r.path === args.path && !r.archived) affected.push(r)
        if (!affected.length) return { ok: false, error: '该文件没有可回滚的差异' }
        affected.sort((a, b2) => (a.at < b2.at ? -1 : 1))
        beforeRec = affected[0]
      }
      const rerr = await restoreFile(ctx, sc.session, beforeRec)
      if (rerr) return { ok: false, error: rerr }
      if (batch === undefined) {
        await archiveRecords(ctx, sc.session, sc.cwd, bucket, affected, '已回滚')
      } else {
        const all = parseArchive(await readArchiveText(ctx, sc.cwd)).filter((b) => b.cwd === sc.cwd && b.path === args.path && b.batch === batch)
        const sumRecs = all.reduce((s, b) => s + ((b.records || []).length), 0)
        const logRec = Object.assign({}, affected[0], { note: (affected[0].note ? affected[0].note + '；' : '') + '回滚至本批次前（批次 ' + batch + '）' })
        await appendArchiveEntries(ctx, sc.cwd, [archiveEntryFor([logRec], sc.cwd, '已回滚（批次 ' + batch + '，' + sumRecs + ' 条）')], sc.session)
        // 批次回滚恢复的是旧内容，文件当前活跃差异已失效，一并归档
        const activeRecs: DiffRecord[] = []
        for (const r of bucket.values()) if (r.path === args.path && !r.archived) activeRecs.push(r)
        if (activeRecs.length) await archiveRecords(ctx, sc.session, sc.cwd, bucket, activeRecs, '已回滚（批次回滚覆盖）')
      }
      return { ok: true, path: args.path, batch: batch ?? null }
    },
    'edrv.debug': async (args) => {
      // 诊断日志：client 上报 → 写入工作区旁车 .dsh-edit-review-debug.log（console 不一定落盘，文件可靠）
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const fs = ctx.get('fs')
      const text = String(args.text ?? '')
      const prev = debugWriteQueues.get(sc.cwd) || Promise.resolve()
      const task = prev.then(async () => {
        try {
          const target = await fs.resolve('.dsh-edit-review-debug.log', { cwd: sc.cwd })
          const old = await fs.readText(target).catch(() => '')
          const line = new Date().toISOString() + ' ' + text + '\n'
          await fs.writeText(target, (old || '') + line, void 0, void 0, policyOf(ctx, sc.session))
        } catch (e) { /* 写日志失败忽略 */ }
      })
      debugWriteQueues.set(sc.cwd, task)
      await task
      console.error('[edrv-debug] ' + text)
      return { ok: true }
    },
    'edrv.searchFiles': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const bucket = await bucketOf(registry, ctx, sc.cwd)
      const activePaths: string[] = []
      for (const record of bucket.values()) if (record.path) activePaths.push(record.path)
      const result = await searcher.search({ session: sc.session, cwd: sc.cwd, query: args.query, activePaths })
      return { ok: true, ...result }
    },
    'mcp.list': async () => ({ ok: true, ...listMcp(ctx) }),
    'mcp.save': async (args) => {
      try { return { ok: true, server: await saveMcp(ctx, args.config) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.remove': async (args) => {
      try { await removeMcp(ctx, args.id); return { ok: true } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.toggle': async (args) => {
      try { return { ok: true, server: await toggleMcp(ctx, args.id, args.enabled) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.refresh': async (args) => {
      try { return { ok: true, server: await refreshMcp(ctx, args.id) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.projects': async () => {
      try { return { ok: true, ...await listProjects(ctx) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.projectSave': async (args) => {
      try { return { ok: true, project: await projectSave(ctx, args.workspacePath, args.serverName, args.config) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.projectRemove': async (args) => {
      try { return { ok: true, project: await projectRemove(ctx, args.workspacePath, args.serverName) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.projectToggle': async (args) => {
      try { return { ok: true, project: await projectToggle(ctx, args.workspacePath, args.serverName, args.enabled) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.projectRefresh': async (args) => {
      try { return { ok: true, project: await projectRefresh(ctx, args.workspacePath, args.serverName) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'vscode.fileOpenSettingsGet': async () => {
      const settings = ctx.get('settings')
      const descriptor = settings?.describe?.({ redactSecrets: true })?.find((item: { ns?: string }) => item.ns === FILE_OPEN_SETTINGS_NS)
      const value = descriptor?.value as { fileOpenTool?: unknown } | undefined
      return { ok: true, fileOpenTool: normalizeFileOpenTool(value?.fileOpenTool ?? FILE_OPEN_DEFAULT), revision: descriptor?.revision }
    },
    'vscode.fileOpenSettingsUpdate': async (args) => {
      const settings = ctx.get('settings')
      if (!settings?.update) return { ok: false, error: '设置服务不可用' }
      try {
        await settings.update(FILE_OPEN_SETTINGS_NS, { fileOpenTool: normalizeFileOpenTool(args.fileOpenTool) }, args.expectedRevision)
        const descriptor = settings.describe?.({ redactSecrets: true })?.find((item: { ns?: string }) => item.ns === FILE_OPEN_SETTINGS_NS)
        const value = descriptor?.value as { fileOpenTool?: unknown } | undefined
        return { ok: true, fileOpenTool: normalizeFileOpenTool(value?.fileOpenTool), revision: descriptor?.revision }
      } catch (error) { return { ok: false, error: String(error) }
      }
    },
  }
}

/**
 * 统一入口：按方法分发到 handler 表。
 * @author ddj 2026年08月20号
 */
export async function handleRpc<M extends RpcMethod>(
  ctx: Ctx,
  registry: Registry,
  method: M,
  args: RpcRequestMap[M],
  searcher = newSearcher(ctx),
): Promise<RpcResult<M>> {
  const handlers = buildHandlers(ctx, registry, searcher)
  const handler = handlers[method]
  if (!handler) return { ok: false, error: '未知方法: ' + String(method) } as RpcResult<M>
  return handler(args)
}
