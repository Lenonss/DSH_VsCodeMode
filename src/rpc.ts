/**
 * dsh-vscode-mode host — RPC 分发：类型化方法表替代巨型 switch。
 * 迁移自原 src/index.ts 的 handleRpc，方法名/载荷/错误文案一字不改。
 * 新功能 = shared/rpc.ts 加方法 + 这里加一个 handler，不改其他模块。
 * 作者 ddj 2026-08-20
 */
import type { DecideItem, DecideResult, RpcHandlerMap, RpcMethod, RpcRequestMap, RpcResult, RpcScope } from './shared/rpc.js'
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
import { mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { archiveEntryFor, markDecision, recordResolved, reconstructOriginal } from './model.js'
import type { Registry } from './registry.js'
import { bucketOf, cwdOf, sessionOf } from './registry.js'
import type { SearchOrchestrator } from './search/orchestrator.js'
import { newSearcher } from './search/orchestrator.js'
import type { ContentSearcher } from './search/content.js'
import { newContentSearcher } from './search/content.js'
import { restoreFile, revertCall, revertHunk } from './revert.js'
import { listMcp, refreshMcp, removeMcp, saveMcp, toggleMcp } from './mcp.js'
import { listProjects, projectRefresh, projectRemove, projectSave, projectToggle } from './mcpProject.js'
import { normalizeFileOpenTool, FILE_OPEN_DEFAULT, FILE_OPEN_SETTINGS_NS } from './fileOpenSettings.js'
import { buildReport } from './compat.js'
import { findProfileDir, readDevForm, setDevForm } from './devForm.js'
import { normalizeRel } from './tree.js'
import { invalidateIndex, listDirCached } from './treeIndex.js'
import { revealInExplorer } from './reveal.js'
import { DEBUG_LOG, debugLogFile, dshHome, pluginLogRoot } from './paths.js'
import { markActiveSessions, moveOutSessions, planMoveOut, purgeArchive, restoreSession, scanSessionInventory, sessionsArchiveRoot, sessionSizeOf, sidecarSummaryOf } from './perf.js'
import { patchHasPerfConfig, patchInsertPerfConfig, patchRemovePerfConfig, perfConfigBlock } from './perfPatch.js'

/** cwd → 内存缓冲：行数组 + 累计字节数 + 待触发 flush 定时器（攒批落盘，避免每条日志全文件读改写）。 */
const debugBuffers = new Map<string, { lines: string[]; len: number; timer: ReturnType<typeof setTimeout> | null }>()
/** cwd → Promise 链：串行化 debug 日志落盘（fs read+write 非原子，避免并发丢行）。 */
const debugWriteQueues = new Map<string, Promise<void>>()
/** debug 日志单文件上限：超限截断保留尾部，防文件无限增长拖慢每次追加。 */
const DEBUG_LOG_CAP = 512 * 1024
/** debug 日志批量缓冲上限：攒满即落盘（一次读改写），上限内不逐条写文件。 */
const DEBUG_BUF_CAP = 32 * 1024
/** debug 日志空闲 flush 延迟：缓冲未满时，静默一段时间后落盘一次。 */
const DEBUG_FLUSH_IDLE_MS = 1000
/** cwd → 上次 stale 自动清理时间：全量轮询（EditorView/DiffBadge/Dock 各自 5s）节流，避免每轮都读文件算指纹。 */
const staleCheckedAt = new Map<string, number>()
/** stale 自动清理最小间隔。 */
const STALE_CHECK_MIN_MS = 10_000

/**
 * 调试日志入队：先攒内存缓冲（行 + 字节数），满 DEBUG_BUF_CAP 立即落盘，
 * 否则空闲 DEBUG_FLUSH_IDLE_MS 后落盘；落盘 = 读旧文件 + 追加整批 + 超限截断 + 一次写入。
 * @author ddj 2026年08月26号 / 2026年09月01号
 * @param ctx DSH 上下文
 * @param cwd 工作区（日志按 cwd hash 存 ~/.dsh/dsh-vscode-mode/logs/）
 * @param line 单条日志文本（不含换行）
 */
function enqueueDebug(ctx: Ctx, cwd: string, line: string): void {
  const st = debugBuffers.get(cwd) ?? { lines: [], len: 0, timer: null }
  st.lines.push(line)
  st.len += line.length
  const flush = () => {
    st.timer = null
    const batch = st.lines
    st.lines = []
    st.len = 0
    void flushDebug(cwd, batch)
  }
  if (st.len >= DEBUG_BUF_CAP) {
    if (st.timer) clearTimeout(st.timer)
    flush()
  } else if (!st.timer) {
    st.timer = setTimeout(flush, DEBUG_FLUSH_IDLE_MS)
  }
  debugBuffers.set(cwd, st)
}

/** cwd → 已清理旧工作区 debug 日志标记（一次性）。 */
const debugLegacyCleaned = new Set<string>()

/**
 * 批量落盘一条 debug 日志缓冲：读旧文件 → 追加 → 超上限截断保留尾部 → 一次写回。
 * 串行链保证同一 cwd 的读改写不交错丢行；写失败静默忽略（调试日志不阻塞业务）。
 * @author ddj 2026年08月26号 / 2026年09月01号
 * @param cwd 工作区（日志落 ~/.dsh/dsh-vscode-mode/logs/debug.<cwdHash>.log）
 * @param batch 本批日志行
 */
function flushDebug(cwd: string, batch: string[]): Promise<void> {
  const prev = debugWriteQueues.get(cwd) ?? Promise.resolve()
  const task = prev.then(async () => {
    try {
      await mkdir(pluginLogRoot(), { recursive: true })
      const target = debugLogFile(cwd)
      const old = await readFile(target, 'utf8').catch(() => '')
      const appended = old + batch.map((l) => new Date().toISOString() + ' ' + l + '\n').join('')
      const next = appended.length > DEBUG_LOG_CAP ? appended.slice(-Math.floor(DEBUG_LOG_CAP / 2)) : appended
      await writeFile(target, next, 'utf8')
      // 迁移后一次性清理旧工作区 debug 日志（best-effort）
      if (!debugLegacyCleaned.has(cwd)) {
        debugLegacyCleaned.add(cwd)
        await rm(join(cwd, DEBUG_LOG), { force: true }).catch(() => {})
      }
    } catch (e) { /* 写日志失败忽略 */ }
  })
  debugWriteQueues.set(cwd, task)
  return task
}

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

/**
 * 批量决策核心：一次会话/桶解析 + 逐项处理 + 统一落盘（accept/reject 单条与 decideBatch 共用）。
 * rejected 项先做回滚，失败记入该项 error 且不改决策；本批次新增"已解决"记录一次性归档，
 * 有任何成功项则整桶只写盘一次，避免逐条读写整个 sidecar。
 * @author ddj 2026年08月25号
 * @param items 决策项（按数组顺序处理，rejected 的先后即回滚顺序）
 * @returns 逐项结果（ok 项含更新后的记录视图）
 */
async function applyDecisions(
  ctx: Ctx,
  session: Session,
  cwd: string,
  bucket: Map<string, DiffRecord>,
  items: DecideItem[],
): Promise<DecideResult[]> {
  const results: DecideResult[] = []
  const resolved: DiffRecord[] = []
  let changed = false
  for (const item of items) {
    const record = bucket.get(item.callId)
    if (!record) {
      results.push({ callId: item.callId, ok: false, error: '记录不存在' })
      continue
    }
    if (item.decision === 'rejected') {
      const scope: RpcScope = item.scope ?? 'call'
      const outcome = scope === 'hunk' ? await revertHunk(ctx, session, record, item.hunkIndex ?? -1) : await revertCall(ctx, session, record)
      if (!outcome.ok) {
        results.push({ callId: item.callId, ok: false, error: outcome.error })
        continue
      }
    }
    const wasResolved = recordResolved(record)
    markDecision(record, item.scope ?? 'call', item.hunkIndex, item.decision)
    changed = true
    if (!wasResolved && recordResolved(record)) resolved.push(record)
    results.push({ callId: item.callId, ok: true, record: recView(record) })
  }
  if (resolved.length) {
    const reason = items.some((item) => item.decision === 'rejected') ? '已处理（回滚）' : '已处理'
    await archiveRecords(ctx, session, cwd, bucket, resolved, reason, { deferSave: true })
  }
  if (changed) await saveBucket(ctx, cwd, bucket, session)
  return results
}

/** 当前活跃会话 id 集合（live sessions，用于移出/恢复护栏）。 */
function activeSessionIds(ctx: Ctx): Set<string> {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.list !== 'function') return new Set()
  return new Set((sessions.list() as Session[]).map((s) => s.id).filter(Boolean))
}

