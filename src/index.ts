// @ts-nocheck
import { readFile } from 'node:fs/promises'
import { dirname, join, normalize, resolve, sep, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
/**
 * @dsh-external/dsh-edit-review — 编辑差异审查（仿 CodeBuddy/Cursor）Host 半
 * 职责：tools/result 捕获 edit/write（result.value 含完整 before/after + meta.diffs）；
 *       工作区旁车 .dsh-edit-review.json 持久化（version2 按工作区存储，写前合并，重启不丢）；
 *       /edrv/rpc 路由处理 list/accept/reject/read/save/original/archiveList/archiveRead/rollback（静态客户端经 fetch 调用）；
 *       /edrv/assets/* 静态图片（入口按钮图标）；/edrv/vendor/* Monaco Editor AMD 构建（assets/vendor 随包发布）。
 *       config.imageDir 可覆盖成自定义目录（如本机 OneDrive 图片目录），替换 PNG 后刷新即生效。
 *       webServer 声明进 inject：其 init 异步，不声明会在启动竞态下 get 到 undefined 导致路由静默缺失。
 * 作者 ddj 2026-08-18
 */
export const name = "dsh-vscode-mode"
export const inject = ['sessions', 'fs', 'webServer']

const IMG_ROUTES = [
  { url: '/edrv/assets/compare-idle.png', file: 'compare_idle.png' },
  { url: '/edrv/assets/compare-select.png', file: 'compare_select.png' }
]

/** Monaco AMD 构建静态资源（随包发布，离线可用；前缀路由 /edrv/vendor/*）。 */
const VENDOR_PREFIX = '/edrv/vendor'
const VENDOR_MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.ts': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown'
}

/** 图标目录：默认插件包内 assets/（随包发布）；config.imageDir 可覆盖（用于自定义换图）。 */
function imageDirOf(config) {
  if (config && typeof config.imageDir === 'string' && config.imageDir) return config.imageDir.replace(/\\/g, '/')
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
}

const MAX_RECORDS = 200
const SIDECAR = '.dsh-edit-review.json'
const SIDECAR_ARCHIVE = '.dsh-edit-review-archive.json'
const READ_CAP = 8 * 1024 * 1024

/** 工作区文件清单缓存：TTL + 扫描上限（避免大工作区反复全量扫描）。 */
const FILE_INDEX_TTL = 60_000
const SCAN_CAP = 6000
/** cwd -> { at, files }（快速打开/搜索用；随会话销毁清理）。 */
const fileIndex = new Map()
/** cwd -> Promise 链：串行化 debug 日志追加（fs read+write 非原子，避免并发丢行）。 */
const debugWriteQueues = new Map()

function policyOf(ctx, session) {
  const svc = ctx.get('sandboxPolicy')
  if (!svc) return undefined
  return session ? svc.resolve({ session }) : svc.resolve()
}

async function resolveTarget(ctx, session, path) {
  const fs = ctx.get('fs')
  const cwd = session?.header?.cwd
  return fs.resolve(path, cwd ? { cwd } : {})
}

async function readSidecarText(ctx, cwd) {
  const fs = ctx.get('fs')
  if (!fs || !cwd) return null
  try {
    return await fs.readText(await fs.resolve(SIDECAR, { cwd }))
  } catch (error) {
    return null
  }
}

function parseSidecar(text) {
  if (!text) return null
  try {
    const data = JSON.parse(text)
    if (data && typeof data === 'object' && data.version === 2 && data.workspaces && typeof data.workspaces === 'object') return data
    if (data && data.version === 1 && data.sessions && typeof data.sessions === 'object') {
      const workspaces = {}
      for (const bucket of Object.values(data.sessions)) {
        if (bucket && typeof bucket.cwd === 'string' && bucket.records) workspaces[bucket.cwd] = { at: bucket.at ?? Date.now(), records: bucket.records }
      }
      return { version: 2, updatedAt: data.updatedAt, workspaces }
    }
    return null
  } catch (error) {
    return null
  }
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.callId !== 'string' || typeof raw.path !== 'string') return null
  const hunks = Array.isArray(raw.hunks) ? raw.hunks.filter((h) => h && typeof h.newText === 'string') : []
  return {
    callId: raw.callId,
    toolName: raw.toolName === 'write' ? 'write' : 'edit',
    path: raw.path,
    before: typeof raw.before === 'string' ? raw.before : null,
    create: raw.create === true,
    callHunk: raw.callHunk && typeof raw.callHunk.oldText === 'string' ? { oldText: raw.callHunk.oldText, newText: raw.callHunk.newText } : null,
    hunks: hunks.map((h) => ({ oldText: typeof h.oldText === 'string' ? h.oldText : null, newText: h.newText })),
    decisions: raw.decisions && typeof raw.decisions === 'object' ? raw.decisions : { call: 'pending', perHunk: hunks.map(() => 'pending') },
    note: typeof raw.note === 'string' ? raw.note : null,
    superseded: raw.superseded === true,
    archived: raw.archived === true,
    batch: Number.isInteger(raw.batch) ? raw.batch : 0,
    at: typeof raw.at === 'string' ? raw.at : new Date().toISOString()
  }
}

