/** 只读编辑说明：声明、读取、上限与工具入口。 @author ddj 2026年11月25号 */
import { describe, expect, it, vi } from 'vitest'
import { clearNotes, declareNote, NOTE_MAX, NOTE_SPACE_MAX, noteOf } from '../src/pending/notes.js'
import { noteToolOptions } from '../src/pending/noteTool.js'

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 构造只有 fs 的宿主上下文与固定的工作区投影。
 * @returns 工具选项与上下文
 */
function harness() {
  const fs = {
    resolve: vi.fn(async (path: string, opts: { cwd: string }) => opts.cwd + '/' + path),
    processPath: (target: string) => target,
  }
  const ctx = { get: (name: string) => (name === 'fs' ? fs : undefined) } as never
  return { ctx, fs }
}

describe('只读编辑说明', () => {
  it('按条目身份存取，同一个文件后写的覆盖先写的', () => {
    clearNotes()
    declareNote('/ws', '/ws/a.ts', '改配置默认值')
    expect(noteOf('/ws', '/ws/a.ts')).toBe('改配置默认值')
    declareNote('/ws', '/ws/a.ts', '改配置默认值并补注释')
    expect(noteOf('/ws', '/ws/a.ts')).toBe('改配置默认值并补注释')
    expect(noteOf('/ws', '/ws/b.ts')).toBeUndefined()
    expect(noteOf('/other', '/ws/a.ts')).toBeUndefined()
  })

  it('超长说明被截断，超出上限逐出最旧', () => {
    clearNotes()
    declareNote('/ws', '/ws/long.ts', 'x'.repeat(NOTE_MAX + 50))
    expect(noteOf('/ws', '/ws/long.ts')).toHaveLength(NOTE_MAX)
    for (let index = 0; index < NOTE_SPACE_MAX + 5; index++) declareNote('/ws', '/ws/f' + index + '.ts', 'n')
    expect(noteOf('/ws', '/ws/f0.ts')).toBeUndefined()
    expect(noteOf('/ws', '/ws/f' + (NOTE_SPACE_MAX + 4) + '.ts')).toBe('n')
  })

  it('清空按工作区或全量生效', () => {
    clearNotes()
    declareNote('/ws', '/ws/a.ts', 'n')
    declareNote('/other', '/other/a.ts', 'n')
    clearNotes('/ws')
    expect(noteOf('/ws', '/ws/a.ts')).toBeUndefined()
    expect(noteOf('/other', '/other/a.ts')).toBe('n')
    clearNotes()
    expect(noteOf('/other', '/other/a.ts')).toBeUndefined()
  })

  it('工具入口按会话工作区解析身份并落说明', async () => {
    clearNotes()
    const { ctx } = harness()
    const tool = noteToolOptions(ctx, () => '/ws')
    const result = await tool.execute({ path: 'src/a.ts', note: '为什么改' }, { agent: { session: { id: 's1' } } })
    expect(result).toEqual({ ok: true, path: 'src/a.ts', note: '为什么改' })
    expect(noteOf('/ws', '/ws/src/a.ts')).toBe('为什么改')
  })

  it('工具入口拒绝空参数、超长说明与无工作区会话', async () => {
    clearNotes()
    const { ctx } = harness()
    const tool = noteToolOptions(ctx, () => null)
    expect(await tool.execute({ path: '', note: 'n' }, {})).toMatchObject({ ok: false })
    expect(await tool.execute({ path: 'a.ts', note: 'x'.repeat(NOTE_MAX + 1) }, {})).toMatchObject({ ok: false })
    expect(await tool.execute({ path: 'a.ts', note: 'n' }, {})).toMatchObject({ ok: false })
    expect(noteOf('/ws', '/ws/a.ts')).toBeUndefined()
  })
})
