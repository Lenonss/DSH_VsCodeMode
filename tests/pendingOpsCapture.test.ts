/** dsh-ops 写工具的待审采集：单目标、成对与批量替换。 @author ddj 2026年11月09号 */
import { describe, expect, it, vi } from 'vitest'
import { installPending, pendingGaps } from '../src/pending/capture.js'

const CWD = '/current'

/**
 * @private
 * @author ddj 2026年11月09号
 * @description: 构造工作区投影、可控文件与可选候选搜索，不依赖宿主路径语法。
 * @param search 注入的候选搜索实现；缺省不注入
 * @returns 采集上下文、文件表与调用入口
 */
function harness(search?: unknown) {
  const files = new Map<string, string>([['/current/a.ts', 'A'], ['/current/b.ts', 'B']])
  const fs = {
    resolve: vi.fn(async (path: string, opts: { cwd: string }) => {
      const merged = path.startsWith('/') ? path : opts.cwd + '/' + path
      return merged.replace(/\/\.$/, '')
    }),
    processPath: (target: string) => target,
    readBytes: async (target: string) => {
      if (!files.has(target)) throw Object.assign(new Error('missing'), { code: 'FS_NOT_FOUND' })
      return Buffer.from(files.get(target)!, 'utf8')
    },
  }
  let handler: any
  const ctx: any = {
    get: (name: string) => (name === 'fs' ? fs : name === 'workingDirectory' ? { get: () => CWD } : undefined),
    on: (event: string, listener: any) => {
      if (event === 'tools/execute') handler = listener
    },
  }
  const sink = vi.fn()
  const capture = installPending(ctx, sink, search ? { search: search as never } : undefined)
  const run = (name: string, args: Record<string, unknown>, next: () => Promise<unknown>) =>
    handler({ id: name, name, arguments: args, agent: { session: { id: 's1' } } }, next)
  return { fs, files, sink, capture, run }
}

/**
 * @private
 * @author ddj 2026年11月09号
 * @description: 候选搜索桩：命中写在搜索根下的指定文件。
 * @param paths 相对搜索根的命中路径
 * @returns 可注入的搜索函数
 */
function searcherOf(paths: string[]) {
  return vi.fn(async () => ({ matches: paths.map((path) => ({ path, line: 1, startColumn: 1, endColumn: 2, text: 'A' })), truncated: false, complete: true, source: 'ripgrep' as const }))
}

describe('dsh-ops 待审采集', () => {
  it('ops_edit_file 采集真实前后内容', async () => {
    const fixture = harness()
    const result = await fixture.run('ops_edit_file', { path: 'a.ts' }, async () => {
      fixture.files.set('/current/a.ts', 'B')
      return 'edited'
    })
    expect(result).toBe('edited')
    expect(fixture.sink).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.ts', identity: '/current/a.ts', before: 'A', after: 'B' }))
  })

  it('内容未变的写入不落库', async () => {
    const fixture = harness()
    await fixture.run('ops_write_file', { path: 'a.ts', content: 'A' }, async () => 'same')
    expect(fixture.sink).not.toHaveBeenCalled()
  })

  it('ops_write_file 新建文件以 null 作为预像', async () => {
    const fixture = harness()
    await fixture.run('ops_write_file', { path: 'c.ts' }, async () => {
      fixture.files.set('/current/c.ts', 'C')
      return 'created'
    })
    expect(fixture.sink).toHaveBeenCalledWith(expect.objectContaining({ path: 'c.ts', before: null, after: 'C' }))
  })

  it('ops_remove 以 null 作为后像', async () => {
    const fixture = harness()
    await fixture.run('ops_remove', { path: 'a.ts' }, async () => {
      fixture.files.delete('/current/a.ts')
      return 'removed'
    })
    expect(fixture.sink).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.ts', before: 'A', after: null }))
  })

  it('ops_move 单次调用采集源删除与目标新增', async () => {
    const fixture = harness()
    await fixture.run('ops_move', { path: 'a.ts', to: 'c.ts' }, async () => {
      fixture.files.delete('/current/a.ts')
      fixture.files.set('/current/c.ts', 'A2')
      return 'moved'
    })
    expect(fixture.sink).toHaveBeenCalledTimes(2)
    expect(fixture.sink).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.ts', before: 'A', after: null }))
    expect(fixture.sink).toHaveBeenCalledWith(expect.objectContaining({ path: 'c.ts', before: null, after: 'A2' }))
  })

  it('ops_replace 采集预读命中文件，回执里未预读到的路径只记 gap', async () => {
    const search = searcherOf(['a.ts', 'b.ts'])
    const fixture = harness(search)
    await fixture.run('ops_replace', { path: '.', pattern: 'A', glob: [] }, async () => {
      fixture.files.set('/current/a.ts', 'X1')
      fixture.files.set('/current/b.ts', 'X2')
      return { value: { items: [{ path: 'a.ts', status: 'completed' }, { path: 'b.ts', status: 'completed' }, { path: 'c.ts', status: 'completed' }] } }
    })
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ root: CWD, query: 'A', matchCase: true, regex: false }))
    expect(fixture.sink).toHaveBeenCalledTimes(2)
    expect(fixture.sink).toHaveBeenCalledWith(expect.objectContaining({ path: '/current/a.ts', before: 'A', after: 'X1' }))
    expect(fixture.sink).toHaveBeenCalledWith(expect.objectContaining({ path: '/current/b.ts', before: 'B', after: 'X2' }))
    expect(pendingGaps(CWD).some((gap) => gap.startsWith('c.ts: 未预读基线'))).toBe(true)
  })

  it('候选搜索失败不改变工具结果，只留 gap', async () => {
    const search = vi.fn(async () => { throw new Error('ripgrep 不可用') })
    const fixture = harness(search)
    const result = await fixture.run('ops_replace', { path: '.', pattern: 'A' }, async () => 'tool-result')
    expect(result).toBe('tool-result')
    expect(fixture.sink).not.toHaveBeenCalled()
    expect(pendingGaps(CWD).some((gap) => gap.includes('ripgrep 不可用'))).toBe(true)
  })

  it('dryRun 不预读候选也不产生条目', async () => {
    const search = searcherOf(['a.ts'])
    const fixture = harness(search)
    expect(await fixture.run('ops_replace', { path: '.', pattern: 'A', dryRun: true }, async () => 'preview')).toBe('preview')
    expect(search).not.toHaveBeenCalled()
    expect(fixture.sink).not.toHaveBeenCalled()
    expect(fixture.fs.resolve).not.toHaveBeenCalled()
  })

  it('未声明的 ops 工具不参与采集', async () => {
    const fixture = harness()
    expect(await fixture.run('ops_bash', { pattern: 'echo' }, async () => 'ran')).toBe('ran')
    expect(fixture.sink).not.toHaveBeenCalled()
    expect(fixture.fs.resolve).not.toHaveBeenCalled()
  })
})