function loadBucket(ctx, cwd) {
  return readSidecarText(ctx, cwd).then((text) => {
    const data = parseSidecar(text)
    const map = new Map()
    if (data && data.workspaces[cwd] && typeof data.workspaces[cwd].records === 'object') {
      for (const rec of Object.values(data.workspaces[cwd].records)) {
        const n = normalizeRecord(rec)
        if (n) map.set(n.callId, n)
      }
    }
    return map
  })
}

async function saveBucket(ctx, cwd, recsMap, session) {
  const fs = ctx.get('fs')
  if (!fs || !cwd) return
  try {
    const target = await fs.resolve(SIDECAR, { cwd })
    const existing = parseSidecar(await readSidecarText(ctx, cwd)) ?? { version: 2, workspaces: {} }
    existing.workspaces[cwd] = { at: Date.now(), records: Object.fromEntries(recsMap) }
    existing.updatedAt = new Date().toISOString()
    await fs.writeText(target, JSON.stringify(existing), void 0, void 0, policyOf(ctx, session))
  } catch (error) {
    console.error('edrv saveBucket failed', error)
  }
}

function prune(map) {
  if (map.size <= MAX_RECORDS) return
  const sorted = [...map.values()].sort((a, b) => (a.at < b.at ? -1 : 1))
  for (let i = 0; i < sorted.length - MAX_RECORDS; i++) map.delete(sorted[i].callId)
}

async function deleteCreated(ctx, session, record) {
  const sub = ctx.get('subprocess')
  const fs = ctx.get('fs')
  if (!sub || !fs) return { ok: false, error: '回滚不可用：缺少 subprocess/fs' }
  const policy = policyOf(ctx, session)
  const rootTarget = await fs.resolve(policy?.workspaceRoot ?? '.', {})
  const target = await resolveTarget(ctx, session, record.path)
  if (!fs.contains(rootTarget, target)) return { ok: false, error: '拒绝删除：目标不在会话工作区内' }
  const p = fs.processPath(target)
  // subprocess 契约：spawn({ argv, stdio, graceMs })，done → { exitCode }，输出走 handle.collected
  const attempt = async (argv) => {
    const handle = sub.spawn({
      argv,
      stdio: { stdout: { maxBytes: 1 << 16 }, stderr: { maxBytes: 1 << 16 }, stdin: 'ignore' },
      graceMs: 10000
    })
    const outcome = await handle.done
    const code = outcome?.exitCode ?? outcome?.code
    if (code !== 0) {
      const err = handle.collected?.stderr?.readFrom(0).text ?? ''
      throw new Error('exit ' + code + ' ' + err)
    }
  }
  try {
    await attempt(['powershell', '-NoProfile', '-NonInteractive', '-Command', 'Remove-Item -LiteralPath "' + p + '" -Force'])
    return { ok: true }
  } catch (error) {
    try {
      await attempt(['/bin/rm', '-f', '--', p])
      return { ok: true }
    } catch (error2) {
      return { ok: false, error: '删除失败（文件仍存在）：' + String(error) + ' / ' + String(error2) }
    }
  }
}

/**
 * 扫描工作区文件清单（快速打开/搜索用）：subprocess（Windows powershell / POSIX find），
 * 排除常见重目录，容量上限 SCAN_CAP；结果缓存（TTL FILE_INDEX_TTL）。失败返回 null。
 * @author ddj 2026年08月18号
 * @param {object} ctx 插件上下文
 * @param {object} session 会话（取工作区根）
 * @param {string} cwd 工作区目录
 * @returns {Promise<string[]|null>} 绝对路径清单；不可用（无 subprocess/fs）或扫描失败返回 null
 */
async function listWorkspaceFiles(ctx, session, cwd) {
  const cached = fileIndex.get(cwd)
  if (cached && Date.now() - cached.at < FILE_INDEX_TTL) return cached.files
  const sub = ctx.get('subprocess')
  const fs = ctx.get('fs')
  if (!sub || !fs) return null
  const policy = policyOf(ctx, session)
  let root
  try {
    const rootTarget = await fs.resolve(policy?.workspaceRoot ?? '.', {})
    root = fs.processPath(rootTarget)
  } catch (error) {
    root = cwd
  }
  const lines = []
  const run = async (argv) => {
    const handle = sub.spawn({
      argv,
      stdio: { stdout: { maxBytes: 8 << 20 }, stderr: { maxBytes: 1 << 16 }, stdin: 'ignore' },
      graceMs: 20000
    })
    const outcome = await handle.done
    const code = outcome?.exitCode ?? outcome?.code
    if (code !== 0) throw new Error('scan exit ' + code)
    const text = handle.collected?.stdout?.readFrom(0).text ?? ''
    for (const ln of text.split(/\r?\n/)) {
      const s = ln.trim()
      if (s) lines.push(s)
    }
  }
  try {
    if (process.platform === 'win32') {
      const cmd = 'Get-ChildItem -LiteralPath "' + String(root).replace(/"/g, '""') + '" -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch \'(node_modules|\\.git|\\.tmp|\\.cache|dist|build|vendor|coverage|__pycache__)\' } | Select-Object -First ' + SCAN_CAP + ' | ForEach-Object { $_.FullName }'
      await run(['powershell', '-NoProfile', '-NonInteractive', '-Command', cmd])
    } else {
      const cmd = 'find ' + JSON.stringify(root) + ' -type f -not -path \'*/node_modules/*\' -not -path \'*/.git/*\' -not -path \'*/.tmp/*\' -not -path \'*/.cache/*\' -not -path \'*/dist/*\' -not -path \'*/build/*\' -not -path \'*/vendor/*\' -not -path \'*/coverage/*\' 2>/dev/null | head -n ' + SCAN_CAP
      await run(['/bin/sh', '-c', cmd])
    }
  } catch (error) {
    console.error('edrv scan failed', error)
    return null
  }
  const files = lines.slice(0, SCAN_CAP)
  if (files.length) fileIndex.set(cwd, { at: Date.now(), files })
  return files
}

async function revertCall(ctx, session, record) {
  const fs = ctx.get('fs')
  if (!fs) return { ok: false, error: '回滚不可用：缺少 fs' }
  if (record.before === null) {
    if (!record.create) return { ok: false, error: '无法回滚：缺少修改前内容（大文件或旧记录）' }
    return deleteCreated(ctx, session, record)
  }
  try {
    const target = await resolveTarget(ctx, session, record.path)
    await fs.writeText(target, record.before, void 0, void 0, policyOf(ctx, session))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: '回滚失败：' + String(error) }
  }
}