/** profile patch 文件定位（依赖本插件的 profile，同 devForm）。 */
async function patchFileInfo(): Promise<{ profileDir?: string; patchPath?: string }> {
  const profileDir = findProfileDir()
  if (!profileDir) return {}
  return { profileDir, patchPath: join(profileDir, 'cordis.patch.yml') }
}

/** 最新一次压缩配置备份文件名（cordis.patch.yml.bak-<ts>，按名倒序取新）。 */
async function latestPatchBackup(patchPath: string): Promise<string | undefined> {
  const dir = join(patchPath, '..')
  const base = basename(patchPath)
  const names = await readdir(dir).catch(() => [])
  return names.filter((n) => n.startsWith(base + '.bak-')).sort().reverse()[0]
}

/** 各方法 handler 表（类型由 shared/rpc 的 RpcHandlerMap 约束）。 */
export function buildHandlers(
  ctx: Ctx,
  registry: Registry,
  searcher = newSearcher(ctx),
  contentSearcher = newContentSearcher(ctx),
  lspHandlers?: Partial<RpcHandlerMap>,
): RpcHandlerMap {
  return {
    // edrv.lsp.* 由 createLspRpc 一次性提供（tracker 跨请求保留），这里并入。
    ...((lspHandlers ?? {}) as RpcHandlerMap),
    'edrv.list': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const bucket = await bucketOf(registry, ctx, sc.cwd)
      const want = Array.isArray(args.callIds) ? new Set(args.callIds) : null
      // 全量轮询时自动清理 stale 幽灵差异（批量决策后的即时刷新可 skipStale 跳过）；
      // 三个组件各自 5s 全量 list，stale 检查节流到 STALE_CHECK_MIN_MS 一次，
      // 避免每轮都对全部记录读文件 + 算指纹（keepall 期间多组件同时刷新的主要 host 开销）。
      if (!want && args.skipStale !== true) {
        const now = Date.now()
        if (now - (staleCheckedAt.get(sc.cwd) ?? 0) > STALE_CHECK_MIN_MS) {
          staleCheckedAt.set(sc.cwd, now)
          await autoArchiveStale(ctx, sc.session, sc.cwd, bucket)
        }
      }
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
      const results = await applyDecisions(ctx, sc.session, sc.cwd, bucket, [{ callId: args.callId, scope: args.scope, hunkIndex: args.hunkIndex, decision: 'accepted' }])
      const item = results[0]
      if (!item?.ok) return { ok: false, error: item?.error ?? '操作失败' }
      return { ok: true, record: item.record! }
    },
    'edrv.reject': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const bucket = await bucketOf(registry, ctx, sc.cwd)
      const results = await applyDecisions(ctx, sc.session, sc.cwd, bucket, [{ callId: args.callId, scope: args.scope, hunkIndex: args.hunkIndex, decision: 'rejected' }])
      const item = results[0]
      if (!item?.ok) return { ok: false, error: item?.error ?? '操作失败' }
      return { ok: true, record: item.record! }
    },
    'edrv.decideBatch': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const bucket = await bucketOf(registry, ctx, sc.cwd)
      const results = await applyDecisions(ctx, sc.session, sc.cwd, bucket, Array.isArray(args.items) ? args.items : [])
      return { ok: true, results }
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
        // 手动保存后目录树可能变化（新建/删除文件）：父目录+祖先进失效，后台自愈。
        invalidateIndex(ctx, sc.cwd, args.path)
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
      // 诊断日志：client 上报 → 内存缓冲批量落盘 .dsh-edit-review-debug.log（console 不一定落盘，文件可靠）。
      // 只出现在调试开关开启时（client dbg 默认关），终端仍逐条打印便于实时观察。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const text = String(args.text ?? '')
      enqueueDebug(ctx, sc.cwd, text)
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
    'edrv.searchContent': async (args) => {
      // 工作区内容搜索：rg --json 主路径；provider 失败转错误响应（无 fallback）。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      try {
        const result = await contentSearcher.search({
          session: sc.session,
          cwd: sc.cwd,
          query: args.query,
          matchCase: args.matchCase,
          wholeWord: args.wholeWord,
          regex: args.regex,
          maxResults: args.maxResults,
          include: args.include,
          exclude: args.exclude,
        })
        return { ok: true, ...result }
      } catch (error) {
        return { ok: false, error: '搜索失败：' + String(error) }
      }
    },
    'edrv.listDir': async (args) => {
      // 目录树（侧边栏文件管理用）：树索引命中直出（内存，0 IO）；失效/force 时
      // 走快路径（resolve + listDirCheap + putIndex）；同路径在途请求去重复用。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const rel = normalizeRel(args.path)
      if (rel === null) return { ok: false, error: '路径不合法' }
      const res = await listDirCached(ctx, sc.cwd, rel, args.force === true)
      if ('error' in res) return { ok: false, error: res.error }
      return { ok: true, root: res.root, path: rel, entries: res.entries }
    },
    'edrv.revealInExplorer': async (args) => {
      // 在 OS 文件浏览器中打开/定位路径（树行/编辑器右键菜单用），相对工作区解析。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const fs = ctx.get('fs')
      if (!fs) return { ok: false, error: '缺少 fs' }
      try {
        const rel = normalizeRel(args.path)
        if (rel === null) return { ok: false, error: '路径不合法' }
        const target = await fs.resolve(rel || '.', { cwd: sc.cwd })
        const info = await fs.stat(target)
        if (!info) return { ok: false, error: '路径不存在' }
        const abs = fs.processPath(target)
        const outcome = await revealInExplorer(ctx, abs, info.type === 'directory')
        if (!outcome.ok) return { ok: false, error: outcome.error }
        return { ok: true, revealed: abs }
      } catch (error) {
        return { ok: false, error: '打开失败：' + String(error) }
      }
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
    'compat': async () => ({ ok: true, report: await buildReport(ctx) }),
    'vscode.devFormGet': async () => ({ ok: true, devForm: readDevForm() }),
    'vscode.devFormSet': async (args) => {
      try {
        const result = await setDevForm(ctx, args.enabled === true, args.path)
        if (!result.ok) return { ok: false, error: result.error ?? '切换开发形态失败' }
        return { ok: true, devForm: readDevForm(), restart: result.restart }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'edrv.perf.inventory': async () => {
      try {
        const home = dshHome()
        const inventory = await scanSessionInventory(home, sessionsArchiveRoot(home))
        const active = activeSessionIds(ctx)
        markActiveSessions(inventory.sessions, active)
        return { ok: true, ...inventory, activeIds: [...active] }
      } catch (error) {
        return { ok: false, error: '盘点失败：' + String(error) }
      }
    },
    'edrv.perf.sessionSize': async (args) => {
      try {
        const size = await sessionSizeOf(dshHome(), args.cwd, args.sessionId ?? '')
        return { ok: true, ...size }
      } catch (error) {
        return { ok: false, error: '读取会话体积失败：' + String(error) }
      }
    },
    'edrv.perf.movePlan': async (args) => {
      try {
        const home = dshHome()
        const inventory = await scanSessionInventory(home, sessionsArchiveRoot(home))
        markActiveSessions(inventory.sessions, activeSessionIds(ctx))
        const plan = planMoveOut(inventory, { workspaceKey: args.workspaceKey, sessionIds: args.sessionIds, minBytes: args.minBytes, olderThanDays: args.olderThanDays })
        return { ok: true, ...plan }
      } catch (error) {
        return { ok: false, error: '移出规划失败：' + String(error) }
      }
    },
    'edrv.perf.moveOut': async (args) => {
      try {
        const home = dshHome()
        const items = (args.sessionIds ?? []).map((sessionId) => ({ workspaceKey: args.workspaceKey, sessionId, bytes: 0 }))
        const result = await moveOutSessions(home, sessionsArchiveRoot(home), items, activeSessionIds(ctx), args.dryRun === true)
        return { ok: true, ...result }
      } catch (error) {
        return { ok: false, error: '移出失败：' + String(error) }
      }
    },
    'edrv.perf.restore': async (args) => {
      try {
        const result = await restoreSession(dshHome(), sessionsArchiveRoot(dshHome()), args.workspaceKey, args.sessionId)
        return result.ok ? { ok: true, restored: true } : { ok: false, error: result.error ?? '恢复失败' }
      } catch (error) {
        return { ok: false, error: '恢复失败：' + String(error) }
      }
    },
    'edrv.perf.purgeArchive': async (args) => {
      try {
        const result = await purgeArchive(sessionsArchiveRoot(dshHome()), args.olderThanDays)
        return { ok: true, ...result }
      } catch (error) {
        return { ok: false, error: '清除失败：' + String(error) }
      }
    },
    'edrv.perf.sidecarSummary': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      const cwd = 'err' in sc ? null : sc.cwd
      try {
        const summary = await sidecarSummaryOf(ctx, cwd)
        return { ok: true, ...summary }
      } catch (error) {
        return { ok: false, error: '读取侧车摘要失败：' + String(error) }
      }
    },
    'edrv.perf.configGet': async () => {
      try {
        const { profileDir, patchPath } = await patchFileInfo()
        const block = perfConfigBlock()
        if (!patchPath) return { ok: true, applied: false, block }
        const text = await readFile(patchPath, 'utf8').catch(() => '')
        const backup = await latestPatchBackup(patchPath)
        return { ok: true, profileDir, patchPath, applied: patchHasPerfConfig(text), block, backup }
      } catch (error) {
        return { ok: false, error: '读取压缩配置失败：' + String(error) }
      }
    },
    'edrv.perf.configApply': async () => {
      try {
        const { patchPath } = await patchFileInfo()
        if (!patchPath) return { ok: false, error: '未找到依赖本插件的 profile（检查 DSH_HOME/profiles）' }
        const text = await readFile(patchPath, 'utf8').catch(() => '')
        const backup = patchPath + '.bak-' + Date.now()
        if (text) await writeFile(backup, text, 'utf8')
        await mkdir(join(patchPath, '..'), { recursive: true })
        await writeFile(patchPath, patchInsertPerfConfig(text), 'utf8')
        return { ok: true, applied: true, backup, restart: true }
      } catch (error) {
        return { ok: false, error: '写入压缩配置失败：' + String(error) }
      }
    },
    'edrv.perf.configUndo': async () => {
      try {
        const { patchPath } = await patchFileInfo()
        if (!patchPath) return { ok: false, error: '未找到依赖本插件的 profile（检查 DSH_HOME/profiles）' }
        const backup = await latestPatchBackup(patchPath)
        if (backup) {
          const backupPath = join(join(patchPath, '..'), backup)
          const saved = await readFile(backupPath, 'utf8').catch(() => null)
          if (saved !== null) {
            await writeFile(patchPath, saved, 'utf8')
            await rm(backupPath, { force: true }).catch(() => {})
            return { ok: true, restored: true, backup }
          }
        }
        const text = await readFile(patchPath, 'utf8').catch(() => '')
        if (!patchHasPerfConfig(text)) return { ok: false, error: '没有可撤销的压缩配置' }
        await writeFile(patchPath, patchRemovePerfConfig(text), 'utf8')
        return { ok: true, restored: true }
      } catch (error) {
        return { ok: false, error: '撤销压缩配置失败：' + String(error) }
      }
    },
  }
}

/**
 * 统一入口：按方法分发到 handler 表。
 * @author ddj 2026年08月20号 / 2026年08月26号
 */
export async function handleRpc<M extends RpcMethod>(
  ctx: Ctx,
  registry: Registry,
  method: M,
  args: RpcRequestMap[M],
  searcher = newSearcher(ctx),
  contentSearcher = newContentSearcher(ctx),
  lspHandlers?: Partial<RpcHandlerMap>,
): Promise<RpcResult<M>> {
  const handlers = buildHandlers(ctx, registry, searcher, contentSearcher, lspHandlers)
  const handler = handlers[method]
  if (!handler) return { ok: false, error: '未知方法: ' + String(method) } as RpcResult<M>
  return handler(args)
}
