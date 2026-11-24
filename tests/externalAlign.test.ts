/** 版本库补扫：候选、基线、预算与降级。 @author ddj 2026年11月24号 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alignExternal, ALIGN_BUDGET } from '../src/pending/externalAlign.js'
import type { AlignDeps, VcsScope } from '../src/pending/externalAlign.js'
import { entryFromNew } from '../src/pending/kernel.js'
import type { StoredEntry } from '../src/pending/persist.js'
import type { PendingWrite } from '../src/pending/capture.js'
import { pathKeyOf } from '../src/pending/provenance.js'

let workspace = ''

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'edrv-align-'))
  mkdirSync(join(workspace, '.git'))
})
afterAll(() => { rmSync(workspace, { recursive: true, force: true }) })

/**
 * @description: 假 shell：按命令返回预设输出，未命中即失败。
 * @param table 命令正则 → 输出
 * @returns shell 形态对象与调用记录
 */
function fakeShell(table: Array<[RegExp, string]>) {
  const calls: string[] = []
  return {
    calls,
    resolve: (request: unknown) => request,
    execute: async (spec: unknown) => {
      const command = String((spec as { command: string }).command)
      calls.push(command)
      const hit = table.find(([pattern]) => pattern.test(command))
      return {
        result: async () => ({
          exitCode: hit ? 0 : 1, timedOut: false, aborted: false,
          stdout: { text: hit ? hit[1] : '' }, stderr: { text: hit ? '' : 'boom' },
        }),
      }
    },
  }
}

/** 造一条已落库条目。 */
function storedOf(path: string, newText: string, missing = false): StoredEntry {
  return {
    entry: entryFromNew({ id: path, path, sessionId: 's1', earlierVersion: 'file', oldText: 'OLD', newText, updatedAt: 1 }),
    flags: { missing, diverged: false, oversized: false, revision: 1 },
  }
}

/**
 * @description: 组装补扫依赖：磁盘内容表 + 条目表 + 写入收集。
 * @param files 绝对路径 → 内容（缺省视为不存在）
 * @param entries 已知条目
 * @returns 依赖与写入记录
 */
function deps(files: Record<string, string>, entries: StoredEntry[] = []) {
  const writes: PendingWrite[] = []
  const known = new Map(entries.map((stored) => [pathKeyOf(stored.entry.id), stored]))
  const value: AlignDeps = {
    read: async (absolute) => (absolute in files ? files[absolute]! : null),
    record: (write) => writes.push(write),
    entries: () => known,
  }
  return { value, writes }
}

/** 版本库作用域桩。 */
function scopeOf(shell: ReturnType<typeof fakeShell>): VcsScope {
  return { shell: shell as never, cwd: workspace, sessionId: 's1' }
}

