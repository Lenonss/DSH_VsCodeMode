/**
 * dsh-vscode-mode host — 工作区目录树索引（.sln 式结构缓存，层 2）。
 * 内存 Map<cwd, 索引> + 落盘缓存文件（工作区级：
 * ~/.dsh/dsh-vscode-mode/cache/workspace/<cwdHash>/tree.v<schema>.json，路径统一走
 * paths.ts PathConst）：命中（ts 新鲜且未失效）内存直出 0 IO；列取结果 putIndex 更新
 * 并防抖落盘；agent 写入/手动保存 invalidateIndex 父目录+祖先 → 3s 防抖后台 re-heal
 * （并行、单轮有界、合并并发轮）；TTL 兜底外部改动。缓存写读走原生 node:fs（与引擎
 * settings-file 一致，不占用工作区；沙箱只约束 ctx fs）。文件只存 {name,type}（path 由
 * 目录 rel 还原），落盘上限 400 目录/1500 条目/8MB 硬跳过——只是暖启动快照，正确性
 * 不依赖它。首次使用某 cwd 时清理旧工作区树 sidecar
 * （.dsh-edit-review-tree.json/.dsh-vscode-mode-tree.json，缓存可重建，删除无损）。
 * 纯函数部分导出可单测。
 * 作者 ddj 2026-08-31 / 2026-09-01
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TreeEntry } from './shared/rpc.js'
import type { Ctx } from './store.js'
import { toTreeEntries } from './tree.js'
import { DirListError, listDirCheap } from './treeRead.js'
import { LEGACY_TREE_SIDECARS, treeCacheFile } from './paths.js'

// --region 常量
/** 命中新鲜度：超过则视为过期，按需重列。 */
export const TREE_TTL_MS = 60_000
/** 内存目录上限：超出按 ts 逐出最旧（常驻目录命中保活，不会误逐）。 */
export const MEM_MAX_DIRS = 2000
/** 落盘目录上限（按 ts 裁旧）。 */
export const PERSIST_MAX_DIRS = 400
/** 落盘单目录条目上限：超出截断并标 full=false（截断仍可即时渲染，客户端后台刷新补全）。 */
export const PERSIST_DIR_ENTRIES = 1500
/** 落盘序列化硬上限：超出跳过落盘（内存索引照常工作）。 */
export const PERSIST_MAX_BYTES = 8 * 1024 * 1024
/** 落盘防抖：变更后静默 10s 再写一次。 */
export const PERSIST_DEBOUNCE_MS = 10_000
/** re-heal 防抖：写入密集期合并为 3s 后一轮。 */
export const HEAL_DEBOUNCE_MS = 3000
/** re-heal 单轮目录数上限（并行，防 IO 风暴）。 */
export const HEAL_ROUND_MAX = 20
// --endregion

/** 索引条目（文件瘦身格式：不含 path，加载时由目录 rel 还原）。 */
export interface TreeIndexEntry {
  name: string
  type: 'file' | 'directory' | 'other'
}

/** 单个目录的索引（ts=最近确认时间；full=false 表示条目被落盘截断过）。 */
export interface TreeIndexDir {
  ts: number
  full: boolean
  entries: TreeEntry[]
}

/** 索引数据（内存全量；落盘前经 trimPersist 裁剪）。 */
export interface TreeIndexData {
  v: 1
  root: string | null
  dirs: Record<string, TreeIndexDir>
}

/** 每 cwd 的索引运行时状态。 */
interface IndexState {
  ctx: Ctx
  cwd: string
  data: TreeIndexData
  stale: Set<string>
  dirty: boolean
  persistTimer: ReturnType<typeof setTimeout> | null
  healTimer: ReturnType<typeof setTimeout> | null
  pending: Map<string, Promise<{ entries: TreeEntry[] } | { error: string }>>
  loading: boolean
  loadPromise: Promise<void> | null
}

/** cwd → 索引状态（随会话销毁清理）。 */
const states = new Map<string, IndexState>()
/** 单调时钟：连续 put 的 ts 严格递增（同毫秒不并列，逐出/裁剪顺序可预期）。 */
let clock = 0

/** 取下一时间戳（不小于真实时间且严格递增）。 */
function nextTs(): number {
  clock = Math.max(Date.now(), clock + 1)
  return clock
}

