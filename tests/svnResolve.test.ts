import { afterEach, describe, expect, it, vi } from 'vitest'
import { join, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createSvnRpc } from '../src/svn.js'
import { conflictOf, pegTarget, validAccept } from '../src/svnResolve.js'
const owners: { dispose(): void }[] = []
afterEach(() => owners.splice(0).forEach((owner) => owner.dispose()))

/** @private @author ddj 2026年10月14号 @param item Text state. @param props Property state. @param tree Tree conflict. @returns Exact SVN XML. */
function xml(item = 'conflicted', props = 'none', tree = false): string {
  return '<status><target path="sub/a"><entry path="sub/a"><wc-status item="' + item + '" props="' + props + '" tree-conflicted="' + tree + '"/></entry></target></status>'
}
/** @private @author ddj 2026年10月14号 @param options Command evidence. @returns Fake subprocess with actual Host handlers. */
function fixture(options: { tree?: boolean; fail?: boolean; hold?: boolean } = {}) {
  const root = process.cwd(), cwd = join(root, 'sub')
  const specs: any[] = []
  let release = () => {}
  const pending = new Promise<{ exitCode: number }>((resolve) => { release = () => resolve({ exitCode: 0 }) })
  /** @private @author ddj 2026年10月14号 @param spec Spawn argv. @returns Collected process outcome. */
  function spawn(spec: any) {
    specs.push(spec)
    const status = spec.argv.includes('status')
    const writing = spec.argv.includes('resolve') || spec.argv.includes('revert')
    const stdout = status ? xml('conflicted', 'none', options.tree) : ''
    const stderr = options.fail && writing ? 'svn: E155027: Conflict not resolved' : ''
    return { done: options.hold && writing ? pending : Promise.resolve({ exitCode: stderr ? 1 : 0 }),
      collected: { stdout: { readFrom: () => ({ text: stdout }) }, stderr: { readFrom: () => ({ text: stderr }) } } }
  }
  /** @private @author ddj 2026年10月14号 @param name Service id. @returns Session/subprocess capability. */
  function get(name: string) { return name === 'sessions' ? { get: () => ({ id: 'one', header: { cwd } }), list: () => [{ id: 'one', header: { cwd } }] } : name === 'subprocess' ? { spawn } : undefined }
  const host = createSvnRpc({ ctx: { get } as any, settings: { svn: () => ({ svnPath: '', tortoisePath: '' }) } as any,
    findRoot: async () => root, findTortoise: async () => null })
  owners.push(host)
  return { call: host.handlers as Record<string, (args: any) => Promise<any>>, specs, release }
}

/** @private @author ddj 2026年10月14号 @param exe CLI executable. @param args Explicit argv. @param cwd Isolated working directory. @returns Complete command output. @throws Nonzero CLI status. */
function cli(exe: string, args: string[], cwd: string): string {
  const out = spawnSync(exe, args, { cwd, encoding: 'utf8' })
  if (out.status !== 0) throw new Error(out.stderr || String(out.error))
  return out.stdout
}

