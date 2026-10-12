/** Confirmed local icons, scope mapping and read-only RPC guards. @author ddj 2026年10月09号 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createSvnRpc, parseRemoteStatusXml, parseStatusXml } from '../src/svn.js'
import { scopeEntriesOf, statusXmlValid } from '../src/svnExplorer.js'
import { explorerIndexOf, explorerMarkOf, explorerPathOf, remoteIndexOf } from '../src/shared/svnExplorer.js'
import type { SvnChangeEntry, SvnItemStatus } from '../src/shared/svn.js'

/** @private @author ddj 2026年10月09号 @param path Relative path. @param status Status. @param props Property status. @returns Fixture entry. */
function entryOf(path: string, status: SvnItemStatus = 'normal', props: SvnChangeEntry['props'] = 'none'): SvnChangeEntry {
  return { path, status, props, versioned: status !== 'ignored' && status !== 'unversioned' }
}
/** @private @author ddj 2026年10月09号 @param text CLI output. @param code Exit code. @returns Mocked host RPC and observed spawn specs. */
function hostOf(text: string, code = 0) {
  const calls: any[] = []
  const root = join('/wc')
  const cwd = join(root, 'sub')
  /** @private @author ddj 2026年10月09号 @param spec Spawn spec. @returns Collected read-only CLI result. */
  function spawn(spec: any) {
    calls.push(spec)
    return { stdout: spec.stdio.stdout === 'pipe' ? Readable.from([Buffer.from(text)]) : null, done: Promise.resolve({ exitCode: spec.argv.includes('--version') ? 0 : code }), collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: code ? 'svn: E170013: failure' : '' }) } } }
  }
  /** @private @author ddj 2026年10月09号 @param name Service. @returns Minimal host services. */
  function get(name: string) {
    if (name === 'subprocess') return { spawn }
    if (name === 'sessions') return { get: () => ({ id: 's1', header: { cwd } }), list: () => [{ id: 's1', header: { cwd } }] }
  }
  const rpc = createSvnRpc({ ctx: { get } as any, settings: { svn: () => ({ svnPath: '', tortoisePath: '' }) } as any,
    findRoot: async () => root, findTortoise: async () => null })
  return { ...rpc, handlers: rpc.handlers as Record<string, (args: any) => Promise<any>>, calls }
}

const XML = '<status><target path="sub"><entry path="sub/a"><wc-status item="normal" props="none" revision="2"/></entry></target></status>'

