/** Owned workspace Office cache; never swept automatically. @author ddj 2026年11月13号 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { univerCacheRoot } from './paths.js'
import { importCopy, insideRoot } from './univerBridge.js'
import type { UniverService } from './univerBridge.js'
import { canImportOffice } from './shared/univer.js'
import type { UniverCachedOpen, UniverCacheEntry, UniverCleanItem, UniverImportResult } from './shared/univer.js'

interface CacheRecord {
  owner: 'dsh-vscode-mode/univer-v1'
  source: string
  fingerprint: string
  sourceBytes: number
  sourceMtime: number
  createdAt: number
  accessedAt: number
  imported: UniverImportResult
}
interface StoredEntry { view: UniverCacheEntry; record: CacheRecord }
const queues = new Map<string, Promise<unknown>>()
const OWNER = 'dsh-vscode-mode/univer-v1'

/** @private @author ddj 2026年11月13号 @param content Exact bytes. @returns Stable full hash. */
function digest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** @public @author ddj 2026年11月13号 @param workspace Real workspace. @param create Explicit mutation. @returns Checked cache root without following symlinks. @throws Unsafe existing ancestor. */
export async function cacheRoot(workspace: string, create = false): Promise<string> {
  const root = await realpath(workspace)
  const target = univerCacheRoot(root)
  let current = root
  for (const part of relative(root, target).split(sep)) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory() || !insideRoot(root, await realpath(current))) throw new Error('缓存路径包含链接或非目录')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!create) return target
      try { await mkdir(current) } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory() || !insideRoot(root, await realpath(current))) throw new Error('缓存目录身份变化')
    }
  }
  return target
}

/** @private @author ddj 2026年11月13号 @param root Cache root. @param id Host-owned relative entry id. @returns Checked generation directory. @throws Malformed or linked entry. */
async function entryDir(root: string, id: string): Promise<string> {
  if (!/^[a-f0-9]{64}\/[a-f0-9-]{36}$/.test(id)) throw new Error('无效缓存标识')
  let directory = root
  for (const part of id.split('/')) {
    directory = join(directory, part)
    const info = await lstat(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('缓存条目包含链接')
  }
  return directory
}

/** @private @author ddj 2026年11月13号 @param root Checked root. @param id Generation id. @returns Valid owned metadata and disk identity. */
async function readEntry(root: string, id: string): Promise<StoredEntry> {
  const directory = await entryDir(root, id)
  const metadata = join(directory, 'entry.json')
  const info = await lstat(metadata)
  if (info.isSymbolicLink() || !info.isFile() || info.size > 32768) throw new Error('缓存清单不安全')
  const text = await readFile(metadata, 'utf8')
  const record = JSON.parse(text) as CacheRecord
  if (record.owner !== OWNER || typeof record.source !== 'string' || !/^[a-f0-9]{64}$/.test(record.fingerprint) || !Number.isFinite(record.createdAt) || !record.imported || typeof record.imported.success !== 'boolean') throw new Error('缓存所有权记录无效')
  const names = await readdir(directory)
  let bytes = 0
  const identities: string[] = []
  for (const name of names.sort()) {
    const child = await lstat(join(directory, name))
    if (child.isSymbolicLink() || !child.isFile()) throw new Error('缓存条目含未知目录或链接')
    bytes += child.size
    identities.push(name + ':' + child.size + ':' + child.mtimeMs)
  }
  return { record, view: { id, revision: digest(text + identities.join('|')), source: record.source, file: join(directory, 'document.univer'), bytes, createdAt: record.createdAt, complete: record.imported.success } }
}

/** @public @author ddj 2026年11月13号 @param workspace Session workspace. @returns Bounded owned cache listing; does not create directories. */
export async function listCache(workspace: string): Promise<{ root: string; entries: UniverCacheEntry[]; truncated: boolean }> {
  const root = await cacheRoot(workspace)
  let sources: string[]
  try { sources = await readdir(root) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { root, entries: [], truncated: false }; throw error }
  const entries: UniverCacheEntry[] = []
  let observed = 0
  for (const source of sources) {
    if (!/^[a-f0-9]{64}$/.test(source)) continue
    const sourceInfo = await lstat(join(root, source))
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) continue
    for (const generation of await readdir(join(root, source))) {
      if (++observed > 500) return { root, entries, truncated: true }
      try { entries.push((await readEntry(root, source + '/' + generation)).view) } catch { /* Unsafe/unowned entries are never offered for deletion. */ }
    }
  }
  return { root, entries: entries.sort((a, b) => b.createdAt - a.createdAt), truncated: false }
}

/** @public @author ddj 2026年11月13号 @param workspace Workspace identity. @param action Serialized cache operation. @returns Exclusive process-local result. */
export async function withCacheLock<T>(workspace: string, action: () => Promise<T>): Promise<T> {
  const key = await realpath(workspace)
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(action)
  queues.set(key, next)
  try { return await next } finally { if (queues.get(key) === next) queues.delete(key) }
}

/** @private @author ddj 2026年11月13号 @param directory Owned generation. @param record Metadata. Atomically persists stage without rewriting document. */
async function saveRecord(directory: string, record: CacheRecord): Promise<void> {
  const temporary = join(directory, 'entry-' + randomUUID() + '.tmp')
  const handle = await open(temporary, 'wx')
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync() } finally { await handle.close() }
  await rename(temporary, join(directory, 'entry.json'))
}