// --region 纯函数（可单测）
/** 条目原始值 → 合法条目（非法返回 null）。 */
export function entryOf(raw: unknown): TreeIndexEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as { name?: unknown; type?: unknown }
  if (typeof e.name !== 'string' || !e.name) return null
  const type = e.type === 'directory' ? 'directory' : e.type === 'file' ? 'file' : 'other'
  return { name: e.name, type }
}

/** 写入路径 → 相对工作区根的 rel（绝对路径按 cwd 前缀裁剪；越界/非法 → null）。 */
export function relOf(cwd: string, path: string): string | null {
  let rel = String(path ?? '').trim().replace(/\\/g, '/')
  const c = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const cl = c.toLowerCase()
  const pl = rel.toLowerCase()
  if (pl.startsWith(cl + '/')) rel = rel.slice(cl.length + 1)
  else if (rel.startsWith('/') || /^[a-z]:\//i.test(rel)) return null
  rel = rel.replace(/^\/+|\/+$/g, '')
  if (!rel) return null
  const segs = rel.split('/').filter((s) => s !== '' && s !== '.')
  if (!segs.length) return null
  for (const s of segs) {
    if (s === '..') return null
  }
  return segs.join('/')
}

/** rel 的父目录 + 全部祖先（'a/b/c' → ['a/b','a','']；'a' → ['']）。 */
export function ancestorsOf(rel: string): string[] {
  const segs = rel.split('/')
  const out: string[] = []
  for (let i = segs.length - 1; i >= 1; i--) out.push(segs.slice(0, i).join('/'))
  out.push('')
  return out
}

/** 序列化索引数据。 */
export function indexSerialize(data: TreeIndexData): string {
  const lean: { v: 1; root: string | null; dirs: Record<string, { ts: number; full: boolean; entries: TreeIndexEntry[] }> } = { v: 1, root: data.root, dirs: {} }
  for (const [rel, dir] of Object.entries(data.dirs)) {
    lean.dirs[rel] = { ts: dir.ts, full: dir.full, entries: dir.entries.map((e) => ({ name: e.name, type: e.type })) }
  }
  return JSON.stringify(lean)
}

/** 解析索引文本；损坏/格式不符 → null。 */
export function indexParse(text: string | null): TreeIndexData | null {
  if (!text) return null
  try {
    const raw = JSON.parse(text) as { v?: unknown; root?: unknown; dirs?: unknown }
    if (!raw || raw.v !== 1 || !raw.dirs || typeof raw.dirs !== 'object') return null
    const dirs: Record<string, TreeIndexDir> = {}
    for (const [rel, d] of Object.entries(raw.dirs)) {
      if (!d || typeof d !== 'object') continue
      const dir = d as { ts?: unknown; full?: unknown; entries?: unknown }
      if (!Array.isArray(dir.entries)) continue
      const entries: TreeEntry[] = []
      for (const rawEntry of dir.entries) {
        const e = entryOf(rawEntry)
        if (!e) continue
        entries.push({ name: e.name, path: rel ? rel + '/' + e.name : e.name, type: e.type })
      }
      if (!entries.length) continue
      dirs[rel] = { ts: typeof dir.ts === 'number' ? dir.ts : 0, full: dir.full === true, entries }
    }
    return { v: 1, root: typeof raw.root === 'string' ? raw.root : null, dirs }
  } catch (error) {
    return null
  }
}

/** 落盘裁剪：目录按 ts 取新裁旧、单目录超限截断标 full=false（内存不受影响）。 */
export function trimPersist(data: TreeIndexData, maxDirs = PERSIST_MAX_DIRS, maxEntries = PERSIST_DIR_ENTRIES): TreeIndexData {
  const dirs: Record<string, TreeIndexDir> = {}
  const sorted = Object.entries(data.dirs).sort((a, b) => b[1].ts - a[1].ts)
  for (const [rel, dir] of sorted) {
    if (Object.keys(dirs).length >= maxDirs) break
    const full = dir.entries.length <= maxEntries
    dirs[rel] = { ts: dir.ts, full, entries: full ? dir.entries : dir.entries.slice(0, maxEntries) }
  }
  return { v: 1, root: data.root, dirs }
}
// --endregion

// --region 状态机
/** 取（或建）某 cwd 的索引状态，并惰性加载落盘快照（合并：文件 ts 更新才采纳）。 */
function ensureState(ctx: Ctx, cwd: string): IndexState {
  const existing = states.get(cwd)
  if (existing) return existing
  const state: IndexState = {
    ctx,
    cwd,
    data: { v: 1, root: null, dirs: {} },
    stale: new Set(),
    dirty: false,
    persistTimer: null,
    healTimer: null,
    pending: new Map(),
    loading: false,
    loadPromise: null,
  }
  states.set(cwd, state)
  state.loadPromise = loadIndex(state)
  // 首次使用该工作区：清理旧版本在工作区根留下的树缓存 sidecar（缓存可重建，删除无损）
  void removeLegacyTreeSidecars(state.cwd)
  return state
}

/** 清理旧工作区树 sidecar（.dsh-edit-review-tree.json/.dsh-vscode-mode-tree.json）。 */
export async function removeLegacyTreeSidecars(cwd: string): Promise<void> {
  await Promise.all(LEGACY_TREE_SIDECARS.map(async (name) => {
    try {
      await rm(join(cwd, name), { force: true })
    } catch (error) { /* 删除失败静默 */ }
  }))
}

/** 惰性加载落盘快照一次（缺失/损坏 → 空索引；失败静默）。 */
async function loadIndex(state: IndexState): Promise<void> {
  if (state.loading) return
  state.loading = true
  try {
    const parsed = indexParse(await readFile(treeCacheFile(state.cwd), 'utf8'))
    if (!parsed) return
    for (const [rel, dir] of Object.entries(parsed.dirs)) {
      const cur = state.data.dirs[rel]
      if (!cur || dir.ts > cur.ts) state.data.dirs[rel] = dir
    }
    if (parsed.root && !state.data.root) state.data.root = parsed.root
  } catch (error) { /* 缺失/损坏/失败均按空索引 */ }
  finally {
    state.loading = false
  }
}

/** 命中：新鲜且未失效 → 条目（并刷新 ts 保活）；否则 null。 */
export function hitIndex(cwd: string, rel: string): TreeEntry[] | null {
  const state = states.get(cwd)
  if (!state) return null
  const dir = state.data.dirs[rel]
  if (!dir || state.stale.has(rel)) return null
  const now = Date.now()
  if (now - dir.ts > TREE_TTL_MS) return null
  dir.ts = now
  return dir.entries
}

/** 更新某目录条目：写内存 + 打脏 + 防抖落盘；stale 撤销。 */
export function putIndex(ctx: Ctx, cwd: string, rel: string, entries: TreeEntry[]): void {
  const state = ensureState(ctx, cwd)
  const dirs = state.data.dirs
  if (!dirs[rel] && Object.keys(dirs).length >= MEM_MAX_DIRS) {
    let oldest = rel
    let oldestTs = Infinity
    for (const [k, v] of Object.entries(dirs)) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts
        oldest = k
      }
    }
    delete dirs[oldest]
  }
  dirs[rel] = { ts: nextTs(), full: entries.length <= PERSIST_DIR_ENTRIES, entries }
  state.stale.delete(rel)
  state.dirty = true
  schedulePersist(state)
}