describe('SVN explorer icon semantics', () => {
  it('only confirmed versioned normal entries are green; absence is unknown', () => {
    const index = explorerIndexOf([entryOf('a'), { ...entryOf('b'), versioned: false }])
    expect(explorerMarkOf(index, 'a', false)?.kind).toBe('clean')
    expect(explorerMarkOf(index, 'b', false)).toBeNull()
    expect(explorerMarkOf(index, 'absent', false)).toBeNull()
    expect(explorerMarkOf(null, 'a', false)).toBeNull()
  })
  it('normal directory is overridden by descendant modifications', () => {
    const index = explorerIndexOf([entryOf('dir'), entryOf('dir/a', 'modified'), entryOf('dir/sub/b', 'added')])
    expect(explorerMarkOf(index, 'dir', true)).toEqual({ kind: 'modified', title: '已修改；子项 2 处变更' })
    expect(explorerMarkOf(index, 'dir/sub', true)?.kind).toBe('added')
  })
  it('properties-only modification and conflict affect file and ancestors', () => {
    const index = explorerIndexOf([entryOf('dir/a', 'normal', 'modified'), entryOf('dir/b', 'normal', 'conflicted')])
    expect(explorerMarkOf(index, 'dir/a', false)?.kind).toBe('modified')
    expect(explorerMarkOf(index, 'dir', true)?.kind).toBe('conflict')
  })
  it('direct conflict cannot be masked by a modified child', () => {
    const index = explorerIndexOf([entryOf('dir', 'conflicted'), entryOf('dir/a', 'modified')])
    expect(explorerMarkOf(index, 'dir', true)?.kind).toBe('conflict')
  })
  it('incomplete snapshot suppresses normal directories, not confirmed files', () => {
    const index = explorerIndexOf([entryOf('dir'), entryOf('dir/a')], true)
    expect(explorerMarkOf(index, 'dir', true)).toBeNull()
    expect(explorerMarkOf(index, 'dir/a', false)?.kind).toBe('clean')
  })
  it('unversioned and ignored ancestors apply to their unlisted descendants', () => {
    const index = explorerIndexOf([entryOf('new', 'unversioned'), entryOf('cache', 'ignored')])
    expect(explorerMarkOf(index, 'new/deep/a', false)?.kind).toBe('unversioned')
    expect(explorerMarkOf(index, 'cache/a', false)?.kind).toBe('ignored')
  })
  it('all local statuses have explicit icons', () => {
    const statuses: SvnItemStatus[] = ['added', 'deleted', 'missing', 'replaced', 'obstructed', 'incomplete', 'external']
    const index = explorerIndexOf(statuses.map((s) => entryOf(s, s)))
    expect(statuses.map((s) => explorerMarkOf(index, s, false)?.kind)).toEqual(['added', 'deleted', 'deleted', 'modified', 'conflict', 'conflict', 'external'])
  })
  it('remote arrow coexists independently and propagates counts', () => {
    const remote = remoteIndexOf([{ path: 'dir/a', item: 'modified' }, { path: 'dir/sub/b', item: 'added' }])
    expect(remote.get('dir')).toBe(2)
    expect(remote.get('dir/a')).toBe(1)
    expect(remote.has('')).toBe(false)
    expect(explorerMarkOf(explorerIndexOf([entryOf('dir/a', 'conflicted')]), 'dir/a', false)?.kind).toBe('conflict')
  })
  it('scope mapping excludes siblings and respects segment boundaries', () => {
    expect(explorerPathOf('sub/a', 'sub')).toBe('a')
    expect(explorerPathOf('submarine/a', 'sub')).toBeNull()
    expect(explorerPathOf('a', '.')).toBe('a')
    expect(scopeEntriesOf([entryOf('sub/a'), entryOf('other/b')], 'sub').map((e) => e.path)).toEqual(['a'])
  })
  it('rejects empty, failed and truncated CLI output', () => {
    expect(statusXmlValid(XML)).toBe(true)
    for (const output of ['', 'svn: E170013', XML.slice(0, -9), '<diff></diff>']) expect(statusXmlValid(output)).toBe(false)
  })
  it('tree conflict on otherwise-normal content never appears green', () => {
    const xml = '<status><entry path="dir"><wc-status item="normal" props="none" tree-conflicted="true"/></entry></status>'
    const index = explorerIndexOf(parseStatusXml(xml).entries)
    expect(explorerMarkOf(index, 'dir', true)?.kind).toBe('conflict')
  })
  it('remote properties-only changes are not discarded', () => {
    const xml = '<status><entry path="sub/a"><repos-status item="none" props="modified"/></entry><against revision="9"/></status>'
    expect(parseRemoteStatusXml(xml, join('/wc'))).toEqual({ outdated: [{ path: 'sub/a', item: 'modified' }], againstRev: 9, truncated: false })
  })
})

describe('svn.explorerStatus and remoteStatus RPC', () => {
  it('offline scan is verbose and scoped; cached scans share results', async () => {
    const host = hostOf(XML)
    const one = await host.handlers['svn.explorerStatus']({ sessionId: 's1' })
    await host.handlers['svn.explorerStatus']({ sessionId: 's1' })
    expect(one.ok).toBe(true)
    expect(one.entries[0].path).toBe('a')
    const scans = host.calls.filter((c) => c.argv.includes('status'))
    expect(scans).toHaveLength(1)
    expect(scans[0].argv).toEqual(['svn', '--non-interactive', 'status', '--xml', '--verbose', '--no-ignore', '--', 'sub'])
    expect(scans[0].argv).not.toContain('-u')
    host.dispose()
  })
  it('force bypasses completed cache while simultaneous requests deduplicate', async () => {
    const host = hostOf(XML)
    await Promise.all([host.handlers['svn.explorerStatus']({}), host.handlers['svn.explorerStatus']({})])
    await host.handlers['svn.explorerStatus']({ force: true })
    expect(host.calls.filter((c) => c.argv.includes('status'))).toHaveLength(2)
    host.dispose()
  })
  it('CLI errors and empty inherited output are not clean snapshots', async () => {
    for (const [xml, code] of [['', 0], [XML.slice(0, -9), 0], [XML, 1]] as const) {
      const host = hostOf(xml, code)
      expect((await host.handlers['svn.explorerStatus']({})).ok).toBe(false)
      host.dispose()
    }
  })
  it('remote status uses session prefix and does not update working copy', async () => {
    const host = hostOf('<status><against revision="9"/></status>')
    expect((await host.handlers['svn.remoteStatus']({ path: 'a' })).ok).toBe(true)
    expect(host.calls.at(-1).argv).toEqual(['svn', '--non-interactive', 'status', '-u', '--xml', '--', 'sub/a'])
    expect((await host.handlers['svn.remoteStatus']({ path: '../escape' })).ok).toBe(false)
    host.dispose()
  })
})