async function revertHunk(ctx, session, record, idx) {
  const fs = ctx.get('fs')
  if (!fs) return { ok: false, error: '回滚不可用：缺少 fs' }
  const hunk = record.hunks[idx]
  const precise = record.toolName === 'edit' && record.hunks.length <= 1 && record.callHunk ? record.callHunk : hunk
  if (!precise) return { ok: false, error: '找不到该差异块' }
  try {
    const target = await resolveTarget(ctx, session, record.path)
    await fs.editText(target, { oldString: precise.newText, newString: precise.oldText === null ? '' : precise.oldText }, void 0, void 0, policyOf(ctx, session))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: '回滚失败：该区域可能已被后续修改影响（' + String(error) + '）' }
  }
}

function markDecision(record, scope, idx, value) {
  const dec = record.decisions
  if (scope === 'hunk' && Array.isArray(dec.perHunk) && Number.isInteger(idx)) {
    if (idx >= 0 && idx < dec.perHunk.length) dec.perHunk[idx] = value
  } else {
    dec.call = value
    if (Array.isArray(dec.perHunk)) dec.perHunk = dec.perHunk.map(() => value)
  }
  record.at = new Date().toISOString()
  return record
}

/**
 * 重建"本批次修改前"内容：把仍待处理（pending）的差异块按 新→旧 顺序从当前内容中反解
 * （newText → oldText）。已采纳/已拒绝的块跳过（采纳=保留现状、拒绝=磁盘已回退）。
 * 反解失败的块标记为 stale（文件可能被手动改动），调用方决定是否整体回退。
 * @author ddj 2026年08月18号
 * @param {Array} records 该文件的活动记录（含 decisions）
 * @param {string} content 当前磁盘内容
 * @returns {{ content: string, stale: Array<{callId: string, idx: number}> }}
 */
function reconstructOriginal(records, content) {
  const pending = []
  for (const rec of records) {
    const dec = rec.decisions || {}
    const perHunk = Array.isArray(dec.perHunk) ? dec.perHunk : []
    for (let i = 0; i < rec.hunks.length; i++) {
      const st = perHunk.length ? perHunk[i] : dec.call
      if (st === 'pending') pending.push({ rec, idx: i })
    }
  }
  pending.sort((a, b) => (a.rec.at < b.rec.at ? 1 : a.rec.at > b.rec.at ? -1 : 0))
  let out = content
  const stale = []
  for (const p of pending) {
    const h = p.rec.hunks[p.idx]
    const precise = p.rec.toolName === 'edit' && p.rec.hunks.length <= 1 && p.rec.callHunk ? p.rec.callHunk : h
    const newText = precise.newText ?? ''
    const at = out.indexOf(newText)
    if (at < 0) { stale.push({ callId: p.rec.callId, idx: p.idx }); continue }
    const oldText = precise.oldText === null ? '' : precise.oldText
    out = out.slice(0, at) + oldText + out.slice(at + newText.length)
  }
  return { content: out, stale }
}

/**
 * 读取记录目标文件内容（按 path 缓存一次；缺失/过大/失败 → null/'' 占位）。
 * @author ddj 2026年08月19号
 * @param {object} ctx DSH 上下文
 * @param {object} session 会话
 * @param {Map<string,string|null>} cache path → 内容（null=缺失/读取失败，''=过大跳过）
 * @param {string} path 记录路径
 * @returns {Promise<string|null>} 文件内容或 null
 */
async function readForCache(ctx, session, cache, path) {
  if (cache.has(path)) return cache.get(path)
  const fs = ctx.get('fs')
  if (!fs) { cache.set(path, null); return null }
  try {
    const target = await resolveTarget(ctx, session, path)
    const info = await fs.stat(target)
    if (!info || info.type !== 'file') { cache.set(path, null); return null }
    if ((info.size ?? 0) > READ_CAP) { cache.set(path, ''); return '' }
    const content = await fs.readText(target)
    cache.set(path, content)
    return content
  } catch (error) {
    cache.set(path, null)
    return null
  }
}

