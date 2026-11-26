/**
 * dsh-vscode-mode host — `/test-check` 的数据层：项目根发现、定义与事件读取、增量监听、快照导出。
 *
 * 契约（来自模式设计）：
 * - 数据在 `<项目根>/.dsh/test-check/<id>/`，不进版本库；快照导出到 `docs/acceptance-<id>.html`（进库）。
 * - 每条结果一个 JSON 文件，文件名 `<时间戳>-<随机>.json`，并发写不会互相覆盖。
 * - 目录用 `fs.watch` 标脏，读的时候按需重扫；watch 漏事件时 5 秒兜底重扫一次，
 *   客户端还有 1 秒轮询，所以「写文件后 1 秒内反映」不依赖 watch 是否可靠。
 * @author ddj 2026年11月25号
 */
import { createHash } from 'node:crypto'
import { existsSync, statSync, watch, type Dirent, type FSWatcher } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { log } from './log.js'
import {
  TEST_CHECK_BASE_DIR,
  TEST_CHECK_DEFAULT_ID,
  TEST_CHECK_DOCS,
  TEST_CHECK_ENV,
  TEST_CHECK_EVENTS,
  TEST_CHECK_ITEMS,
  TEST_CHECK_MAX_EVENTS,
  TEST_CHECK_SNIPPETS,
  checkDefinition,
  deriveSheetView,
  emptyView,
  eventFileNameOf,
  idProblemOf,
  isSheetId,
  normalizeStatus,
  snapshotNameOf,
  subjectHashLines,
  type TestCheckDefinition,
  type TestCheckEvent,
  type TestCheckEventFile,
  type TestCheckEvidence,
  type TestCheckIgnored,
  type TestCheckSheetSummary,
  type TestCheckView,
} from './shared/testCheck.js'
import { snippetsMarkdown } from './shared/testCheckSnippets.js'
import { renderSheetHtml } from './shared/testCheckHtml.js'

//region 结构面

/** 一个单子的路径集合（全部绝对路径）。 */
export interface SheetPaths {
  /** 项目根。 */
  root: string
  /** 数据根目录（`.dsh/test-check` 或环境变量覆盖值）。 */
  baseDir: string
  /** 单子目录。 */
  dir: string
  /** 定义文件。 */
  itemsPath: string
  /** 结果目录。 */
  eventsDir: string
  /** 上报片段文件。 */
  snippetsPath: string
}

/** 读视图的入参。 */
export interface ReadViewOptions {
  /** 会话工作区（扫项目根用）。 */
  cwd: string
  /** 单子 id；缺省按目录自动认领。 */
  id?: string
  /** 跳过缓存（导出、「马上重扫」用）。 */
  force?: boolean
}

/** 写一条结果的入参。 */
export interface WriteEventOptions {
  /** 会话工作区。 */
  cwd: string
  /** 单子 id。 */
  id: string
  /** 测试点 id。 */
  item: string
  /** 结果状态（已归一化）。 */
  status: 'pass' | 'fail' | 'blocked' | 'skip'
  /** 证据（缺省表示没证据）。 */
  evidence?: TestCheckEvidence
  /** 时间（缺省用当下）。 */
  at?: Date
  /** 被验对象指纹（`sha256:` 前缀）。 */
  hash?: string
}

/** 缓存里的一个事件文件。 */
interface EventCacheRow {
  mtimeMs: number
  size: number
  entry?: TestCheckEventFile
  reason?: string
}

/** 一个单子的缓存与监听状态。 */
interface SheetCache {
  /** 上次扫描产出的视图。 */
  view: TestCheckView | null
  /** 上次扫描时间（毫秒）。 */
  scannedAt: number
  /** watch 标过脏，下次读必须重扫。 */
  dirty: boolean
  /** 事件文件缓存：文件名 → 元数据。 */
  events: Map<string, EventCacheRow>
  /** 目录监听器：目录绝对路径 → 监听器（单子目录与 events 子目录各一个）。 */
  watchers: Map<string, FSWatcher>
}

/** 事件读取结果。 */
interface EventScan {
  events: TestCheckEventFile[]
  ignored: TestCheckIgnored[]
}

//endregion

//region 常量与缓存

/** watch 在位时的兜底重扫间隔（毫秒）：watch 标脏即时生效，TTL 只防漏事件。 */
const STORE_TTL_MS = 5_000