/** 写入路径失效：父目录+祖先进 stale，并调度后台 re-heal。 */
export function invalidateIndex(ctx: Ctx, cwd: string, path: string): void {
  const rel = relOf(cwd, path)
  if (rel === null) return
  const state = ensureState(ctx, cwd)
  for (const anc of ancestorsOf(rel)) state.stale.add(anc)
  scheduleHeal(state)
}

/** 调度 re-heal（防抖合并；已有定时器则复用）。 */
function scheduleHeal(state: IndexState): void {
  if (state.healTimer) return
  state.healTimer = setTimeout(() => {
    state.healTimer = null
    void healRound(state)
  }, HEAL_DEBOUNCE_MS)
}

/** 后台自愈一轮：并行重列 ≤HEAL_ROUND_MAX 个 stale 目录；失败移出（交给 TTL/展开路径自愈）。 */
async function healRound(state: IndexState): Promise<void> {
  if (!state.stale.size) return
  const targets = [...state.stale].slice(0, HEAL_ROUND_MAX)
  await Promise.all(targets.map(async (rel) => {
    const res = await listDirCached(state.ctx, state.cwd, rel, true)
    if ('error' in res) state.stale.delete(rel)
  }))
  if (state.stale.size) scheduleHeal(state)
}

/** 调度落盘（防抖；已有定时器则重置）。 */
function schedulePersist(state: IndexState): void {
  if (state.persistTimer) clearTimeout(state.persistTimer)
  state.persistTimer = setTimeout(() => {
    state.persistTimer = null
    void persistNow(state)
  }, PERSIST_DEBOUNCE_MS)
}