/**
 * 判断记录是否已无任何可操作差异（stale）：待决策 hunk 的新文本在磁盘均找不到，
 * 或新建文件已不存在，或全为空差异（old===new）。满足则应由 host 自动归档。
 * @author ddj 2026年08月19号
 * @param {object} ctx DSH 上下文
 * @param {object} session 会话
 * @param {Map<string,string|null>} cache path → 内容
 * @param {object} rec 记录
 * @returns {Promise<boolean>} 是否应自动归档
 */
async function recordIsStale(ctx, session, cache, rec) {
  if (rec.superseded === true) return true
  if (!Array.isArray(rec.hunks) || !rec.hunks.length) return true
  const dec = rec.decisions || {}
  const perHunk = Array.isArray(dec.perHunk) ? dec.perHunk : []
  let hasLocatablePending = false
  for (let i = 0; i < rec.hunks.length; i++) {
    const st = perHunk.length ? perHunk[i] : dec.call
    if (st === 'accepted' || st === 'rejected') continue
    if (rec.create === true) {
      // 新建文件：文件存在于磁盘即保留
      const content = await readForCache(ctx, session, cache, rec.path)
      if (content !== null) { hasLocatablePending = true; break }
      continue
    }
    const precise = rec.toolName === 'edit' && rec.callHunk ? rec.callHunk : rec.hunks[i]
    const oldText = precise?.oldText ?? null
    const newText = precise?.newText ?? null
    if (oldText !== null && oldText === newText) continue // 空差异无意义
    if (newText === null || newText === undefined) continue
    const content = await readForCache(ctx, session, cache, rec.path)
    if (content !== null && content.indexOf(newText) >= 0) { hasLocatablePending = true; break }
  }
  return !hasLocatablePending
}

/**
 * edrv.list 时自动清理 stale 记录：把无任何可操作差异的记录标记 superseded 并归档，
 * 防止"幽灵差异"（改动已被后续编辑覆盖）长期留在审查列表且无法操作。
 * @author ddj 2026年08月19号
 * @param {object} ctx DSH 上下文
 * @param {object} session 会话
 * @param {string} cwd 会话工作区
 * @param {Map} bucket 当前工作区记录桶
 * @returns {Promise<number>} 自动归档条数
 */
async function autoArchiveStale(ctx, session, cwd, bucket) {
  const fs = ctx.get('fs')
  if (!fs) return 0
  const cache = new Map()
  const stale = []
  for (const rec of bucket.values()) {
    if (rec.archived || rec.superseded === true) continue
    if (await recordIsStale(ctx, session, cache, rec)) stale.push(rec)
  }
  if (!stale.length) return 0
  for (const r of stale) { r.superseded = true; r.at = new Date().toISOString() }
  await archiveRecords(ctx, session, cwd, bucket, stale, '差异无法定位（已被后续修改覆盖），自动归档')
  return stale.length
}

function recView(record) {
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
    at: record.at
  }
}

/* ═══ 批次与归档 ══════════════════════════════════════════════════════
  模型（按用户语义）：
  - 每个文件有"批次"（batch）号：每次新 edit/write 该文件，batch 递增到最新；
    文件内容本身总是"采纳后状态"（改动已落在磁盘）。
  - 文件被再次修改时（batch 递增），早于最新批次的未归档差异一律"融合"归档
    （内容已含其效果 / 已被新修改取代），审查只关注最新批次。
  - 每条差异在其操作完成（采纳/拒绝/被覆盖）后立即单条归档。
  - 一个文件的最新批次记录全部归档后，该文件不再出现在审查列表。
  - 内置回滚：可把文件恢复到某批次之前（用该批最早记录的 before），回滚本身也入归档。 */

function fileMaxBatch(records, path) {
  let m = 0
  for (const r of records.values()) {
    if (r.path === path && Number.isInteger(r.batch) && r.batch > m) m = r.batch
  }
  return m
}

function recordResolved(record) {
  if (record.superseded === true) return true
  const dec = record.decisions || {}
  const perHunk = Array.isArray(dec.perHunk) ? dec.perHunk : []
  if (perHunk.length) return perHunk.every((v) => v === 'accepted' || v === 'rejected')
  return dec.call === 'accepted' || dec.call === 'rejected'
}

function recSummary(record) {
  const dec = record.decisions || {}
  const perHunk = Array.isArray(dec.perHunk) ? dec.perHunk : []
  const n = Math.max(1, Array.isArray(record.hunks) ? record.hunks.length : 1)
  let accepted = 0, rejected = 0, pending = 0
  if (perHunk.length) {
    for (const v of perHunk) {
      if (v === 'accepted') accepted++
      else if (v === 'rejected') rejected++
      else pending++
    }
  } else if (dec.call === 'accepted') accepted = n
  else if (dec.call === 'rejected') rejected = n
  else pending = n
  return { accepted, rejected, pending, superseded: record.superseded === true }
}

function archiveEntryFor(recs, cwd, reason) {
  const first = recs[0]
  return {
    at: new Date().toISOString(),
    cwd,
    path: first.path,
    batch: Number.isInteger(first.batch) ? first.batch : null,
    reason,
    records: recs.map((r) => ({
      callId: r.callId,
      toolName: r.toolName,
      path: r.path,
      create: r.create === true,
      callHunk: r.callHunk,
      hunks: r.hunks,
      decisions: r.decisions,
      note: r.note ?? null,
      before: typeof r.before === 'string' ? r.before : null,
      superseded: r.superseded === true,
      batch: Number.isInteger(r.batch) ? r.batch : null,
      at: r.at,
      summary: recSummary(r)
    }))
  }
}

