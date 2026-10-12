/** Compact wire/index regression; targeted fixture only. @author ddj 2026年10月10号 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExplorerQueue, ExplorerScopes } from '../src/svnExplorerCache.js'
import { explorerViewOf, viewArgsValid } from '../src/svnExplorer.js'
import { createSvnRpc } from '../src/svn.js'
import { Readable } from 'node:stream'
import type { SvnChangeEntry } from '../src/shared/svn.js'
const owners: { dispose(): void }[] = []
afterEach(() => { for (const owner of owners.splice(0)) owner.dispose(); vi.useRealTimers() })
/** @private @author ddj 2026年10月10号 @param paths Versioned paths. @returns Shared scope queue with observed scans. */
async function fixture(paths: string[] = ['a', 'a/x', 'b/y']) {
  const entries: SvnChangeEntry[] = paths.map((path) => ({ path, status: 'normal', versioned: true }))
  const scan = vi.fn().mockResolvedValue({ entries, truncated: false })
  const queue = new ExplorerQueue(scan, Date.now, false)
  owners.push(queue); await queue.initial()
  return { queue, scan }
}

describe('compact explorer wire projection', () => {
  it('projects requested rows only; stale ancestors/target do not invalidate unrelated rows', async () => {
    const { queue } = await fixture()
    queue.invalidate({ paths: ['a/x'], event: 'one' })
    const out = explorerViewOf(queue, 'scope', '.', { rows: [{ path: 'a', isDir: true }, { path: 'a/x', isDir: false }, { path: 'b/y', isDir: false }] })
    expect(out.rows).toEqual([{ path: 'a', kind: 'clean', count: 0, stale: true }, { path: 'a/x', kind: 'clean', count: 0, stale: true }, { path: 'b/y', kind: 'clean', count: 0, stale: false }])
    expect(out).not.toHaveProperty('entries')
    expect(out.complete).toBe(false)
  })
  it('returns mismatch without rows after invalidation or scan completion between pages', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    const { queue } = await fixture()
    const one = explorerViewOf(queue, 'scope', '.', { rows: [] })
    queue.invalidate({ paths: ['a/x'] })
    expect(explorerViewOf(queue, 'scope', '.', { rows: [{ path: 'b/y', isDir: false }], revision: one.revision, generation: one.generation })).toMatchObject({ mismatch: true, rows: [] })
    const two = explorerViewOf(queue, 'scope', '.', { rows: [] })
    await vi.advanceTimersByTimeAsync(300)
    expect(explorerViewOf(queue, 'scope', '.', { rows: [], revision: two.revision, generation: two.generation }).mismatch).toBe(true)
  })
  it('bounds rows/path tokens/byte budget and rejects absolute paths or traversal', () => {
    expect(viewArgsValid({ rows: [] })).toBe(true)
    expect(viewArgsValid({ rows: [], reason: 'paths', paths: ['a/x'], clientId: 'ui', eventId: '1' })).toBe(true)
    for (const path of ['../x', 'a/../x', 'C:/x', '/x', '\\x', 'x\u0000']) expect(viewArgsValid({ rows: [{ path, isDir: true }] })).toBe(false)
    expect(viewArgsValid({ rows: [], reason: 'full' })).toBe(false)
    expect(viewArgsValid({ rows: [], paths: Array(257).fill('a/x') })).toBe(false)
    expect(viewArgsValid({ rows: Array(1001).fill({ path: 'a', isDir: false }) })).toBe(false)
    expect(viewArgsValid({ rows: Array(1000).fill({ path: '长'.repeat(1024), isDir: false }) })).toBe(false)
  })
  it('1000 typical rows serialize within 256KiB, independent of total retained entries', async () => {
    const paths = Array.from({ length: 1000 }, (_, i) => 'Assets/Source/file-' + i + '.lua')
    const { queue } = await fixture(paths)
    const out = explorerViewOf(queue, 'scope', '.', { rows: paths.map((path) => ({ path, isDir: false })) })
    expect(out.rows).toHaveLength(1000)
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(256 * 1024)
  })
  it('rejects cross-scope generation reuse and evicts only idle owners', async () => {
    const scopes = new ExplorerScopes(); owners.push(scopes)
    const scan = vi.fn().mockResolvedValue({ entries: [], truncated: false })
    const one = scopes.get('one', scan), two = scopes.get('two', scan)
    one.invalidate(); two.invalidate()
    expect(() => scopes.get('three', scan)).toThrow('繁忙')
    await one.initial(); await two.initial()
    const three = scopes.get('three', scan)
    expect(three).not.toBe(one)
    expect(scopes.get('two', scan)).toBe(two)
    await expect(one.initial()).rejects.toThrow('已释放')
  })
  it('RPC shares root/session-directory cache across sessions, ids deduplicate, and invalid requests never spawn', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    const calls: any[] = []
    /** @private @author ddj 2026年10月10号 @param spec Provider specification. @returns Complete XML raw pipe. */
    function spawn(spec: any) {
      calls.push(spec)
      const text = spec.argv.includes('--version') ? '1.14.5' : '<status><entry path="a"><wc-status item="normal" props="none" revision="1"/></entry></status>'
      return { stdout: Readable.from([text]), done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text }) } } }
    }
    /** @private @author ddj 2026年10月10号 @param name Cordis service. @returns Minimal capability. */
    function get(name: string) { return name === 'sessions' ? { get: () => ({ header: { cwd: process.cwd() } }) } : name === 'subprocess' ? { spawn } : undefined }
    const host = createSvnRpc({ ctx: { get } as any, settings: { svn: () => ({ svnPath: '', tortoisePath: '' }) } as any,
      findRoot: async () => process.cwd(), findTortoise: async () => null }); owners.push(host)
    const call = host.handlers['svn.explorerView']
    const a = await call({ sessionId: 'one', rows: [{ path: 'a', isDir: false }] })
    const b = await call({ sessionId: 'two', rows: [] })
    expect(a).toMatchObject({ ok: true, complete: true, rows: [{ path: 'a', kind: 'clean', stale: false }] })
    expect(b).toMatchObject({ scopeId: a.ok ? a.scopeId : '', revision: 1 })
    await call({ sessionId: 'one', rows: [], reason: 'full', clientId: 'x', eventId: '1' })
    const again = await call({ sessionId: 'one', rows: [], reason: 'full', clientId: 'x', eventId: '1' })
    expect(again).toMatchObject({ generation: 2 })
    await vi.advanceTimersByTimeAsync(300)
    expect(calls.filter((c) => c.argv.includes('status'))).toHaveLength(2)
    expect((await call({ rows: [{ path: '../x', isDir: false }] })).ok).toBe(false)
    expect(calls.every((c) => !c.argv.includes('-u') && !c.argv.includes('update'))).toBe(true)
  })
})