/** @private @author ddj 2026年10月14号 @param directory Workspace temp container. @returns Isolated repository and conflicting nested WC. */
function realFixture(directory: string) {
  const temp = mkdtempSync(join(directory, '.svn-resolve-'))
  const repo = join(temp, 'repo'), local = join(temp, 'local'), remote = join(temp, 'remote')
  cli('svnadmin', ['create', repo], temp)
  const url = pathToFileURL(repo).href
  cli('svn', ['checkout', url, local], temp)
  mkdirSync(join(local, 'sub'))
  for (const file of ['mine.txt', 'theirs.txt', 'working.txt', 'revert.txt', 'prop.txt', 'tree.txt']) writeFileSync(join(local, 'sub', file), 'original\n')
  cli('svn', ['add', 'sub'], local)
  cli('svn', ['commit', '-m', 'seed'], local)
  cli('svn', ['checkout', url, remote], temp)
  for (const file of ['mine.txt', 'theirs.txt', 'working.txt', 'revert.txt', 'tree.txt']) writeFileSync(join(local, 'sub', file), 'local\n')
  for (const file of ['mine.txt', 'theirs.txt', 'working.txt', 'revert.txt']) writeFileSync(join(remote, 'sub', file), 'remote\n')
  cli('svn', ['propset', 'sample', 'local', 'sub/prop.txt'], local)
  cli('svn', ['propset', 'sample', 'remote', 'sub/prop.txt'], remote)
  cli('svn', ['delete', 'sub/tree.txt'], remote)
  cli('svn', ['commit', '-m', 'incoming'], remote)
  cli('svn', ['update', '--accept', 'postpone'], local)
  /** @private @author ddj 2026年10月14号 @param spec Managed process contract. @returns Actual SVN result through Host collection contract. */
  function spawn(spec: any) {
    const out = spawnSync(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, encoding: 'utf8' })
    return { done: Promise.resolve({ exitCode: out.status }), collected: {
      stdout: { readFrom: () => ({ text: out.stdout ?? '' }) }, stderr: { readFrom: () => ({ text: out.stderr ?? '' }) } } }
  }
  /** @private @author ddj 2026年10月14号 @param name Service id. @returns Nested-session and actual subprocess provider. */
  function get(name: string) { return name === 'sessions' ? { get: () => ({ header: { cwd: join(local, 'sub') } }) } : name === 'subprocess' ? { spawn } : undefined }
  const host = createSvnRpc({ ctx: { get } as any, settings: { svn: () => ({ svnPath: '', tortoisePath: '' }) } as any,
    findRoot: async () => local, findTortoise: async () => null })
  return { host, call: host.handlers as Record<string, (args: any) => Promise<any>>, temp, local }
}