/** 落盘快照（裁剪 + 序列化 + 超限跳过；raw fs 写 ~/.dsh 缓存根，失败静默）。 */
async function persistNow(state: IndexState): Promise<void> {
  if (!state.dirty) return
  try {
    const json = indexSerialize(trimPersist(state.data))
    if (json.length > PERSIST_MAX_BYTES) {
      state.dirty = false
      return
    }
    await mkdir(dirname(treeCacheFile(state.cwd)), { recursive: true })
    await writeFile(treeCacheFile(state.cwd), json, 'utf8')
    state.dirty = false
  } catch (error) { /* 写缓存失败静默：内存索引不受影响 */ }
}

/** 清理某 cwd 索引（会话销毁时）：清定时器，dirty 则尽力补写一次。 */
export function disposeIndex(cwd: string): void {
  const state = states.get(cwd)
  if (!state) return
  if (state.persistTimer) {
    clearTimeout(state.persistTimer)
    state.persistTimer = null
  }
  if (state.healTimer) {
    clearTimeout(state.healTimer)
    state.healTimer = null
  }
  if (state.dirty) void persistNow(state)
  states.delete(cwd)
}
// --endregion

/** 错误 → 用户文案（DirListError 用自身 message，其余带上下文）。 */
function errorText(error: unknown): string {
  if (error instanceof DirListError) return error.message
  return '读取目录失败：' + String(error)
}

/**
 * 目录列取统一入口（RPC handler 用）：命中索引直出；失效/force 走快路径
 * （resolve + listDirCheap + putIndex）；同 (cwd,rel) 在途请求复用同一 Promise。
 * @author ddj 2026年08月31号 / 2026年09月01号
 * @param ctx DSH 上下文（仅用于工作区 IO）
 * @param cwd 工作区根
 * @param rel 归一化相对路径（'' = 根）
 * @param force 跳过索引命中，强制实列
 * @returns 目录条目与工作区根，或错误文案
 */
export async function listDirCached(
  ctx: Ctx,
  cwd: string,
  rel: string,
  force: boolean,
): Promise<{ entries: TreeEntry[]; root: string } | { error: string }> {
  const state = ensureState(ctx, cwd)
  // 首次请求等待落盘快照加载完成（此后命中快照；加载失败则照常实列）
  if (state.loadPromise) await state.loadPromise
  const fs = ctx.get('fs')
  if (!fs) return { error: '缺少 fs' }
  if (!state.data.root) {
    try {
      state.data.root = String(fs.processPath(await fs.resolve('.', { cwd })))
    } catch (error) {
      return { error: errorText(error) }
    }
  }
  const root = state.data.root as string
  if (!force) {
    const hit = hitIndex(cwd, rel)
    if (hit) return { entries: hit, root }
  }
  const inflight = state.pending.get(rel)
  if (inflight) {
    const res = await inflight
    return 'entries' in res ? { entries: res.entries, root } : res
  }
  const task = (async (): Promise<{ entries: TreeEntry[] } | { error: string }> => {
    try {
      const target = await fs.resolve(rel || '.', { cwd })
      const children = await listDirCheap(target.targetKey)
      const entries = toTreeEntries(rel, children)
      putIndex(ctx, cwd, rel, entries)
      return { entries }
    } catch (error) {
      // 目录已被外部删除：从索引移除，避免陈旧条目长期滞留
      if (error instanceof DirListError && error.code === 'not-found') {
        if (state.data.dirs[rel]) {
          delete state.data.dirs[rel]
          state.dirty = true
          schedulePersist(state)
        }
        state.stale.delete(rel)
      }
      return { error: errorText(error) }
    }
  })()
  state.pending.set(rel, task)
  try {
    const res = await task
    return 'entries' in res ? { entries: res.entries, root } : res
  } finally {
    if (state.pending.get(rel) === task) state.pending.delete(rel)
  }
}
