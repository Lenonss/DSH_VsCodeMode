import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cacheRoot, cleanCache, listCache, openCache } from '../src/univerCache.js'
import type { UniverService } from '../src/univerBridge.js'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

/** @private @author ddj 2026年11月13号 @returns Disposable Office workspace and strict adapter. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'office-cache-'))
  roots.push(root)
  await writeFile(join(root, 'budget.xlsx'), 'original')
  const service: UniverService = {
    newFile: vi.fn(async ({ file }) => { await writeFile(file, 'container', { flag: 'wx' }); return { ok: true } }),
    worktree: vi.fn(async () => ({ ok: true, result: { worktreeId: 'draft' } })),
    importUnitContent: vi.fn(async () => ({ ok: true, result: { unitId: 'unit' } })),
    gatewayStatus: async () => ({ phase: 'stopped' }),
  }
  return { root, service }
}

describe('owned workspace Univer cache', () => {
  it('lists missing cache without creating directories', async () => {
    const { root } = await fixture()
    expect((await listCache(root)).entries).toEqual([])
    expect(await readdir(root)).toEqual(['budget.xlsx'])
  })
  it('automatically creates and reuses unchanged source without mutation replay', async () => {
    const { root, service } = await fixture()
    const first = await openCache(root, 'budget.xlsx', service)
    const second = await openCache(root, 'budget.xlsx', service)
    expect(first.imported.success).toBe(true)
    expect(second.reused).toBe(true)
    expect(second.imported.file).toBe(first.imported.file)
    expect(service.importUnitContent).toHaveBeenCalledTimes(1)
    expect(await readFile(join(root, 'budget.xlsx'), 'utf8')).toBe('original')
  })
  it('preserves old edits on source change and refresh creates a unique generation', async () => {
    const { root, service } = await fixture()
    const first = await openCache(root, 'budget.xlsx', service)
    await writeFile(first.imported.file!, 'edited cache')
    await writeFile(join(root, 'budget.xlsx'), 'new source')
    const changed = await openCache(root, 'budget.xlsx', service)
    expect(changed.sourceChanged).toBe(true)
    expect(await readFile(first.imported.file!, 'utf8')).toBe('edited cache')
    const refreshed = await openCache(root, 'budget.xlsx', service, true)
    expect(refreshed.imported.file).not.toBe(first.imported.file)
    expect((await listCache(root)).entries).toHaveLength(2)
  })
  it('serializes concurrent opens to one imported generation', async () => {
    const { root, service } = await fixture()
    await Promise.all([openCache(root, 'budget.xlsx', service), openCache(root, 'budget.xlsx', service)])
    expect(service.newFile).toHaveBeenCalledTimes(1)
  })
  it('never replays incomplete import on reopening', async () => {
    const { root, service } = await fixture()
    vi.mocked(service.importUnitContent).mockRejectedValue(new Error('converter failed'))
    expect((await openCache(root, 'budget.xlsx', service)).imported.success).toBe(false)
    await expect(openCache(root, 'budget.xlsx', service)).rejects.toThrow('未完成')
    expect(service.newFile).toHaveBeenCalledTimes(1)
  })
  it('skips running Gateway and stale revisions, deletes only selected owned cache', async () => {
    const { root, service } = await fixture()
    await openCache(root, 'budget.xlsx', service)
    const entry = (await listCache(root)).entries[0]
    expect((await cleanCache(root, [entry], true))[0].status).toBe('skipped')
    expect((await cleanCache(root, [{ ...entry, revision: 'stale' }], false))[0].status).toBe('skipped')
    expect((await cleanCache(root, [entry], false))[0].status).toBe('deleted')
    expect((await listCache(root)).entries).toHaveLength(0)
    expect(await readFile(join(root, 'budget.xlsx'), 'utf8')).toBe('original')
  })
  it('refuses unknown files and arbitrary traversal identifiers', async () => {
    const { root, service } = await fixture()
    const opened = await openCache(root, 'budget.xlsx', service)
    await writeFile(join(dirname(opened.imported.file!), 'user-document.txt'), 'keep')
    const entry = (await listCache(root)).entries[0]
    expect((await cleanCache(root, [entry], false))[0]).toMatchObject({ status: 'skipped', reason: '存在未知文件，未清理' })
    expect((await cleanCache(root, [{ id: '../../budget.xlsx', revision: '' }], false))[0].status).toBe('failed')
  })
  it('refuses linked cache ancestors without touching the destination', async () => {
    const { root } = await fixture()
    const other = await fixture()
    await symlink(other.root, join(root, '.dsh'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(cacheRoot(root, true)).rejects.toThrow('链接')
    expect(await readdir(other.root)).toEqual(['budget.xlsx'])
  })
  it('marks source changes during import incomplete instead of claiming synchronization', async () => {
    const { root, service } = await fixture()
    vi.mocked(service.importUnitContent).mockImplementationOnce(async () => { await writeFile(join(root, 'budget.xlsx'), 'changed during import'); return { ok: true } })
    const result = await openCache(root, 'budget.xlsx', service)
    expect(result.imported.success).toBe(false)
    expect(result.sourceChanged).toBe(true)
    expect((await listCache(root)).entries[0].complete).toBe(false)
  })
  it('does not delete manually authored Univer files', async () => {
    const { root } = await fixture()
    await writeFile(join(root, 'manual.univer'), 'user content')
    expect((await listCache(root)).entries).toEqual([])
    expect(await readFile(join(root, 'manual.univer'), 'utf8')).toBe('user content')
  })
  it('refuses source escapes', async () => {
    const { root, service } = await fixture()
    const other = await fixture()
    await expect(openCache(root, join(other.root, 'budget.xlsx'), service)).rejects.toThrow('超出')
  })
})
