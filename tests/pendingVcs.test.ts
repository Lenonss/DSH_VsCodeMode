/** 版本库导入：用假 shell 覆盖 git/svn 状态解析与基线判定。 @author ddj 2026年10月30号 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectVcsRoot, importVcsChanges } from '../src/pending/vcs.js'

let gitRoot = ''
let svnRoot = ''

beforeAll(() => {
  gitRoot = mkdtempSync(join(tmpdir(), 'edrv-vcs-git-'))
  mkdirSync(join(gitRoot, '.git'))
  svnRoot = mkdtempSync(join(tmpdir(), 'edrv-vcs-svn-'))
  mkdirSync(join(svnRoot, '.svn'))
  writeFileSync(join(gitRoot, 'edit.ts'), 'NEW', 'utf8')
  writeFileSync(join(gitRoot, 'fresh.ts'), 'F', 'utf8')
  writeFileSync(join(svnRoot, 'changed.ts'), 'S2', 'utf8')
})
afterAll(() => {
  rmSync(gitRoot, { recursive: true, force: true })
  rmSync(svnRoot, { recursive: true, force: true })
})

/**
 * @author ddj 2026年10月30号
 * @description: 假 shell：按命令前缀返回预设输出，并假定命令成功。
 * @param table 命令 → 输出
 * @returns shell 形态对象与调用记录
 */
function fakeShell(table: Array<[RegExp, string]>) {
  const calls: string[] = []
  return {
    calls,
    resolve: (request: { command: string }) => request,
    execute: async (spec: unknown) => {
      const command = String((spec as { command: string }).command)
      calls.push(command)
      const hit = table.find(([pattern]) => pattern.test(command))
      const text = hit ? hit[1] : ''
      const exitCode = hit ? 0 : 1
      return {
        result: async () => ({
          exitCode, timedOut: false, aborted: false,
          stdout: { text }, stderr: { text: hit ? '' : 'boom' },
        }),
      }
    },
  }
}

describe('版本库导入', () => {
  it('识别 git 根并按基线导入修改、删除、未跟踪', async () => {
    const shell = fakeShell([
      [/cat-file -s HEAD:"gone.ts"/, '1\n'],
      [/git show HEAD:"edit.ts"/, 'OLD'],
      [/git show HEAD:"gone.ts"/, 'x'],
      [/status --porcelain/, ' M edit.ts\0 D gone.ts\0?? fresh.ts\0'],
    ])
    const changes = await importVcsChanges(shell, gitRoot, { includeUntracked: true })
    expect(changes.map((change) => change.path.split(/[\\/]/).pop()).sort())
      .toEqual(['edit.ts', 'fresh.ts', 'gone.ts'])
    const edit = changes.find((change) => change.path.endsWith('edit.ts'))!
    expect(edit).toMatchObject({ earlierVersion: 'file', oldText: 'OLD', newText: 'NEW' })
    const gone = changes.find((change) => change.path.endsWith('gone.ts'))!
    expect(gone).toMatchObject({ earlierVersion: 'file', oldText: 'x', newText: null })
    const fresh = changes.find((change) => change.path.endsWith('fresh.ts'))!
    expect(fresh).toMatchObject({ earlierVersion: 'none', oldText: '', newText: 'F' })
  })

  it('默认不导入未跟踪文件', async () => {
    const shell = fakeShell([
      [/git show HEAD:"edit.ts"/, 'OLD'],
      [/status --porcelain/, ' M edit.ts\0?? fresh.ts\0'],
    ])
    const changes = await importVcsChanges(shell, gitRoot)
    expect(changes.map((change) => change.path.split(/[\\/]/).pop())).toEqual(['edit.ts'])
  })

  it('基线确实不存在时按新建导入，其它 git 失败一律抛出', async () => {
    // show 以非"版本里没有"的错误退出：必须抛出，不能猜成新建
    const broken = fakeShell([
      [/status --porcelain/, ' M edit.ts\0'],
    ])
    broken.resolve = (request: { command: string }) => request
    await expect(importVcsChanges(broken, gitRoot)).rejects.toThrow(/读取 git 基线失败/)

    const missing = fakeShell([
      [/status --porcelain/, ' M edit.ts\0'],
    ])
    const patched = {
      ...missing,
      execute: async (spec: unknown) => {
        const command = String((spec as { command: string }).command)
        if (command.includes('git show')) {
          return {
            result: async () => ({
              exitCode: 128, timedOut: false, aborted: false,
              stdout: { text: '' }, stderr: { text: 'fatal: path does not exist in HEAD' },
            }),
          }
        }
        return missing.execute(spec)
      },
    }
    const changes = await importVcsChanges(patched as never, gitRoot)
    expect(changes[0]).toMatchObject({ earlierVersion: 'none', oldText: '', newText: 'NEW' })
  })

  it('识别 svn 根并解析 status --xml', async () => {
    const shell = fakeShell([
      [/svn cat -r BASE/, 'S1'],
      [/svn status --xml/, '<?xml version="1.0"?><status><target path="."><entry path="changed.ts"><wc-status item="modified"/></entry></target></status>'],
    ])
    expect(await detectVcsRoot(svnRoot)).toMatchObject({ kind: 'svn' })
    const changes = await importVcsChanges(shell, svnRoot)
    expect(changes).toEqual([
      { path: join(svnRoot, 'changed.ts'), earlierVersion: 'file', oldText: 'S1', newText: 'S2' },
    ])
  })

  it('非版本库目录返回空列表且不执行命令', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'edrv-vcs-plain-'))
    const shell = fakeShell([])
    expect(await detectVcsRoot(plain)).toBeUndefined()
    expect(await importVcsChanges(shell, plain)).toEqual([])
    expect(shell.calls).toHaveLength(0)
    rmSync(plain, { recursive: true, force: true })
  })
})