function groupByBatch(recs) {
  const map = new Map()
  for (const r of recs) {
    const k = Number.isInteger(r.batch) ? r.batch : null
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(r)
  }
  return map
}

async function readArchiveText(ctx, cwd) {
  const fs = ctx.get('fs')
  if (!fs || !cwd) return null
  try {
    return await fs.readText(await fs.resolve(SIDECAR_ARCHIVE, { cwd }))
  } catch (error) {
    return null
  }
}

function parseArchive(text) {
  if (!text) return []
  try {
    const data = JSON.parse(text)
    if (data && typeof data === 'object' && Array.isArray(data.batches)) return data.batches
  } catch (error) { /* 忽略损坏 */ }
  return []
}

async function appendArchiveEntries(ctx, cwd, entries, session) {
  const fs = ctx.get('fs')
  if (!fs || !cwd) return
  try {
    const target = await fs.resolve(SIDECAR_ARCHIVE, { cwd })
    const existing = parseArchive(await readArchiveText(ctx, cwd))
    for (const e of entries) {
      const idx = existing.findIndex((x) => x.cwd === e.cwd && x.path === e.path && x.batch === e.batch)
      if (idx >= 0) {
        const exist = existing[idx]
        const seen = new Set((exist.records || []).map((r) => r.callId))
        for (const rec of e.records) {
          if (!seen.has(rec.callId)) { exist.records.push(rec); seen.add(rec.callId) }
        }
        existing[idx].lastAt = e.at
        existing[idx].reason = e.reason
      } else existing.push(e)
    }
    await fs.writeText(target, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), batches: existing }), void 0, void 0, policyOf(ctx, session))
  } catch (error) {
    console.error('edrv appendArchiveEntries failed', error)
  }
}

async function archiveRecords(ctx, session, cwd, bucket, recs, reason) {
  if (!recs.length) return
  const fresh = recs.filter((r) => !r.archived)
  for (const r of recs) r.archived = true
  const entries = []
  for (const list of groupByBatch(recs).values()) entries.push(archiveEntryFor(list, cwd, reason))
  await appendArchiveEntries(ctx, cwd, entries, session)
  if (fresh.length) await saveBucket(ctx, cwd, bucket, session)
}

async function restoreFile(ctx, session, rec) {
  const fs = ctx.get('fs')
  if (!fs) return '缺少 fs'
  if (rec.before === null || rec.before === undefined) {
    if (rec.create === true) {
      const out = await deleteCreated(ctx, session, rec)
      return out.ok ? null : out.error
    }
    return '缺少修改前内容（大文件或旧记录），无法回滚'
  }
  try {
    const target = await resolveTarget(ctx, session, rec.path)
    await fs.writeText(target, rec.before, void 0, void 0, policyOf(ctx, session))
    return null
  } catch (error) {
    return '回滚失败：' + String(error)
  }
}

function sessionOf(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions) return undefined
  if (sessionId) return sessions.get(sessionId)
  const live = sessions.list().filter((s) => s.id)
  return live.length === 1 ? live[0] : undefined
}

function cwdOf(session) {
  return session?.header?.cwd ?? null
}

function bucketOf(registry, ctx, cwd) {
  const existing = registry.get(cwd)
  if (existing) return Promise.resolve(existing)
  return loadBucket(ctx, cwd).then((map) => { registry.set(cwd, map); return map })
}

