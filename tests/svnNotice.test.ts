/** RPC notification routing, no SVN mutation. @author ddj 2026年10月10号 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bindSvnScope, svnNotice } from '../src/client/svnNotice.js'
const notices: any[] = []
beforeEach(() => {
  const window = new EventTarget()
  vi.stubGlobal('window', window)
  vi.stubGlobal('CustomEvent', class extends Event { detail: unknown; constructor(type: string, args: any) { super(type); this.detail = args.detail } })
  window.addEventListener('edrv:refresh', (e: any) => notices.push(e.detail))
  notices.length = 0; bindSvnScope('one', 'workspace')
})
afterEach(() => vi.unstubAllGlobals())
it('successful known writes carry scope/paths, partial failures and cleanup force full', () => {
  svnNotice('svn.add', { sessionId: 'one', paths: ['sub/a'] }, true)
  svnNotice('svn.revert', { sessionId: 'one', paths: ['sub/a'] }, false)
  svnNotice('svn.cleanup', { sessionId: 'one' }, true)
  expect(notices[0]).toMatchObject({ scope: 'workspace', paths: ['sub/a'], kind: 'svn' })
  expect(notices.slice(1).every((n) => n.paths === undefined)).toBe(true)
  expect(new Set(notices.map((n) => n.eventId)).size).toBe(3)
})
it('unknown sessions invalidate globally without misapplying relative paths; read-only calls never notify', () => {
  svnNotice('svn.add', { sessionId: 'unknown', paths: ['sub/a'] }, true)
  svnNotice('svn.remoteStatus', { sessionId: 'one' }, true)
  svnNotice('svn.tortoise', { sessionId: 'one', action: 'diff', path: 'a' }, true)
  expect(notices).toHaveLength(1)
  expect(notices[0].scope).toBeUndefined(); expect(notices[0].paths).toBeUndefined()
})
