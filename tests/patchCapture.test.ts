/** Multi-target patch raw evidence, including partial failures. @author ddj 2026年11月04号 */
import { describe, it, expect, vi } from 'vitest'
vi.mock('../src/hostImport.js', () => ({ loadHostModule: async () => ({ parsePatch: () => [{ path: 'a' }, { path: 'src', moveTo: 'dst' }] }) }))
import { installPending } from '../src/pending/capture.js'
import { patchDiagnostics } from '../src/toolTargets.js'

/** @private @author ddj 2026年11月04号 @returns Raw provider and actual middleware fixture. */
function fixture() {
  const files = new Map([['/ws/a', '\uFEFFA\r\n'], ['/ws/src', 'SOURCE']])
  let handler: any
  const sink = vi.fn()
  const fs = {
    resolve: async (path: string) => '/ws/' + path,
    processPath: (path: string) => path,
    readBytes: async (path: string) => {
      if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'FS_NOT_FOUND' })
      return Buffer.from(files.get(path)!, 'utf8')
    },
  }
  const capture = installPending({ get: (name: string) => name === 'fs' ? fs : { get: () => '/ws' },
    on: (event: string, callback: any) => { if (event === 'tools/execute') handler = callback },
  } as any, sink)
  const exec = { id: 'patch1', name: 'apply_patch', arguments: { input: 'official-parser-input' }, agent: { session: { id: 'patch-session' } } }
  return { files, sink, capture, run: (next: () => Promise<unknown>) => handler(exec, next) }
}

describe('patch capture', () => {
  it('captures independent update, delete and move destination while preserving BOM', async () => {
    const f = fixture()
    await f.run(async () => { f.files.set('/ws/a', '\uFEFFB\r\n'); f.files.delete('/ws/src'); f.files.set('/ws/dst', 'SOURCE'); return { value: { phase: 'commit', operations: [] } } })
    expect(f.sink).toHaveBeenCalledTimes(3)
    expect(f.sink.mock.calls.map(([write]) => [write.path, write.before, write.after])).toEqual([
      ['a', '\uFEFFA\r\n', '\uFEFFB\r\n'], ['src', 'SOURCE', null], ['dst', null, 'SOURCE'],
    ])
    f.capture.dispose()
  })
  it('preserves original thrown identity and records only effects of partial move', async () => {
    const f = fixture(), failure = new Error('partial move')
    await expect(f.run(async () => { f.files.set('/ws/dst', 'SOURCE'); throw failure })).rejects.toBe(failure)
    expect(f.sink).toHaveBeenCalledTimes(1)
    expect(f.sink.mock.calls[0][0]).toMatchObject({ path: 'dst', before: null, after: 'SOURCE' })
    f.capture.dispose()
  })
  it('treats null result baselines only as diagnostics, never preimages', () => {
    expect(patchDiagnostics({ value: { phase: 'commit', operations: [{ kind: 'move', path: 'src', status: 'unknown' }] } })).toEqual(['src: unknown'])
    expect(patchDiagnostics({ value: { phase: 'commit', operations: [{ kind: 'add', path: 'dst', status: 'completed', changes: [{ path: 'dst', before: null, after: 'x' }] }] } })).toEqual([])
    expect(patchDiagnostics({ operations: 'bad' })).toHaveLength(1)
  })
})