export function apply(ctx, config) {
  const registry = new Map()
  const imgDir = imageDirOf(config)

  ctx.on('tools/result', async (exec, result) => {
    const session = exec?.agent?.session
    if (!session || (exec?.name !== 'edit' && exec?.name !== 'write')) return
    if (result?.isError || !result?.value) return
    try {
      const cwd = cwdOf(session)
      if (!cwd) return
      const value = result.value
      const args = exec.arguments || {}
      const path = typeof value.path === 'string' ? value.path : args.file_path
      if (!path) return
      const metaDiffs = Array.isArray(result.meta?.diffs) ? result.meta.diffs : []
      const before = typeof value.before === 'string' ? value.before : null
      const create = exec.name === 'write' && value.before === null
      const callHunk = exec.name === 'edit' && typeof args.old_string === 'string' ? { oldText: args.old_string, newText: args.new_string } : null
      const synthHunk = create ? { oldText: null, newText: typeof args.content === 'string' ? args.content : (typeof value.after === 'string' ? value.after : '') } : null
      const hunks = metaDiffs.length ? metaDiffs : (synthHunk ? [synthHunk] : (callHunk ? [callHunk] : []))
      if (!hunks.length) return
      const record = {
        callId: exec.callId,
        toolName: exec.name,
        path,
        before,
        create,
        callHunk,
        hunks,
        decisions: { call: 'pending', perHunk: hunks.map(() => 'pending') },
        note: create ? '新建文件：全部拒绝将删除该文件' : before === null ? '未捕获修改前内容（大文件）' : null,
        superseded: false,
        batch: 0,
        at: new Date().toISOString()
      }
      let bucket = registry.get(cwd)
      if (!bucket) { bucket = await loadBucket(ctx, cwd); registry.set(cwd, bucket) }
      record.batch = fileMaxBatch(bucket, path) + 1
      bucket.set(exec.callId, record)
      // 融合：文件被再次修改（batch 递增）时，早于最新批次的未归档差异一律归档（内容已含其效果/被取代）
      const prior = []
      for (const r of bucket.values()) {
        if (r.path === path && r.callId !== exec.callId && !r.archived && (r.batch ?? 0) < record.batch) prior.push(r)
      }
      if (prior.length) {
        await archiveRecords(ctx, session, cwd, bucket, prior, prior.every(recordResolved) ? '已处理且被后续修改取代' : '被后续修改融合（内容已含其效果）')
      }
      prune(bucket)
      await saveBucket(ctx, cwd, bucket, session)
    } catch (error) {
      console.error('edrv capture failed', error)
    }
  })

  ctx.on('session/disposed', (session) => {
    const cwd = cwdOf(session)
    if (cwd) {
      registry.delete(cwd)
      fileIndex.delete(cwd)
    }
  })

  async function handleRpc(method, args) {
    switch (method) {
      case 'edrv.list': {
        const session = sessionOf(ctx, args?.sessionId)
        if (!session) return { ok: false, error: '会话不存在' }
        const cwd = cwdOf(session)
        if (!cwd) return { ok: false, error: '会话无工作区' }
        const bucket = await bucketOf(registry, ctx, cwd)
        const want = Array.isArray(args?.callIds) ? new Set(args.callIds) : null
        if (!want) await autoArchiveStale(ctx, session, cwd, bucket) // 全量轮询时自动清理 stale 幽灵差异
        const out = []
        for (const rec of bucket.values()) {
          // 面板全量查询过滤已归档；聊天条按 callId 查询保留（状态徽章仍需正确显示）
          if (!want && rec.archived) continue
          if (want && !want.has(rec.callId)) continue
          out.push(recView(rec))
        }
        out.sort((a, b) => (a.at < b.at ? -1 : 1))
        return { ok: true, records: out }
      }
      case 'edrv.accept': {
        const session = sessionOf(ctx, args?.sessionId)
        if (!session) return { ok: false, error: '会话不存在' }
        const cwd = cwdOf(session)
        if (!cwd) return { ok: false, error: '会话无工作区' }
        const bucket = await bucketOf(registry, ctx, cwd)
        const record = bucket.get(args?.callId)
        if (!record) return { ok: false, error: '记录不存在' }
        markDecision(record, args?.scope ?? 'call', args?.hunkIndex, 'accepted')
        if (recordResolved(record)) await archiveRecords(ctx, session, cwd, bucket, [record], '已处理')
        else await saveBucket(ctx, cwd, bucket, session)
        return { ok: true, record: recView(record) }
      }
      case 'edrv.reject': {
        const session = sessionOf(ctx, args?.sessionId)
        if (!session) return { ok: false, error: '会话不存在' }
        const cwd = cwdOf(session)
        if (!cwd) return { ok: false, error: '会话无工作区' }
        const bucket = await bucketOf(registry, ctx, cwd)
        const record = bucket.get(args?.callId)
        if (!record) return { ok: false, error: '记录不存在' }
        const scope = args?.scope ?? 'call'
        const outcome = scope === 'hunk' ? await revertHunk(ctx, session, record, args?.hunkIndex) : await revertCall(ctx, session, record)
        if (!outcome.ok) return { ok: false, error: outcome.error }
        record.decisions = markDecision(record, scope, args?.hunkIndex, 'rejected').decisions
        record.at = new Date().toISOString()
        if (recordResolved(record)) await archiveRecords(ctx, session, cwd, bucket, [record], '已处理（回滚）')
        else await saveBucket(ctx, cwd, bucket, session)
        return { ok: true, record: recView(record) }
      }
      case 'edrv.read': {
        const session = sessionOf(ctx, args?.sessionId)
        if (!session) return { ok: false, error: '会话不存在' }
        const fs = ctx.get('fs')
        if (!fs) return { ok: false, error: '缺少 fs' }
        const path = args?.path
        if (typeof path !== 'string' || !path) return { ok: false, error: '缺少路径' }
        try {
          const target = await resolveTarget(ctx, session, path)
          const info = await fs.stat(target)
          if (!info || info.type !== 'file') return { ok: false, error: '文件不存在' }
          if ((info.size ?? 0) > READ_CAP) return { ok: false, error: '文件过大（>8MB），不支持整文件预览' }
          const content = await fs.readText(target)
          return { ok: true, content, size: content.length }
        } catch (error) {
          return { ok: false, error: '读取失败：' + String(error) }
        }
      }
      case 'edrv.original': {
        // 重建"本批次修改前"内容：DiffEditor 原始侧。仅反解 pending 块；
        // 全部反解失败时回退到最早记录的整体 before（若存在）。
        const session = sessionOf(ctx, args?.sessionId)
        if (!session) return { ok: false, error: '会话不存在' }
        const cwd = cwdOf(session)
        if (!cwd) return { ok: false, error: '会话无工作区' }
        const fs = ctx.get('fs')
        if (!fs) return { ok: false, error: '缺少 fs' }
        const path = args?.path
        if (typeof path !== 'string' || !path) return { ok: false, error: '缺少路径' }
        try {
          const target = await resolveTarget(ctx, session, path)
          const info = await fs.stat(target)
          if (!info || info.type !== 'file') return { ok: false, error: '文件不存在' }
          if ((info.size ?? 0) > READ_CAP) return { ok: false, error: '文件过大（>8MB），不支持差异重建' }
          const content = await fs.readText(target)
          const bucket = await bucketOf(registry, ctx, cwd)
          const records = [...bucket.values()].filter((r) => r.path === path && !r.archived).sort((a, b) => (a.at < b.at ? -1 : 1))
          if (!records.length) return { ok: true, content, size: content.length, stale: [] }
          const rebuilt = reconstructOriginal(records, content)
          if (rebuilt.stale.length && records[0].before !== null) {
            return { ok: true, content: records[0].before, size: records[0].before.length, stale: rebuilt.stale, fallback: true }
          }
          return { ok: true, content: rebuilt.content, size: rebuilt.content.length, stale: rebuilt.stale, fallback: false }
        } catch (error) {
          return { ok: false, error: '重建失败：' + String(error) }
        }
      }
      case 'edrv.save': {
        const session = sessionOf(ctx, args?.sessionId)
        if (!session) return { ok: false, error: '会话不存在' }
        const fs = ctx.get('fs')
        if (!fs) return { ok: false, error: '缺少 fs' }
        const path = args?.path
        const content = args?.content
        if (typeof path !== 'string' || !path || typeof content !== 'string') return { ok: false, error: '参数不合法' }
        try {
          const target = await resolveTarget(ctx, session, path)
          await fs.writeText(target, content, void 0, void 0, policyOf(ctx, session))
          const cwd = cwdOf(session)
          if (cwd) {
            const bucket = await bucketOf(registry, ctx, cwd)
            let changed = false
            for (const rec of bucket.values()) {
              if (rec.path === path && rec.superseded !== true) { rec.superseded = true; rec.at = new Date().toISOString(); changed = true }
            }
            if (changed) {
              const done = []
              for (const rec of bucket.values()) if (rec.path === path && rec.superseded) done.push(rec)
              if (done.length) await archiveRecords(ctx, session, cwd, bucket, done, '被手动编辑覆盖')
              else await saveBucket(ctx, cwd, bucket, session)
            }
          }
          return { ok: true }
        } catch (error) {
          return { ok: false, error: '保存失败：' + String(error) }
        }
      }
      case 'edrv.archiveList': {
        const session = sessionOf(ctx, args?.sessionId)
        if (!session) return { ok: false, error: '会话不存在' }
        const cwd = cwdOf(session)
        if (!cwd) return { ok: false, error: '会话无工作区' }
        const batches = parseArchive(await readArchiveText(ctx, cwd)).filter((b) => b.cwd === cwd)
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
      }
      case 'edrv.archiveRead': {
        const session = sessionOf(ctx, args?.sessionId)
        if (!session) return { ok: false, error: '会话不存在' }
        const cwd = cwdOf(session)
        if (!cwd) return { ok: false, error: '会话无工作区' }
        const batchPath = args?.path
        const batches = parseArchive(await readArchiveText(ctx, cwd)).filter((b) => b.cwd === cwd && (!batchPath || b.path === batchPath))
        return { ok: true, batches }
      }
      case 'edrv.rollback': {
        const session = sessionOf(ctx, args?.sessionId)
        if (!session) return { ok: false, error: '会话不存在' }
        const cwd = cwdOf(session)
        if (!cwd) return { ok: false, error: '会话无工作区' }
        const path = args?.path
        if (typeof path !== 'string' || !path) return { ok: false, error: '缺少路径' }
        const fs = ctx.get('fs')
        if (!fs) return { ok: false, error: '缺少 fs' }
        const batch = args?.batch
        const bucket = await bucketOf(registry, ctx, cwd)
        let affected = []
        let beforeRec = null
        if (batch !== undefined) {
          const all = parseArchive(await readArchiveText(ctx, cwd)).filter((b) => b.cwd === cwd && b.path === path)
          const recs = []
          for (const b of all) if (b.batch === batch) for (const r of (b.records || [])) recs.push(r)
          if (!recs.length) return { ok: false, error: '归档中找不到该批次' }
          recs.sort((a, b2) => (a.at < b2.at ? -1 : 1))
          beforeRec = recs[0]
          affected = recs
        } else {
          for (const r of bucket.values()) if (r.path === path && !r.archived) affected.push(r)
          if (!affected.length) return { ok: false, error: '该文件没有可回滚的差异' }
          affected.sort((a, b2) => (a.at < b2.at ? -1 : 1))
          beforeRec = affected[0]
        }
        const rerr = await restoreFile(ctx, session, beforeRec)
        if (rerr) return { ok: false, error: rerr }
        if (batch === undefined) {
          await archiveRecords(ctx, session, cwd, bucket, affected, '已回滚')
        } else {
          const all = parseArchive(await readArchiveText(ctx, cwd)).filter((b) => b.cwd === cwd && b.path === path && b.batch === batch)
          const sumRecs = all.reduce((s, b) => s + ((b.records || []).length), 0)
          const logRec = Object.assign({}, affected[0], { note: (affected[0].note ? affected[0].note + '；' : '') + '回滚至本批次前（批次 ' + batch + '）' })
          await appendArchiveEntries(ctx, cwd, [archiveEntryFor([logRec], cwd, '已回滚（批次 ' + batch + '，' + sumRecs + ' 条）')], session)
          // 批次回滚恢复的是旧内容，文件当前活跃差异已失效，一并归档
          const activeRecs = []
          for (const r of bucket.values()) if (r.path === path && !r.archived) activeRecs.push(r)
          if (activeRecs.length) await archiveRecords(ctx, session, cwd, bucket, activeRecs, '已回滚（批次回滚覆盖）')
        }
        return { ok: true, path, batch: batch ?? null }
      }
      case 'edrv.debug': {
        // 诊断日志：client 上报 → 写入工作区旁车 .dsh-edit-review-debug.log（console 不一定落盘，文件可靠）
        // 并发上报时 fs read+write 非原子会丢行，这里按 cwd 串行化追加。
        const text = String(args?.text ?? '')
        const session = sessionOf(ctx, args?.sessionId)
        const cwd = cwdOf(session)
        const fs = ctx.get('fs')
        if (fs && cwd) {
          const prev = debugWriteQueues.get(cwd) || Promise.resolve()
          const task = prev.then(async () => {
            try {
              const target = await fs.resolve('.dsh-edit-review-debug.log', { cwd })
              const old = await fs.readText(target).catch(() => '')
              const line = new Date().toISOString() + ' ' + text + '\n'
              await fs.writeText(target, (old || '') + line, void 0, void 0, policyOf(ctx, session))
            } catch (e) { /* 写日志失败忽略 */ }
          })
          debugWriteQueues.set(cwd, task)
          await task
        }
        console.error('[edrv-debug] ' + text)
        return { ok: true }
      }
      case 'edrv.searchFiles': {
        const session = sessionOf(ctx, args?.sessionId)
        if (!session) return { ok: false, error: '会话不存在' }
        const cwd = cwdOf(session)
        if (!cwd) return { ok: false, error: '会话无工作区' }
        const query = String(args?.query ?? '').trim().toLowerCase()
        const files = []
        if (query.length >= 2) {
          const bucket = await bucketOf(registry, ctx, cwd)
          const pool = new Set()
          // 活跃差异路径恒并入（保证差异文件一定可搜到，即使工作区扫描不可用）
          for (const rec of bucket.values()) if (rec.path) pool.add(rec.path)
          const listed = await listWorkspaceFiles(ctx, session, cwd)
          if (listed) for (const f of listed) pool.add(f)
          const score = (p) => {
            const pl = p.toLowerCase()
            const base = pl.split(/[\\/]/).pop() || ''
            if (base.includes(query)) return 0
            if (pl.includes(query)) return 1
            return -1
          }
          const hit = [...pool].filter((p) => score(p) >= 0)
          hit.sort((a, b) => (score(a) - score(b)) || (a < b ? -1 : 1))
          files.push(...hit.slice(0, 50))
        }
        return { ok: true, files, truncated: files.length >= 50 }
      }
      default:
        return { ok: false, error: '未知方法: ' + String(method) }
    }
  }

  const web = ctx.get('webServer')
  if (web) {
    ctx.effect(() => web.register({
      kind: 'exact',
      path: '/edrv/rpc',
      handler: async (req, res) => {
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          let input = {}
          try {
            input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          } catch (error) {
            input = {}
          }
          const result = await handleRpc(input.method, input.args)
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(result))
        } catch (error) {
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, error: String(error) }))
        }
      }
    }), 'edrv: /edrv/rpc route')
  }

  if (web) {
    for (const r of IMG_ROUTES) {
      ctx.effect(() => web.register({
        kind: 'exact',
        path: r.url,
        handler: async (req, res) => {
          try {
            const body = await readFile(imgDir + '/' + r.file)
            res.statusCode = 200
            res.setHeader('content-type', 'image/png')
            res.setHeader('cache-control', 'no-cache')
            res.end(body)
          } catch (error) {
            res.statusCode = 404
            res.end()
          }
        }
      }), 'edrv: static ' + r.file)
    }
  }

  // Monaco Editor AMD 构建：/edrv/vendor/* → assets/vendor/*（路径穿越防护 + 按扩展名 MIME）
  const vendorDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'vendor')
  if (web) {
    ctx.effect(() => web.register({
      kind: 'prefix',
      path: VENDOR_PREFIX,
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.statusCode = 405
            res.end()
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://x').pathname
          const rel = decodeURIComponent(pathname.slice(VENDOR_PREFIX.length)).replace(/^\/+/, '')
          if (!rel) { res.statusCode = 404; res.end(); return }
          const target = resolve(normalize(join(vendorDir, rel)))
          if (target !== vendorDir && !target.startsWith(vendorDir + sep)) {
            res.statusCode = 403
            res.end()
            return
          }
          const body = await readFile(target)
          res.statusCode = 200
          res.setHeader('content-type', VENDOR_MIME[extname(target)] ?? 'application/octet-stream')
          res.setHeader('cache-control', 'public, max-age=3600')
          res.end(body)
        } catch (error) {
          res.statusCode = 404
          res.end()
        }
      }
    }), 'edrv: /edrv/vendor prefix')
  }

  ctx.logger?.info?.('[' + name + '] 编辑差异审查已装配（/edrv/rpc 路由就绪）')
}
