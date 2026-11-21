// @ts-nocheck
/**
 * 原生提交单测（22-agent-tools-and-commit）。
 * 守护：只提交仍处变更态的路径、自动 add/delete、argv 形状（--encoding/-F/--）、
 * 冲突不擅自提交、最近信息往返。
 * @author ddj 2026年11月15号
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitEntriesOf, createSvnCommit, messageErrorOf, pushRecent, readRecent } from '../src/svnCommit.js'
import { SVN_READONLY_CODE } from '../src/shared/svn.js'

const changes = [
  { path: 'a.txt', status: 'modified', versioned: true },
  { path: 'b.txt', status: 'unversioned', versioned: false },
  { path: 'c.txt', status: 'missing', versioned: true },
  { path: 'd.txt', status: 'conflicted', versioned: true },
  { path: 'e.txt', status: 'normal', versioned: true },
]

/** 构造提交能力替身。 */
function makeCommit(overrides = {}) {
  const calls = []
  const commit = createSvnCommit({
    run: async (cwd, argv) => {
      calls.push(argv)
      if (argv[0] === 'commit') return { code: 0, stdout: 'Sending a.txt\nAdding b.txt\nDeleting c.txt\nCommitted revision 42.', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
    scopeOf: async () => ({ cwd: '/w', root: '/w' }),
    changesOf: async () => ({ entries: changes, truncated: false }),
    invalidate: () => {},
    targetOf: (cwd, root, rel) => rel,
    readOnly: () => false,
    defaults: () => ({ autoAdd: true, autoDelete: true }),
    ...overrides,
  })
  return { commit, calls }
}

describe('提交输出解析', () => {
  it('解析英文与中文逐文件动作', () => {
    const entries = commitEntriesOf('Sending        a.txt\nAdding b.txt\nDeleting c.txt\n正在发送 d.txt')
    expect(entries.map((item) => item.action + ':' + item.path)).toEqual(['M:a.txt', 'A:b.txt', 'D:c.txt', 'M:d.txt'])
  })
})

describe('提交信息校验', () => {
  it('空信息拒绝，超长拒绝', () => {
    expect(messageErrorOf('  ')).toBe('提交信息不能为空')
    expect(messageErrorOf('x'.repeat(9000))).toContain('最长')
    expect(messageErrorOf('fix: ok')).toBeNull()
  })
})

describe('最近提交信息', () => {
  let home = ''
  const previous = process.env.DSH_HOME
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-commit-msg-'))
    process.env.DSH_HOME = home
  })
  afterEach(() => {
    process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })

  it('写入后读回，去重上浮', async () => {
    await pushRecent('/w', 'fix: one')
    await pushRecent('/w', 'fix: two')
    await pushRecent('/w', 'fix: one')
    expect(await readRecent('/w')).toEqual(['fix: one', 'fix: two'])
  })

  it('缺失文件返回空表而不是抛错', async () => {
    expect(await readRecent('/no-such-root')).toEqual([])
  })
})

describe('提交执行', () => {
  it('只提交变更态路径；自动 add/delete；argv 形状正确', async () => {
    const { commit, calls } = makeCommit()
    const outcome = await commit.commitOf({ paths: ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'], message: 'fix: 提交\n\n正文' })
    expect(outcome.ok).toBe(true)
    expect(outcome.revision).toBe(42)
    expect(outcome.entries).toHaveLength(3)
    expect(outcome.conflicts).toEqual(['d.txt'])
    expect(outcome.skipped).toEqual(['e.txt'])

    const add = calls.find((argv) => argv[0] === 'add')
    const del = calls.find((argv) => argv[0] === 'delete')
    expect(add).toEqual(['add', '--', 'b.txt'])
    expect(del).toEqual(['delete', '--', 'c.txt'])

    const commitArgv = calls.find((argv) => argv[0] === 'commit')
    expect(commitArgv).toContain('--encoding')
    expect(commitArgv).toContain('utf-8')
    expect(commitArgv).toContain('-F')
    expect(commitArgv.slice(-4)).toEqual(['--', 'a.txt', 'b.txt', 'c.txt'])
  })

  it('自动整理关闭时把未版本化/缺失文件列为跳过', async () => {
    const { commit, calls } = makeCommit({ defaults: () => ({ autoAdd: false, autoDelete: false }) })
    const outcome = await commit.commitOf({ paths: ['a.txt', 'b.txt', 'c.txt'], message: 'fix: x', autoAdd: false, autoDelete: false })
    expect(outcome.ok).toBe(true)
    expect(outcome.skipped.sort()).toEqual(['b.txt', 'c.txt'])
    expect(calls.some((argv) => argv[0] === 'add')).toBe(false)
  })

  it('只读模式拒绝提交（带稳定码）', async () => {
    const { commit } = makeCommit({ readOnly: () => true })
    const outcome = await commit.commitOf({ paths: ['a.txt'], message: 'fix: x' })
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe(SVN_READONLY_CODE)
  })

  it('无勾选 / 全部无变更时拒绝且不 spawn', async () => {
    const { commit, calls } = makeCommit()
    expect((await commit.commitOf({ paths: [], message: 'fix: x' })).ok).toBe(false)
    const onlyNormal = await commit.commitOf({ paths: ['e.txt'], message: 'fix: x' })
    expect(onlyNormal.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('提交失败时收集冲突并给出可读原因', async () => {
    const { commit } = makeCommit({
      run: async (cwd, argv) => (argv[0] === 'commit'
        ? { code: 1, stdout: '', stderr: 'svn: E155015: remains in conflict' }
        : { code: 0, stdout: '', stderr: '' }),
    })
    const outcome = await commit.commitOf({ paths: ['a.txt'], message: 'fix: x' })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('冲突')
  })
})