describe('版本库补扫', () => {
  it('已跟踪的修改没有条目时用版本库基线补录，来源记为 scan', async () => {
    const path = join(workspace, 'src', 'a.ts')
    const shell = fakeShell([
      [/status --porcelain/, ' M src/a.ts\0'],
      [/git cat-file -s HEAD:"src\/a.ts"/, '5\n'],
      [/git show HEAD:"src\/a.ts"/, 'BASE'],
    ])
    const { value, writes } = deps({ [path]: 'NOW' })
    const outcome = await alignExternal(scopeOf(shell), value)
    expect(outcome.imported).toBe(1)
    expect(writes[0]).toMatchObject({ path, before: 'BASE', after: 'NOW', tool: 'scan', origin: 'external', baseKind: 'vcs' })
  })

  it('已有条目时用条目内容当基线，不读版本库', async () => {
    const path = join(workspace, 'src', 'b.ts')
    const shell = fakeShell([[/status --porcelain/, ' M src/b.ts\0']])
    const { value, writes } = deps({ [path]: 'NOW' }, [storedOf(path, 'KNOWN')])
    await alignExternal(scopeOf(shell), value)
    expect(writes[0]).toMatchObject({ before: 'KNOWN', baseKind: 'known' })
    expect(shell.calls.some((command) => command.includes('git show'))).toBe(false)
  })

  it('内容与已知条目一致时不补录', async () => {
    const path = join(workspace, 'src', 'c.ts')
    const shell = fakeShell([[/status --porcelain/, ' M src/c.ts\0']])
    const { value, writes } = deps({ [path]: 'KNOWN' }, [storedOf(path, 'KNOWN')])
    const outcome = await alignExternal(scopeOf(shell), value)
    expect(outcome.imported).toBe(0)
    expect(writes).toHaveLength(0)
  })

  it('未跟踪文件按"基线不存在"补录；删除按 after=null 补录', async () => {
    const added = join(workspace, 'new.txt')
    const gone = join(workspace, 'gone.txt')
    const shell = fakeShell([[/status --porcelain/, '?? new.txt\0 D gone.txt\0']])
    const { value, writes } = deps({ [added]: 'X' }, [storedOf(gone, 'GONE')])
    const outcome = await alignExternal(scopeOf(shell), value)
    expect(outcome.imported).toBe(2)
    expect(writes.find((write) => write.path === added)).toMatchObject({ before: null, after: 'X', baseKind: 'absent' })
    expect(writes.find((write) => write.path === gone)).toMatchObject({ before: 'GONE', after: null, baseKind: 'known' })
  })

  it('基线读取超出预算时标 unknown 并写缺口', async () => {
    const paths: Record<string, string> = {}
    const lines: string[] = []
    for (let index = 0; index < 3; index++) {
      const path = join(workspace, 'many', `m${index}.ts`)
      paths[path] = 'NOW'
      lines.push(` M many/m${index}.ts\0`)
    }
    const shell = fakeShell([
      [/status --porcelain/, lines.join('')],
      [/git show HEAD:/, 'BASE'],
    ])
    const { value } = deps(paths)
    const outcome = await alignExternal(scopeOf(shell), value, { ...ALIGN_BUDGET, baselines: 1 })
    expect(outcome.imported).toBe(3)
    expect(outcome.gaps.some((gap) => gap.includes('基线读取预算已用尽'))).toBe(true)
  })

  it('候选条数超预算时只处理前 N 条并写缺口', async () => {
    const paths: Record<string, string> = {}
    const lines: string[] = []
    for (let index = 0; index < 5; index++) {
      const path = join(workspace, 'cap', `c${index}.ts`)
      paths[path] = 'NOW'
      lines.push(` M cap/c${index}.ts\0`)
    }
    const shell = fakeShell([[/status --porcelain/, lines.join('')], [/git show HEAD:/, 'BASE']])
    const { value, writes } = deps(paths)
    const outcome = await alignExternal(scopeOf(shell), value, { ...ALIGN_BUDGET, paths: 2 })
    expect(writes).toHaveLength(2)
    expect(outcome.changed).toBe(5)
    expect(outcome.gaps.some((gap) => gap.includes('只处理前 2 个'))).toBe(true)
  })

  it('超过截止时间就停下，并说明剩余改动留到下一轮（大仓降级）', async () => {
    const paths: Record<string, string> = {}
    const lines: string[] = []
    for (let index = 0; index < 20; index++) {
      const path = join(workspace, 'big', `b${index}.ts`)
      paths[path] = 'NOW'
      lines.push(` M big/b${index}.ts\0`)
    }
    const shell = fakeShell([[/status --porcelain/, lines.join('')], [/git show HEAD:/, 'BASE']])
    const base = deps(paths, [])
    const slow: AlignDeps = { ...base.value, read: async (absolute) => { await new Promise((resolve) => setTimeout(resolve, 5)); return base.value.read(absolute) } }
    const started = Date.now()
    const outcome = await alignExternal(scopeOf(shell), slow, { ...ALIGN_BUDGET, deadlineMs: 1 })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(outcome.imported).toBeLessThan(20)
    expect(outcome.gaps.some((gap) => gap.includes('超过 1ms'))).toBe(true)
  })

  it('没有 shell 能力时降级为只对齐已记录条目', async () => {    const path = join(workspace, 'plain.txt')
    const { value, writes } = deps({ [path]: 'NEW' }, [storedOf(path, 'OLD')])
    const outcome = await alignExternal(null, value)
    expect(outcome.imported).toBe(1)
    expect(writes[0]).toMatchObject({ before: 'OLD', after: 'NEW', tool: 'scan' })
    expect(outcome.gaps[0]).toContain('没有 shell 能力')
  })

  it('版本库状态命令失败时同样降级并说明原因', async () => {
    const path = join(workspace, 'plain2.txt')
    const shell = fakeShell([]) // 任何命令都失败
    const { value, writes } = deps({ [path]: 'NEW' }, [storedOf(path, 'OLD')])
    const outcome = await alignExternal(scopeOf(shell), value)
    expect(outcome.gaps[0]).toContain('版本库状态不可用')
    expect(writes).toHaveLength(1)
  })

  it('svn 工作副本：解析 status --xml 并按 BASE 补录', async () => {
    const svnRoot = mkdtempSync(join(tmpdir(), 'edrv-align-svn-'))
    try {
      mkdirSync(join(svnRoot, '.svn'))
      writeFileSync(join(svnRoot, 'a.ts'), 'NOW', 'utf8')
      const shell = fakeShell([
        [/svn status --xml/, '<?xml version="1.0"?><status><target path="."><entry path="a.ts"><wc-status item="modified"/></entry></target></status>'],
        [/svn cat -r BASE/, 'BASE'],
      ])
      const { value, writes } = deps({ [join(svnRoot, 'a.ts')]: 'NOW' })
      const outcome = await alignExternal({ shell: shell as never, cwd: svnRoot, sessionId: 's1' }, value)
      expect(outcome.imported).toBe(1)
      expect(writes[0]).toMatchObject({ before: 'BASE', after: 'NOW', baseKind: 'vcs' })
    } finally {
      rmSync(svnRoot, { recursive: true, force: true })
    }
  })
})
