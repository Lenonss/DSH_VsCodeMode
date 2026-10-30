/** Perforce 导入：假 shell 覆盖 opened/status 解析、where 折路径与 #have 基线判定。 @author ddj 2026年10月30号 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectVcsRoot, importVcsChanges } from '../src/pending/vcs.js'

let p4Root = ''

beforeAll(() => {
  p4Root = mkdtempSync(join(tmpdir(), 'edrv-vcs-p4-'))
  writeFileSync(join(p4Root, '.p4config'), 'P4CLIENT=test\n', 'utf8')
  writeFileSync(join(p4Root, 'edit.ts'), 'NEW', 'utf8')
  writeFileSync(join(p4Root, 'fresh.ts'), 'F', 'utf8')
})
afterAll(() => { rmSync(p4Root, { recursive: true, force: true }) })

/** 假命令输出：成功给 stdout，失败给 stderr 与非零码。 */
interface Reply { stdout?: string; stderr?: string; code?: number }

/**
 * @author ddj 2026年10月30号
 * @description: 假 shell：按命令匹配返回预设输出；未命中的命令按失败处理。
 * @param table 命令 → 输出
 * @returns shell 形态对象与调用记录
 */
function fakeShell(table: Array<[RegExp, Reply]>) {
  const calls: string[] = []
  return {
    calls,
    resolve: (request: { command: string }) => request,
    execute: async (spec: unknown) => {
      const command = String((spec as { command: string }).command)
      calls.push(command)
      const hit = table.find(([pattern]) => pattern.test(command))
      const reply = hit ? hit[1] : { stderr: 'boom', code: 1 }
      // 只给 stderr 的用例按失败返回，避免把"没有该版本"当成空内容
      const code = reply.code ?? (reply.stderr ? 1 : 0)
      return {
        result: async () => ({
          exitCode: code,
          timedOut: false, aborted: false,
          stdout: { text: reply.stdout ?? '' }, stderr: { text: reply.stderr ?? '' },
        }),
      }
    },
  }
}

/**
 * @author ddj 2026年10月30号
 * @description: 造一份 `p4 where` 输出，本地路径指向临时目录里的同名文件。
 * @param depot depot 路径
 * @param file 文件名
 * @returns 输出文本
 */
function where(depot: string, file: string): Reply {
  return { stdout: `${depot} //client/${file} ${join(p4Root, file)}\n` }
}

describe('Perforce 导入', () => {
  it('识别 .p4config 所在目录为工作区根', async () => {
    expect(await detectVcsRoot(p4Root)).toEqual({ kind: 'p4', root: p4Root })
  })

  it('opened 里的修改按 #have 基线导入', async () => {
    const shell = fakeShell([
      [/^p4 opened$/, { stdout: '//depot/src/edit.ts#3 - edit default change (text)\n' }],
      [/p4 where "?\/\/depot\/src\/edit\.ts"?/, where('//depot/src/edit.ts', 'edit.ts')],
      [/p4 print -q "?\/\/depot\/src\/edit\.ts#have"?/, { stdout: 'OLD' }],
    ])
    const changes = await importVcsChanges(shell, p4Root)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ earlierVersion: 'file', oldText: 'OLD', newText: 'NEW' })
    expect(changes[0]!.path.endsWith('edit.ts')).toBe(true)
  })

  it('版本里没有该文件时按新建导入，不丢改动', async () => {
    const shell = fakeShell([
      [/^p4 opened$/, { stdout: '//depot/src/fresh.ts#1 - add default change (text)\n' }],
      [/p4 where "?\/\/depot\/src\/fresh\.ts"?/, where('//depot/src/fresh.ts', 'fresh.ts')],
      [/p4 print -q "?\/\/depot\/src\/fresh\.ts#have"?/, { stderr: 'no such file(s) to print' }],
    ])
    const changes = await importVcsChanges(shell, p4Root)
    expect(changes[0]).toMatchObject({ earlierVersion: 'none', oldText: '', newText: 'F' })
  })

  it('删除的文件当前内容为 null', async () => {
    const shell = fakeShell([
      [/^p4 opened$/, { stdout: '//depot/src/gone.ts#2 - delete default change (text)\n' }],
      [/p4 where "?\/\/depot\/src\/gone\.ts"?/, where('//depot/src/gone.ts', 'gone.ts')],
      [/p4 print -q "?\/\/depot\/src\/gone\.ts#have"?/, { stdout: 'x' }],
    ])
    const changes = await importVcsChanges(shell, p4Root)
    expect(changes[0]).toMatchObject({ earlierVersion: 'file', oldText: 'x', newText: null })
  })

  it('基线读取的其它失败一律抛出，不猜不存在', async () => {
    const shell = fakeShell([
      [/^p4 opened$/, { stdout: '//depot/src/edit.ts#3 - edit default change (text)\n' }],
      [/p4 where/, where('//depot/src/edit.ts', 'edit.ts')],
      [/p4 print -q/, { stderr: 'Perforce password (P4PASSWD) invalid or unset' }],
    ])
    await expect(importVcsChanges(shell, p4Root)).rejects.toThrow('读取 p4 基线失败')
  })

  it('未跟踪默认不导入，开启后才跑 p4 status', async () => {
    const opened = [/^p4 opened$/, { stdout: '' }] as [RegExp, Reply]
    const status = [/^p4 status$/, { stdout: `//depot/src/extra.ts - reconcile\n` }] as [RegExp, Reply]
    const off = fakeShell([opened, status, [/p4 where/, where('//depot/src/extra.ts', 'edit.ts')]])
    expect(await importVcsChanges(off, p4Root)).toEqual([])
    expect(off.calls.some((command) => command === 'p4 status')).toBe(false)
    const on = fakeShell([opened, status, [/p4 where/, where('//depot/src/extra.ts', 'edit.ts')], [/p4 print -q/, { stdout: 'OLD' }]])
    expect(await importVcsChanges(on, p4Root, { includeUntracked: true })).toHaveLength(1)
    expect(on.calls.some((command) => command === 'p4 status')).toBe(true)
  })
})