describe('isolated real SVN semantics', () => {
  it('full mine/theirs, working mark, nonrecursive BASE revert and property/tree evidence', async () => {
    const f = realFixture(process.cwd())
    try {
      const request = { sessionId: 'isolated' }
      const paths = ['mine.txt', 'theirs.txt', 'working.txt', 'revert.txt', 'prop.txt', 'tree.txt']
      const before = await f.call['svn.conflictStatus']({ ...request, paths })
      expect(before.ok).toBe(true)
      expect(before.states.find((s: any) => s.path === 'prop.txt').props).toBe(true)
      expect(before.states.find((s: any) => s.path === 'tree.txt').tree).toBe(true)
      for (const [path, accept] of [['mine.txt', 'mine-full'], ['theirs.txt', 'theirs-full'], ['working.txt', 'working'], ['prop.txt', 'theirs-full']] as const) {
        expect((await f.call['svn.resolve']({ ...request, path, accept })).ok).toBe(true)
      }
      expect(readFileSync(join(f.local, 'sub/mine.txt'), 'utf8')).toBe('local\n')
      expect(readFileSync(join(f.local, 'sub/theirs.txt'), 'utf8')).toBe('remote\n')
      expect(readFileSync(join(f.local, 'sub/working.txt'), 'utf8')).toContain('<<<<<<<')
      expect(cli('svn', ['propget', 'sample', 'sub/prop.txt'], f.local).trim()).toBe('remote')
      expect((await f.call['svn.revert']({ ...request, paths: ['revert.txt'], depth: 'empty' })).ok).toBe(true)
      expect(readFileSync(join(f.local, 'sub/revert.txt'), 'utf8')).toBe('remote\n')
      expect((await f.call['svn.resolve']({ ...request, path: 'tree.txt', accept: 'theirs-full' })).ok).toBe(false)
      expect((await f.call['svn.resolve']({ ...request, path: 'tree.txt', accept: 'working' })).ok).toBe(true)
      const after = await f.call['svn.conflictStatus']({ ...request, paths })
      expect(after.ok).toBe(true)
      expect(after.states.every((s: any) => !s.text && !s.props && !s.tree)).toBe(true)
    } finally {
      f.host.dispose()
      if (dirname(f.temp) !== process.cwd() || !basename(f.temp).startsWith('.svn-resolve-')) throw new Error('Unexpected cleanup target: ' + f.temp)
      rmSync(f.temp, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('exact SVN conflict evidence and writes', () => {
  it('parses text/property/tree independently, rejects missing or truncated evidence', () => {
    expect(conflictOf(xml('modified', 'conflicted', true), 'a')).toMatchObject({ text: false, props: true, tree: true })
    expect(conflictOf(xml('normal'), 'a')).toMatchObject({ text: false, props: false, tree: false })
    for (const text of ['', '<status/>', '<status></status>', xml().slice(0, -9)]) expect(() => conflictOf(text, 'a')).toThrow('状态未确认')
    expect(validAccept('mine-full')).toBe(true); expect(validAccept('theirs-conflict')).toBe(false)
    expect(pegTarget('a@b')).toBe('a@b@')
  })
  it('status deduplicates paths and maps session subdirectory targets with peg escaping', async () => {
    const f = fixture()
    expect(await f.call['svn.conflictStatus']({ sessionId: 'one', paths: ['a@b', 'a@b'] })).toMatchObject({ ok: true, states: [{ path: 'a@b', text: true }] })
    const status = f.specs.filter((spec) => spec.argv.includes('status'))
    expect(status).toHaveLength(1)
    expect(status[0].argv.slice(-4)).toEqual(['--depth', 'empty', '--', 'sub/a@b@'])
  })
  it('rejects traversal, invalid enums and unknown depth without mutating', async () => {
    const f = fixture()
    for (const path of ['../a', '/a', 'C:/a', 'a\u0000', '']) expect((await f.call['svn.resolve']({ path, accept: 'working' })).ok).toBe(false)
    expect((await f.call['svn.resolve']({ path: 'a', accept: 'launch-shell' })).ok).toBe(false)
    expect((await f.call['svn.revert']({ paths: ['a'], depth: 'infinity' })).ok).toBe(false)
    expect(f.specs).toHaveLength(0)
  })
  it('rejects full tree acceptance, but allows explicit working marking', async () => {
    const f = fixture({ tree: true })
    expect(await f.call['svn.resolve']({ path: 'a', accept: 'mine-full' })).toMatchObject({ ok: false, error: expect.stringContaining('树冲突') })
    expect((await f.call['svn.resolve']({ path: 'a', accept: 'working' })).ok).toBe(true)
    expect(f.specs.find((spec) => spec.argv.includes('resolve')).argv.slice(2)).toEqual(['resolve', '--accept', 'working', '--depth', 'empty', '--', 'sub/a'])
  })
  it('returns original SVN failure and never retries a write', async () => {
    const f = fixture({ fail: true })
    expect(await f.call['svn.resolve']({ path: 'a', accept: 'theirs-full' })).toMatchObject({ ok: false, error: 'svn: E155027: Conflict not resolved' })
    expect(f.specs.filter((spec) => spec.argv.includes('resolve'))).toHaveLength(1)
  })
  it('locks across sessions, rejects update start, and releases after completion', async () => {
    const f = fixture({ hold: true })
    const first = f.call['svn.resolve']({ sessionId: 'one', path: 'a', accept: 'working' })
    await vi.waitFor(() => expect(f.specs.some((spec) => spec.argv.includes('resolve'))).toBe(true))
    expect((await f.call['svn.resolve']({ sessionId: 'two', path: 'b', accept: 'working' })).ok).toBe(false)
    expect((await f.call['svn.updateStart']({ sessionId: 'two', path: '' })).ok).toBe(false)
    f.release(); expect((await first).ok).toBe(true)
    expect((await f.call['svn.revert']({ paths: ['a'], depth: 'empty' })).ok).toBe(true)
    expect(f.specs.find((spec) => spec.argv.includes('revert')).argv.slice(2)).toEqual(['revert', '--depth', 'empty', '--', 'sub/a'])
  })
})