/** watch 挂不上时的重扫间隔：客户端每秒轮询，必须每秒真扫一次才满足「写文件 1 秒内反映」。 */
const POLL_TTL_MS = 1_000

/** 单子缓存：单子目录 → 缓存。 */
const sheets = new Map<string, SheetCache>()

/** 文件内容 sha256 缓存：绝对路径 → 指纹（按 mtime/size 失效）。 */
const fileHashes = new Map<string, { mtimeMs: number; size: number; sha: string }>()

/** 文件指纹缓存上限（超了整体清空，避免长跑实例无限涨）。 */
const FILE_HASH_MAX = 4_000

//endregion

//region 路径

/**
 * 算某段字节的 sha256（十六进制）。
 * @author ddj 2026年11月25号
 * @param data 字节或字符串
 * @returns 十六进制摘要
 */
function sha256Of(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 从会话 cwd 向上找项目根：第一个含 `.dsh/test-check` 的目录。
 * @author ddj 2026年11月25号
 * @param cwd 会话工作区
 * @returns 项目根绝对路径；都没找到时就是 cwd
 */
export function projectRootOf(cwd: string): string {
  const start = resolve(cwd)
  let dir = start
  for (;;) {
    if (existsSync(join(dir, TEST_CHECK_BASE_DIR))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

/**
 * 数据根目录：`DSH_TEST_CHECK_DIR` 覆盖优先，缺省 `<root>/.dsh/test-check`。
 * @author ddj 2026年11月25号
 * @param root 项目根
 * @param env 环境变量（测试可注入）
 * @returns 绝对路径
 */
export function baseDirOf(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[TEST_CHECK_ENV]
  const text = typeof override === 'string' ? override.trim() : ''
  return text ? resolve(text) : join(root, TEST_CHECK_BASE_DIR)
}

/**
 * 取一个单子的全部路径。
 * @author ddj 2026年11月25号
 * @param root 项目根
 * @param id 单子 id
 * @param env 环境变量
 * @returns 路径集合
 */
export function sheetPathsOf(root: string, id: string, env: NodeJS.ProcessEnv = process.env): SheetPaths {
  const baseDir = baseDirOf(root, env)
  const dir = join(baseDir, id)
  return {
    root,
    baseDir,
    dir,
    itemsPath: join(dir, TEST_CHECK_ITEMS),
    eventsDir: join(dir, TEST_CHECK_EVENTS),
    snippetsPath: join(dir, TEST_CHECK_SNIPPETS),
  }
}

/**
 * 认领单子 id：调用方给了合法 id 就用它；否则目录里只有一个单子时用它；再否则用默认 `check`。
 * @author ddj 2026年11月25号
 * @param baseDir 数据根目录
 * @param id 调用方给的 id
 * @returns 单子 id
 */
export async function pickSheetId(baseDir: string, id?: string): Promise<string> {
  if (isSheetId(id)) return String(id)
  try {
    const entries = await readdir(baseDir, { withFileTypes: true })
    const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name)
    if (dirs.length === 1) return dirs[0]
  } catch {
    /* 还没建过任何单子 */
  }
  return TEST_CHECK_DEFAULT_ID
}

/**
 * 校验单子 id（写盘前必过：id 会拼进路径，绝不能带分隔符或 `..`）。
 * @author ddj 2026年11月25号
 * @param id 调用方给的 id
 * @returns 合法的 id
 * @throws id 非法时抛错（文案可直接展示）
 */
function strictSheetId(id: unknown): string {
  if (!isSheetId(id)) throw new Error('单子 id 不合法（只允许小写字母、数字与连字符）：' + String(id))
  return String(id)
}

/**
 * 把绝对路径统一成 `/` 分隔（只用于展示与协议，fs 调用仍用原生路径）。
 * @author ddj 2026年11月25号
 * @param path 绝对路径
 * @returns `/` 分隔的路径
 */
export function slashPath(path: string): string {
  return path.replace(/\\/g, '/')
}

//endregion

//region 监听

/**
 * 给一个目录挂 watch：只负责标脏，不做解析。目录不存在时返回 null（下次读时再挂）。
 * @author ddj 2026年11月25号
 * @param paths 单子路径
 * @param cache 单子缓存
 * @param dir 要监听的目录
 * @returns 监听器或 null
 */
function watchDirOf(paths: SheetPaths, cache: SheetCache, dir: string): FSWatcher | null {
  if (!existsSync(dir)) return null
  try {
    const watcher = watch(dir, { persistent: false }, () => { cache.dirty = true })
    watcher.on('error', (error: unknown) => {
      log.warn('/test-check 监听失败（' + slashPath(dir) + '，改为轮询兜底）：'
        + (error instanceof Error ? error.message : String(error)))
      try { watcher.close() } catch { /* 已关闭 */ }
      cache.watchers.delete(dir)
    })
    return watcher
  } catch (error) {
    log.warn('/test-check 监听未挂上（' + slashPath(dir) + '，改为轮询兜底）：'
      + (error instanceof Error ? error.message : String(error)))
    return null
  }
}

/**
 * 挂齐两个监听：单子目录（items.json 改动）与 events 子目录（事件文件）。
 *
 * Windows 的 `fs.watch` 默认不递归，只盯单子目录收不到 `events/` 里新写的文件——
 * 真机实测那样首屏要等 5 秒兜底重扫，达不到「写文件 1 秒内反映」，所以必须分别挂。
 * @author ddj 2026年11月25号
 * @param paths 单子路径
 * @param cache 单子缓存
 * @returns 无
 */
function startWatch(paths: SheetPaths, cache: SheetCache): void {
  for (const dir of [paths.dir, paths.eventsDir]) {
    if (cache.watchers.has(dir)) continue
    const watcher = watchDirOf(paths, cache, dir)
    if (watcher) cache.watchers.set(dir, watcher)
  }
}

/**
 * 取（或建）单子缓存。
 * @author ddj 2026年11月25号
 * @param paths 单子路径
 * @returns 缓存项
 */
function cacheOf(paths: SheetPaths): SheetCache {
  const existing = sheets.get(paths.dir)
  if (existing) return existing
  const created: SheetCache = { view: null, scannedAt: 0, dirty: true, events: new Map(), watchers: new Map() }
  sheets.set(paths.dir, created)
  return created
}

//endregion

//region 读取定义与事件

/**
 * 读并校验定义文件。
 * @author ddj 2026年11月25号
 * @param paths 单子路径
 * @returns 状态、定义或逐条错误
 */
async function readDefinition(paths: SheetPaths): Promise<{ state: 'ready' | 'missing' | 'invalid'; definition?: TestCheckDefinition; error?: string }> {
  let text: string
  try {
    text = await readFile(paths.itemsPath, 'utf8')
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'ENOENT') return { state: 'missing' }
    return { state: 'invalid', error: '读取 items.json 失败：' + (error instanceof Error ? error.message : String(error)) }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    return { state: 'invalid', error: 'items.json 不是合法 JSON：' + (error instanceof Error ? error.message : String(error)) }
  }
  const checked = checkDefinition(raw, paths.dir.split(/[\\/]/).pop() ?? '')
  if (checked.errors.length) return { state: 'invalid', error: checked.errors.join('\n') }
  return { state: 'ready', definition: checked.definition }
}

/**
 * 校验一条事件的内容；不合法时返回原因。
 * @author ddj 2026年11月25号
 * @param raw 解析后的 JSON
 * @returns 事件或原因
 */
function eventOf(raw: unknown): { event: TestCheckEvent } | { reason: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { reason: '内容不是对象' }
  const row = raw as Record<string, unknown>
  const item = typeof row.item === 'string' ? row.item.trim() : ''
  if (!item) return { reason: '缺少 item' }
  const status = normalizeStatus(row.status)
  if (!status) return { reason: 'status 只能是 pass / fail / blocked / skip' }
  const problem = idProblemOf(item)
  if (problem) return { reason: 'item 不是合法测试点 id（' + problem + '）：' + item }
  const event: TestCheckEvent = { item, status }
  if (typeof row.at === 'string' && row.at.trim()) event.at = row.at.trim()
  const evidence = row.evidence
  if (evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence)) {
    const source = evidence as Record<string, unknown>
    const picked: TestCheckEvidence = {}
    if (typeof source.kind === 'string' && source.kind.trim()) picked.kind = source.kind.trim()
    if (typeof source.summary === 'string' && source.summary.trim()) picked.summary = source.summary.trim()
    if (typeof source.command === 'string' && source.command.trim()) picked.command = source.command.trim()
    if (typeof source.exitCode === 'number' && Number.isFinite(source.exitCode)) picked.exitCode = source.exitCode
    if (typeof source.path === 'string' && source.path.trim()) picked.path = source.path.trim()
    if (Object.keys(picked).length) event.evidence = picked
  }
  const subject = row.subject
  if (subject !== null && typeof subject === 'object') {
    const hash = (subject as Record<string, unknown>).hash
    if (typeof hash === 'string' && hash.trim()) event.subject = { hash: hash.trim() }
  }
  return { event }
}

/**
 * 扫一遍结果目录：只读新增/改过的文件，返回事件与被忽略的坏文件。
 * @author ddj 2026年11月25号
 * @param paths 单子路径
 * @param ids 合法测试点 id 集合
 * @param cache 单子缓存
 * @returns 事件与被忽略清单
 */
async function readEvents(paths: SheetPaths, ids: Set<string>, cache: SheetCache): Promise<EventScan> {
  const scan: EventScan = { events: [], ignored: [] }
  let names: string[]
  try {
    names = (await readdir(paths.eventsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return scan
  }
  names.sort((left, right) => (left < right ? 1 : left > right ? -1 : 0))
  const keep = new Set(names.slice(0, TEST_CHECK_MAX_EVENTS))
  for (const name of [...cache.events.keys()]) if (!keep.has(name)) cache.events.delete(name)

  for (const name of names.slice(0, TEST_CHECK_MAX_EVENTS)) {
    const absolute = join(paths.eventsDir, name)
    let info: { mtimeMs: number; size: number }
    try {
      const row = await stat(absolute)
      info = { mtimeMs: row.mtimeMs, size: row.size }
    } catch {
      cache.events.delete(name)
      continue
    }
    let cached = cache.events.get(name)
    if (!cached || cached.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
      cached = { ...info }
      try {
        const parsed = eventOf(JSON.parse((await readFile(absolute, 'utf8')).replace(/^\uFEFF/, '')))
        if ('reason' in parsed) cached.reason = parsed.reason
        else if (!ids.has(parsed.event.item)) cached.reason = '未知测试点：' + parsed.event.item
        else {
          const at = typeof parsed.event.at === 'string' ? Date.parse(parsed.event.at) : Number.NaN
          cached.entry = {
            file: name,
            at: Number.isFinite(at) ? at : info.mtimeMs,
            event: parsed.event,
          }
        }
      } catch (error) {
        cached.reason = '不是合法 JSON：' + (error instanceof Error ? error.message : String(error))
      }
      cache.events.set(name, cached)
    }
    if (cached.entry) scan.events.push(cached.entry)
    else scan.ignored.push({ file: name, reason: cached.reason ?? '无法解析' })
  }
  return scan
}

/**
 * 算一条验收点的当前指纹（`files` 都读到才算得出来）。
 * @author ddj 2026年11月25号
 * @param root 项目根
 * @param files 相对路径清单
 * @returns `sha256:<hex>`；任一文件读不到时返回空串
 */
async function itemHashOf(root: string, files: readonly string[]): Promise<string> {
  if (!files.length) return ''
  const parts: Array<{ path: string; sha256: string }> = []
  for (const relative of files) {
    const absolute = join(root, relative)
    let info: { mtimeMs: number; size: number }
    try {
      const row = await stat(absolute)
      info = { mtimeMs: row.mtimeMs, size: row.size }
    } catch {
      return ''
    }
    const cached = fileHashes.get(absolute)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      parts.push({ path: relative, sha256: cached.sha })
      continue
    }
    try {
      const sha = sha256Of(await readFile(absolute))
      if (fileHashes.size > FILE_HASH_MAX) fileHashes.clear()
      fileHashes.set(absolute, { ...info, sha })
      parts.push({ path: relative, sha256: sha })
    } catch {
      return ''
    }
  }
  return 'sha256:' + sha256Of(subjectHashLines(parts))
}

//endregion

//region 对外读写

/**
 * 读单子视图（带缓存与 watch 标脏；force 时强制重扫）。
 * @author ddj 2026年11月25号
 * @param options 会话工作区、单子 id 与强制标记
 * @returns 派生视图
 */
export async function readView(options: ReadViewOptions): Promise<TestCheckView> {
  const root = projectRootOf(options.cwd)
  const baseDir = baseDirOf(root)
  const id = await pickSheetId(baseDir, options.id)
  const paths = sheetPathsOf(root, id)
  const cache = cacheOf(paths)
  startWatch(paths, cache)

  const fresh = cache.view !== null && !cache.dirty && !options.force
    && Date.now() - cache.scannedAt < (cache.watchers.size >= 2 ? STORE_TTL_MS : POLL_TTL_MS)
  if (fresh) return cache.view as TestCheckView

  cache.dirty = false
  cache.scannedAt = Date.now()
  const detected = await readDefinition(paths)
  if (detected.state !== 'ready' || !detected.definition) {
    const view = emptyView({
      id,
      title: id,
      root: slashPath(root),
      dir: slashPath(paths.dir),
      itemsPath: slashPath(paths.itemsPath),
      eventsDir: slashPath(paths.eventsDir),
    }, detected.state === 'missing' ? 'missing' : 'invalid', detected.error)
    cache.view = view
    return view
  }

  const definition = detected.definition
  const ids = new Set(definition.items.filter((item) => !item.retired).map((item) => item.id))
  const scan = await readEvents(paths, ids, cache)
  const hashes: Record<string, string> = {}
  for (const item of definition.items) {
    if (item.retired || !item.files?.length) continue
    const hash = await itemHashOf(root, item.files)
    if (hash) hashes[item.id] = hash
  }
  const view = deriveSheetView({
    id,
    title: definition.title,
    root: slashPath(root),
    dir: slashPath(paths.dir),
    itemsPath: slashPath(paths.itemsPath),
    eventsDir: slashPath(paths.eventsDir),
    definition,
    events: scan.events,
    hashes,
    ignored: scan.ignored,
  })
  cache.view = view
  return view
}

/**
 * 建单：创建单子目录与事件目录，写 `.gitignore` 与上报片段（都不覆盖已有内容）。
 * @author ddj 2026年11月25号
 * @param options 会话工作区、单子 id 与标题
 * @returns 路径集合与新建标记
 */
export async function ensureSheet(options: { cwd: string; id: string; title?: string }): Promise<{ paths: SheetPaths; created: boolean }> {
  const root = projectRootOf(options.cwd)
  const paths = sheetPathsOf(root, options.id)
  const created = !existsSync(paths.dir)
  await mkdir(paths.eventsDir, { recursive: true })
  const ignorePath = join(paths.baseDir, '.gitignore')
  if (!existsSync(ignorePath)) {
    await mkdir(paths.baseDir, { recursive: true })
    await writeFile(ignorePath, '*\n', 'utf8')
  }
  if (!existsSync(paths.snippetsPath)) {
    await writeFile(paths.snippetsPath, snippetsMarkdown(options.id, options.title), 'utf8')
  }
  const cache = cacheOf(paths)
  cache.dirty = true
  startWatch(paths, cache)
  resetSheetListCache()
  return { paths, created }
}

/**
 * 写一条结果：一条一个文件，文件名带时间戳与随机后缀。
 *
 * 只接受定义里存在且未退役的测试点 id——写错一个字母不会被悄悄丢掉，而是报错让上报方修。
 * @author ddj 2026年11月25号
 * @param options 上报内容
 * @returns 事件文件名与最新视图
 * @throws 定义缺失/有错、测试点不存在时抛错（文案可直接展示）
 */
export async function writeEvent(options: WriteEventOptions): Promise<{ file: string; view: TestCheckView }> {
  const id = strictSheetId(options.id)
  const root = projectRootOf(options.cwd)
  const paths = sheetPathsOf(root, id)
  const detected = await readDefinition(paths)
  if (detected.state === 'missing') throw new Error('还没有 items.json：先在 ' + slashPath(paths.itemsPath) + ' 建单')
  if (detected.state !== 'ready' || !detected.definition) throw new Error('items.json 有错，先修好：' + String(detected.error ?? ''))
  const target = detected.definition.items.find((item) => item.id === options.item)
  if (!target) throw new Error('定义里没有这个测试点：' + options.item)
  if (target.retired) throw new Error('测试点已退役，不再接收结果：' + options.item)

  const payload: Record<string, unknown> = { item: options.item, status: options.status }
  payload.at = (options.at ?? new Date()).toISOString()
  if (options.evidence && Object.keys(options.evidence).length) payload.evidence = options.evidence
  // 上报时没给指纹就按定义里的 files 现场复算一次：AI 用工具上报也自动进入「需复验」判定，
  // 不必要求模型自己算 sha256（真机走查发现缺口：只有脚本上报才带 hash 时，第 4 条永远不触发）。
  const hash = options.hash ?? (target.files?.length ? await itemHashOf(root, target.files) : '')
  if (hash) payload.subject = { hash }

  await mkdir(paths.eventsDir, { recursive: true })
  const at = options.at ?? new Date()
  let file = eventFileNameOf(at)
  for (let attempt = 0; attempt < 3 && existsSync(join(paths.eventsDir, file)); attempt += 1) {
    file = eventFileNameOf(at)
  }
  await writeFile(join(paths.eventsDir, file), JSON.stringify(payload, null, 2) + '\n', 'utf8')

  const cache = cacheOf(paths)
  cache.dirty = true
  resetSheetListCache()
  const view = await readView({ cwd: options.cwd, id, force: true })
  return { file, view }
}

/**
 * 导出交付快照：`docs/acceptance-<id>.html`（单文件、无脚本、脱离 DSH 可独立打开）。
 * @author ddj 2026年11月25号
 * @param options 会话工作区与单子 id
 * @returns 导出路径与导出时的视图
 */
export async function exportSnapshot(options: { cwd: string; id: string }): Promise<{ path: string; view: TestCheckView }> {
  const id = strictSheetId(options.id)
  const view = await readView({ cwd: options.cwd, id, force: true })
  const root = projectRootOf(options.cwd)
  const docsDir = join(root, TEST_CHECK_DOCS)
  await mkdir(docsDir, { recursive: true })
  const target = join(docsDir, snapshotNameOf(id))
  await writeFile(target, renderSheetHtml(view, { exported: true }), 'utf8')
  resetSheetListCache()
  return { path: slashPath(target), view }
}

//endregion

//region 列表与移除

/** 全部单列表上限：每张单都要扫一次定义与事件，防长跑实例把面板拖住。 */
const SHEET_LIST_CAP = 50

/** 列表缓存有效期：面板每次切回来都会重挂，30 秒内不重复全扫。 */
const SHEET_LIST_TTL_MS = 30_000

/** 列表缓存：项目根 → 上次扫描时间与结果。 */
const sheetListCache = new Map<string, { at: number; result: SheetListResult }>()

/**
 * 清掉全部单列表缓存（写盘、建单、删除与测试隔离都调它）。
 * @author ddj 2026年11月26号
 */
export function resetSheetListCache(): void {
  sheetListCache.clear()
}

/** 列表入参。 */
export interface ListSheetsOptions {
  /** 会话工作区。 */
  cwd: string
  /** 跳过缓存（面板「刷新」按钮用）。 */
  force?: boolean
}

/** 列表结果。 */
export interface SheetListResult {
  /** 项目根（`/` 分隔）。 */
  root: string
  /** 按最近活动倒序的验收单。 */
  sheets: TestCheckSheetSummary[]
}

/**
 * 列出项目内全部验收单：计数复用 `readView`，与验收单页签完全一致。
 *
 * 单子目录名必须是合法 id（点开头的 `.gitignore` 之类直接跳过）；
 * 单张读失败只出一行空计数，不让整张列表消失。
 *
 * 结果按项目根缓存 30 秒：面板每次切回来都会重挂，没必要次次全扫；
 * 建单、写结果、导出与删除都会主动清缓存，外部改文件最多滞后 30 秒。
 * @author ddj 2026年11月26号
 * @param options 会话工作区与是否跳过缓存
 * @returns 项目根与行列表（最近活动在前）
 */
export async function listSheets(options: ListSheetsOptions): Promise<SheetListResult> {
  const root = projectRootOf(options.cwd)
  const cached = sheetListCache.get(root)
  if (!options.force && cached !== undefined && Date.now() - cached.at < SHEET_LIST_TTL_MS) {
    return cached.result
  }

  const baseDir = baseDirOf(root)
  let entries: Dirent[]
  try {
    entries = await readdir(baseDir, { withFileTypes: true })
  } catch {
    const empty: SheetListResult = { root: slashPath(root), sheets: [] }
    sheetListCache.set(root, { at: Date.now(), result: empty })
    return empty
  }

  const ids = entries
    .filter((entry) => entry.isDirectory() && isSheetId(entry.name))
    .map((entry) => entry.name)
    .sort()
    .slice(0, SHEET_LIST_CAP)

  const sheets: TestCheckSheetSummary[] = []
  for (const id of ids) sheets.push(await summaryOf(root, id))
  sheets.sort((left, right) => right.updatedAt - left.updatedAt)

  const result: SheetListResult = { root: slashPath(root), sheets }
  sheetListCache.set(root, { at: Date.now(), result })
  return result
}

/**
 * 汇总一张验收单（读失败时保留空计数，标题退回 id）。
 * @author ddj 2026年11月26号
 * @param root 项目根
 * @param id 单子 id
 * @returns 列表行
 */
async function summaryOf(root: string, id: string): Promise<TestCheckSheetSummary> {
  const paths = sheetPathsOf(root, id)
  const snapshot = join(root, TEST_CHECK_DOCS, snapshotNameOf(id))
  const snapshotAt = mtimeOf(snapshot)
  const row: TestCheckSheetSummary = {
    id,
    title: id,
    counts: { total: 0, pass: 0, fail: 0, blocked: 0, todo: 0, stale: 0 },
    itemsPath: slashPath(paths.itemsPath),
    snapshotPath: slashPath(snapshot),
    hasSnapshot: snapshotAt > 0,
    updatedAt: snapshotAt || mtimeOf(paths.dir),
  }

  try {
    const view = await readView({ cwd: root, id })
    row.title = view.title
    row.counts = view.counts
  } catch (error) {
    log.warn('验收单列表读取失败（' + id + '）：' + (error instanceof Error ? error.message : String(error)))
  }
  return row
}

/**
 * 文件或目录的 mtime（毫秒）；不存在或读失败返回 0。
 * @author ddj 2026年11月26号
 * @param path 路径
 * @returns mtimeMs 或 0
 */
function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** 移除入参。 */
export interface RemoveSheetOptions {
  /** 会话工作区。 */
  cwd: string
  /** 单子 id。 */
  id: string
}

/**
 * 删除一张验收单目录与对应交付快照。
 *
 * 只按 id 现算路径，调用方传不了别的目录；目录先关监听再删（Windows 下开着句柄删不掉）。
 * 已经不存在的单不算错，返回空 `removed` 让面板照常刷新。
 * @author ddj 2026年11月26号
 * @param options 会话工作区与单子 id
 * @returns 实际删掉的路径（`/` 分隔）
 * @throws id 非法（文案可直接展示）
 */
export async function removeSheet(options: RemoveSheetOptions): Promise<{ removed: string[] }> {
  const id = strictSheetId(options.id)
  const root = projectRootOf(options.cwd)
  const paths = sheetPathsOf(root, id)
  const snapshot = join(root, TEST_CHECK_DOCS, snapshotNameOf(id))
  const removed: string[] = []

  closeSheetCache(paths)

  if (existsSync(paths.dir)) {
    await rm(paths.dir, { recursive: true, force: true })
    removed.push(slashPath(paths.dir))
  }
  if (existsSync(snapshot)) {
    await rm(snapshot, { force: true })
    removed.push(slashPath(snapshot))
  }
  resetSheetListCache()
  return { removed }
}

/**
 * 关掉一张单的目录监听并丢弃缓存（删目录前必须先关，否则旧视图与句柄都会赖着）。
 * @author ddj 2026年11月26号
 * @param paths 单子路径
 * @returns 无
 */
function closeSheetCache(paths: SheetPaths): void {
  const cache = sheets.get(paths.dir)
  if (!cache) return
  for (const watcher of cache.watchers.values()) {
    try {
      watcher.close()
    } catch {
      /* 已关闭 */
    }
  }
  cache.watchers.clear()
  sheets.delete(paths.dir)
}

//endregion

//region 释放

/**
 * 释放所有目录监听与缓存（插件卸载时调用）。
 * @author ddj 2026年11月25号
 * @returns 无
 */
export function disposeTestCheck(): void {
  for (const cache of sheets.values()) {
    for (const watcher of cache.watchers.values()) {
      try { watcher.close() } catch { /* 已关闭 */ }
    }
    cache.watchers.clear()
  }
  sheets.clear()
  fileHashes.clear()
  resetSheetListCache()
}

//endregion