/** @private @author ddj 2026年11月13号 @param workspace Canonical workspace. @param source Source relative path. @returns Source identity and content hash. */
async function sourceState(workspace: string, source: string) {
  if (!canImportOffice(source)) throw new Error('不支持的 Office 源文件')
  const path = await realpath(resolve(workspace, source))
  if (!insideRoot(workspace, path) || !(await lstat(path)).isFile()) throw new Error('源文件超出工作区或不是文件')
  if ((await lstat(path)).size > 32 * 1024 * 1024) throw new Error('Office 源文件超过32MiB缓存导入上限')
  const normalized = relative(workspace, path).split(sep).join('/')
  const identity = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  const info = await lstat(path)
  return { path, source: normalized, key: digest(identity), fingerprint: digest(await readFile(path)), bytes: info.size, mtime: info.mtimeMs }
}

/** @public @author ddj 2026年11月13号 @param workspace Checked workspace. @param source Office source. @param service Optional adapter. @param refresh Explicit source refresh. @returns Existing edits preserved or new owned generation. */
export async function openCache(workspace: string, source: string, service: UniverService, refresh = false): Promise<UniverCachedOpen> {
  return withCacheLock(workspace, async () => {
    const canonical = await realpath(workspace)
    await sourceState(canonical, source)
    const root = await cacheRoot(canonical, true)
    const lock = await open(join(root, '.mutation.lock'), 'wx').catch(() => { throw new Error('缓存正由其他进程操作；未重复创建，请稍后重试') })
    try { return await prepareCache(canonical, root, source, service, refresh) }
    finally { await lock.close(); await unlink(join(root, '.mutation.lock')) }
  })
}

/** @private @author ddj 2026年11月13号 @param workspace Canonical workspace. @param root Cache root. @param source Office source. @param service Upstream adapter. @param refresh Explicit refresh. @returns Checked cached operation. */
async function prepareCache(workspace: string, root: string, source: string, service: UniverService, refresh: boolean): Promise<UniverCachedOpen> {
  const original = await sourceState(workspace, source)
  const listing = await listCache(workspace)
  if (listing.truncated) throw new Error('缓存条目超过查询上限，请先清理后再打开')
  const previous = listing.entries.find((entry) => entry.id.startsWith(original.key + '/'))
  if (previous && !refresh) {
    const stored = await readEntry(root, previous.id)
    const file = await lstat(previous.file).catch(() => null)
    if (!file?.isFile() || file.isSymbolicLink()) throw new Error('缓存容器缺失或身份异常；请在设置中检查缓存')
    if (!previous.complete) throw new Error('上次缓存准备未完成；请检查草稿，不自动重复导入')
    stored.record.accessedAt = Date.now()
    await saveRecord(join(root, previous.id), stored.record)
    return { imported: { ...stored.record.imported, file: previous.file }, sourceChanged: stored.record.fingerprint !== original.fingerprint, reused: true }
  }
  const sourceDirectory = join(root, original.key)
  try { await mkdir(sourceDirectory) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  if ((await lstat(sourceDirectory)).isSymbolicLink()) throw new Error('缓存源目录包含链接')
  const directory = join(sourceDirectory, randomUUID())
  await mkdir(directory)
  const file = join(directory, 'document.univer')
  const record: CacheRecord = { owner: OWNER, source: original.source, fingerprint: original.fingerprint, sourceBytes: original.bytes, sourceMtime: original.mtime, createdAt: Date.now(), accessedAt: Date.now(), imported: { success: false, stage: 'create', file } }
  await saveRecord(directory, record)
  record.imported = await importCopy(service, { workspace, source: original.path, file })
  const current = await sourceState(workspace, source)
  const changed = current.fingerprint !== original.fingerprint
  if (changed) record.imported = { ...record.imported, success: false, error: '导入期间源文件发生变化，请检查缓存结果，未自动重试' }
  await saveRecord(directory, record)
  return { imported: record.imported, sourceChanged: changed, reused: false }
}

/** @public @author ddj 2026年11月13号 @param workspace Authorized root. @param selected Host-issued identities. @param busy Gateway may hold handles. @returns Per-entry safe cleanup outcome. */
export async function cleanCache(workspace: string, selected: Array<{ id: string; revision: string }>, busy: boolean): Promise<UniverCleanItem[]> {
  return withCacheLock(workspace, async () => {
    const root = await cacheRoot(workspace)
    if (busy) return selected.map(({ id }) => ({ id, status: 'skipped', reason: 'Univer 服务运行中，可能持有缓存；未停止服务或删除文件' }))
    let lock
    try { lock = await open(join(root, '.mutation.lock'), 'wx') } catch { return selected.map(({ id }) => ({ id, status: 'skipped', reason: '缓存不存在或正在由其他进程操作' })) }
    try {
      const results: UniverCleanItem[] = []
      for (const selection of selected.slice(0, 500)) results.push(await cleanEntry(root, selection))
      return results
    } finally { await lock.close(); await unlink(join(root, '.mutation.lock')) }
  })
}

/** @private @author ddj 2026年11月13号 @param root Checked cache root. @param selection Selected revision. @returns Outcome without deleting unknown files. */
async function cleanEntry(root: string, selection: { id: string; revision: string }): Promise<UniverCleanItem> {
  const { id } = selection
  try {
    const stored = await readEntry(root, id)
    if (stored.view.revision !== selection.revision) return { id, status: 'skipped', reason: '缓存已变化，请刷新后重选' }
    const directory = await entryDir(root, id)
    const names = await readdir(directory)
    if (names.some((name) => !['entry.json', 'document.univer', 'document.univer-wal', 'document.univer-shm', 'document.univer-journal'].includes(name))) return { id, status: 'skipped', reason: '存在未知文件，未清理' }
    for (const name of names.filter((name) => name !== 'entry.json')) await unlink(join(directory, name))
    await unlink(join(directory, 'entry.json'))
    await rmdir(directory)
    await rmdir(join(root, id.split('/')[0])).catch(() => undefined)
    return { id, status: 'deleted' }
  } catch (error) { return { id, status: 'failed', reason: String(error) } }
}
