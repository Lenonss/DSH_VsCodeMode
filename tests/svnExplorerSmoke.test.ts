/** Real disposable local repository; never touches the user's working copy. @author ddj 2026年10月09号 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { parseRemoteStatusXml, parseStatusXml } from '../src/svn.js'
import { statusXmlValid, scopeEntriesOf } from '../src/svnExplorer.js'
import { explorerIndexOf, explorerMarkOf, remoteIndexOf } from '../src/shared/svnExplorer.js'
import { ExplorerQueue } from '../src/svnExplorerCache.js'

const HAS_SVN = spawnSync('svnadmin', ['--version'], { stdio: 'ignore' }).status === 0
  && spawnSync('svn', ['--version', '--quiet'], { stdio: 'ignore' }).status === 0

/** @private @author ddj 2026年10月09号 @param args SVN arguments. @param cwd Scratch directory. @returns Actual CLI output; errors throw. */
function svn(args: string[], cwd: string): string {
  return execFileSync('svn', ['--non-interactive', ...args], { cwd, encoding: 'utf8', timeout: 15_000 })
}
/** @private @author ddj 2026年10月09号 @param scratch Verified temporary directory. @returns Two local working copies at r1. */
function setup(scratch: string) {
  const repo = join(scratch, 'repo'), first = join(scratch, 'first'), second = join(scratch, 'second')
  execFileSync('svnadmin', ['create', repo], { timeout: 15_000 })
  const url = pathToFileURL(repo).href
  svn(['checkout', url, first], scratch)
  mkdirSync(join(first, 'sub'))
  for (const name of ['clean', 'modified', 'remote', 'props']) writeFileSync(join(first, 'sub', name + '.txt'), 'one\n')
  svn(['add', 'sub'], first)
  svn(['commit', '-m', 'initial'], first)
  svn(['checkout', url, second], scratch)
  return { first, second }
}

it.skipIf(!HAS_SVN)('real SVN verbose local status and explicit remote status identify overlays without update', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-svn-icons-'))
  const expected = resolve(tmpdir()) + '\\dsh-svn-icons-'
  try {
    const { first, second } = setup(scratch)
    writeFileSync(join(first, 'sub', 'modified.txt'), 'local\n')
    svn(['propset', 'test:flag', 'yes', 'sub/props.txt'], first)
    writeFileSync(join(first, 'sub', 'new.txt'), 'not versioned\n')
    writeFileSync(join(second, 'sub', 'remote.txt'), 'remote revision\n')
    svn(['commit', '-m', 'remote change'], second)
    const before = svn(['info', '--show-item', 'revision', 'sub/remote.txt'], first)
    const localXml = svn(['status', '--xml', '--verbose', '--no-ignore', '--', 'sub'], first)
    expect(statusXmlValid(localXml)).toBe(true)
    const entries = scopeEntriesOf(parseStatusXml(localXml).entries, 'sub')
    const index = explorerIndexOf(entries)
    expect(explorerMarkOf(index, 'clean.txt', false)?.kind).toBe('clean')
    expect(explorerMarkOf(index, 'modified.txt', false)?.kind).toBe('modified')
    expect(explorerMarkOf(index, 'props.txt', false)?.kind).toBe('modified')
    expect(explorerMarkOf(index, 'new.txt', false)?.kind).toBe('unversioned')
    const remoteXml = svn(['status', '-u', '--xml', '--', 'sub'], first)
    expect(statusXmlValid(remoteXml)).toBe(true)
    const remote = parseRemoteStatusXml(remoteXml, first)
    expect(remote.againstRev).toBe(2)
    expect(remoteIndexOf(remote.outdated).get('sub/remote.txt')).toBe(1)
    expect(svn(['info', '--show-item', 'revision', 'sub/remote.txt'], first)).toBe(before)
  } finally {
    const target = resolve(scratch)
    const prefix = process.platform === 'win32' ? expected : resolve(tmpdir()) + '/dsh-svn-icons-'
    if (!target.startsWith(prefix)) throw new Error('Unexpected scratch cleanup target: ' + target)
    rmSync(target, { recursive: true, force: true })
  }
}, 30_000)

/** @private @author ddj 2026年10月10号 @param queue Scratch owner. @returns Final confirmed generation, or assertion timeout. */
async function settled(queue: ExplorerQueue): Promise<void> {
  await expect.poll(() => queue.state().complete, { timeout: 5000, interval: 25 }).toBe(true)
}

it.skipIf(!HAS_SVN)('real scoped queue replaces renamed/deleted/ignored paths and downgrades the last dirty ancestor', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-svn-icons-'))
  let queue: ExplorerQueue | undefined
  try {
    const { first } = setup(scratch)
    /** @private @author ddj 2026年10月10号 @param roots Session-relative subtrees. @returns Actual scratch CLI snapshot; never touches the user WC. */
    async function scan(roots: readonly string[]) {
      const targets = roots.map((path) => path ? 'sub/' + path : 'sub')
      const xml = svn(['status', '--xml', '--verbose', '--no-ignore', '--', ...targets], first)
      expect(statusXmlValid(xml)).toBe(true)
      return { entries: scopeEntriesOf(parseStatusXml(xml).entries, 'sub'), truncated: false }
    }
    queue = new ExplorerQueue(scan, Date.now, false)
    await queue.initial()
    expect(queue.data.mark('clean.txt', false).mark?.kind).toBe('clean')
    writeFileSync(join(first, 'sub', 'modified.txt'), 'dirty\n')
    queue.invalidate({ paths: ['modified.txt'], event: 'save' })
    await settled(queue)
    expect(queue.data.mark('modified.txt', false).mark?.kind).toBe('modified')
    svn(['revert', 'sub/modified.txt'], first)
    queue.invalidate({ paths: ['modified.txt'], event: 'revert' })
    await settled(queue)
    expect(queue.data.mark('modified.txt', false).mark?.kind).toBe('clean')
    svn(['move', 'sub/clean.txt', 'sub/renamed.txt'], first)
    queue.invalidate({ paths: ['clean.txt', 'renamed.txt'], event: 'rename' })
    await settled(queue)
    expect(queue.data.mark('clean.txt', false).mark?.kind).toBe('deleted')
    expect(queue.data.mark('renamed.txt', false).mark?.kind).toBe('added')
    writeFileSync(join(first, 'sub', 'ignored.tmp'), 'ignored\n')
    svn(['propset', 'svn:ignore', '*.tmp', 'sub'], first)
    queue.invalidate({ full: true, event: 'ignore' })
    await settled(queue)
    expect(queue.data.mark('ignored.tmp', false).mark?.kind).toBe('ignored')
  } finally {
    queue?.dispose()
    const target = resolve(scratch)
    if (!target.startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\dsh-svn-icons-' : '/dsh-svn-icons-'))) {
      throw new Error('Unexpected scratch cleanup target: ' + target)
    }
    rmSync(target, { recursive: true, force: true })
  }
}, 30_000)
