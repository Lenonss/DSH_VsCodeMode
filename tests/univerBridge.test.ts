import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importCopy, importPaths, univerService } from '../src/univerBridge.js'
import type { UniverService } from '../src/univerBridge.js'
import { univerHandlers } from '../src/univerRpc.js'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

/** @private @author ddj 2026年11月12号 @returns Scoped temporary workspace. */
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'edrv-univer-'))
  roots.push(root)
  await writeFile(join(root, 'book.xlsx'), 'unchanged source')
  return root
}

/** @private @author ddj 2026年11月12号 @returns Mock matching installed service methods. */
function service(): UniverService {
  return { newFile: vi.fn().mockResolvedValue({ ok: true }), worktree: vi.fn().mockResolvedValue({ ok: true, result: { worktreeId: 'draft' } }), importUnitContent: vi.fn().mockResolvedValue({ ok: true, result: { unitId: 'sheet' } }), gatewayStatus: () => ({ phase: 'stopped' }) }
}

/** @private @author ddj 2026年11月12号 @param root Test workspace. @param provider Optional service. @param mode Sandbox mode. @returns Live session context without browser authority. */
function context(root: string, provider: unknown, mode = 'workspace-write') {
  const services: Record<string, unknown> = { sessions: { get: () => ({ id: 'session', header: { cwd: root } }) }, sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: root }) }, univer: provider }
  return { get: (name: string) => services[name] }
}

describe('optional Univer Host adapter', () => {
  it('rejects automatic cache creation and cleanup in read-only sessions', async () => {
    const provider = service()
    const handlers = univerHandlers(context('workspace', provider, 'read-only'))
    expect((await handlers['edrv.univer.openCached']!({ sessionId: 'session', source: 'book.xlsx', operationId: 'cache-readonly' })).ok).toBe(false)
    expect((await handlers['edrv.univer.cacheClean']!({ sessionId: 'session', entries: [] })).ok).toBe(false)
    expect(provider.newFile).not.toHaveBeenCalled()
  })
  it('rejects read-only import before invoking any service mutation', async () => {
    const provider = service()
    const handlers = univerHandlers(context('workspace', provider, 'read-only'))
    const result = await handlers['edrv.univer.importCopy']!({ sessionId: 'session', source: 'book.xlsx', target: 'book.univer', operationId: 'read-only' })
    expect(result.ok).toBe(false)
    expect(provider.newFile).not.toHaveBeenCalled()
  })
  it('reuses completed operation results without repeating side effects', async () => {
    const root = await workspace()
    const provider = service()
    const handlers = univerHandlers(context(root, provider))
    const args = { sessionId: root, source: 'book.xlsx', target: 'book.univer', operationId: 'once' }
    const results = await Promise.all([handlers['edrv.univer.importCopy']!(args), handlers['edrv.univer.importCopy']!(args)])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(provider.newFile).toHaveBeenCalledTimes(1)
    expect(provider.importUnitContent).toHaveBeenCalledTimes(1)
  })
  it('awaits real asynchronous Gateway status without starting it', async () => {
    const provider = service()
    provider.gatewayStatus = vi.fn().mockResolvedValue({ phase: 'running' })
    const handlers = univerHandlers(context('workspace', provider))
    expect(await handlers['edrv.univer.capabilities']!({ sessionId: 'session' })).toMatchObject({ ok: true, capability: { gateway: 'running' } })
    expect(provider.newFile).not.toHaveBeenCalled()
  })
  it('keeps optional absence a nonfatal capability result', async () => {
    const handlers = univerHandlers(context('workspace', undefined))
    expect(await handlers['edrv.univer.capabilities']!({ sessionId: 'session' })).toMatchObject({ ok: true, capability: { available: false } })
  })
  it('does not require an absent or partial plugin', () => {
    expect(univerService(undefined)).toBeNull()
    expect(univerService({ newFile() {} })).toBeNull()
    expect(univerService(service())).not.toBeNull()
  })
  it('authorizes only supported sources and absent local targets', async () => {
    const root = await workspace()
    const paths = await importPaths(root, 'book.xlsx', 'book.xlsx.univer')
    expect(paths.source).toBe(join(paths.workspace, 'book.xlsx'))
    await writeFile(paths.file, 'existing')
    await expect(importPaths(root, 'book.xlsx', 'book.xlsx.univer')).rejects.toThrow('已存在')
    await expect(importPaths(root, 'book.xlsm', 'macro.univer')).rejects.toThrow('不支持')
    await mkdir(join(root, 'directory.xlsx'))
    await expect(importPaths(root, 'directory.xlsx', 'dir.univer')).rejects.toThrow('普通文件')
  })
  it('refuses workspace escapes', async () => {
    const root = await workspace()
    await expect(importPaths(root, 'book.xlsx', '../escape.univer')).rejects.toThrow('超出')
  })
  it('imports into draft without merging or deleting source', async () => {
    const root = await workspace()
    const paths = await importPaths(root, 'book.xlsx', 'book.univer')
    const provider = service()
    expect(await importCopy(provider, paths)).toEqual({ success: true, stage: 'complete', file: paths.file, worktreeId: 'draft', unitId: 'sheet' })
    expect(provider.worktree).toHaveBeenCalledWith(expect.objectContaining({ action: 'create' }))
    expect(provider.importUnitContent).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: 'draft' }))
    expect(vi.mocked(provider.importUnitContent).mock.calls[0][0]).not.toHaveProperty('docType')
  })
  it('passes traditional layout only for Word imports', async () => {
    const provider = service()
    await importCopy(provider, { workspace: 'root', file: 'target.univer', source: 'source.docx' })
    expect(provider.importUnitContent).toHaveBeenCalledWith(expect.objectContaining({ docType: 'traditional' }))
  })
  it('reports a partial draft instead of replaying a failed import', async () => {
    const provider = service()
    vi.mocked(provider.importUnitContent).mockRejectedValue(new Error('converter failed'))
    const result = await importCopy(provider, { workspace: 'root', file: 'target.univer', source: 'source.xlsx' })
    expect(result).toMatchObject({ success: false, stage: 'import', file: 'target.univer', worktreeId: 'draft', error: 'converter failed' })
    expect(provider.newFile).toHaveBeenCalledTimes(1)
    expect(provider.importUnitContent).toHaveBeenCalledTimes(1)
  })
})
