/**
 * 添加到对话：纯函数（mention/引用载荷）与 ctx 桥（chip 插入、忙态降级、不可用守卫）。
 * 作者 ddj 2026年08月25号
 */
import { describe, expect, it, vi } from 'vitest'
import { buildFileRef, createAddToConversation, mentionOf } from '../src/client/addToConversation.js'

/** 构造假 ctx：sessions.scope + conversation.input.for 返回假 shell。 */
const makeCtx = (shell) => ({
  get: (name) => {
    if (name === 'sessions') {
      return {
        scope: () => ({ fake: true }),
        list: { getSnapshot: () => ({ byId: { s1: { cwd: 'C:/work/app' } } }) },
      }
    }
    if (name === 'conversation') return { input: { for: () => shell } }
    return undefined
  },
})

/** 假 shell：state + insertReference/setDraft/notify 记录调用。 */
const makeShell = () => {
  const shell = {
    state: { getSnapshot: () => ({ draft: '', draftRev: 0 }) },
    insertReference: vi.fn(() => true),
    setDraft: vi.fn(),
    notify: vi.fn(),
  }
  return { shell }
}

describe('mentionOf', () => {
  it('相对路径直接生成 @ 引用', () => {
    expect(mentionOf('src/index.ts', 'C:/work/app')).toBe('@src/index.ts')
  })

  it('反斜杠路径与绝对路径统一相对化', () => {
    expect(mentionOf('src\\index.ts', 'C:/work/app')).toBe('@src/index.ts')
    expect(mentionOf('C:/work/app/src/index.ts', 'C:/work/app')).toBe('@src/index.ts')
  })

  it('含空白路径按 @"path" 语法转义', () => {
    expect(mentionOf('my file.ts', 'C:/work/app')).toBe('@"my file.ts"')
  })

  it('无 cwd 或 cwd 外路径回退原路径', () => {
    expect(mentionOf('src/index.ts', undefined)).toBe('@src/index.ts')
    expect(mentionOf('D:/other/x.ts', 'C:/work/app')).toBe('@D:/other/x.ts')
  })
})

describe('buildFileRef', () => {
  it('整文件引用载荷', () => {
    const { reference, mention } = buildFileRef('src/index.ts', 'C:/work/app')
    expect(mention).toBe('@src/index.ts')
    expect(reference).toMatchObject({
      source: 'reference',
      ref: '@src/index.ts',
      label: 'index.ts',
      appearance: 'file',
      clipboardText: '@src/index.ts',
    })
  })

  it('行区间引用：多行 Lstart-end / 单行 Lstart', () => {
    const multi = buildFileRef('src/index.ts', 'C:/work/app', { startLine: 10, endLine: 20 })
    expect(multi.reference.ref).toBe('@src/index.ts L10-20')
    expect(multi.reference.label).toBe('index.ts L10-20')
    const single = buildFileRef('src/index.ts', 'C:/work/app', { startLine: 5, endLine: 5 })
    expect(single.reference.ref).toBe('@src/index.ts L5')
    expect(single.reference.label).toBe('index.ts L5')
  })
})

describe('createAddToConversation.appendReference', () => {
  it('chip 插入成功：span 取草稿末尾 + 当前 draftRev', async () => {
    const { shell } = makeShell()
    const add = createAddToConversation(makeCtx(shell))
    const outcome = await add.appendReference('s1', 'src/index.ts')
    expect(outcome).toBe('ok')
    expect(shell.insertReference).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'reference', ref: '@src/index.ts', label: 'index.ts' }),
      { start: 0, end: 0, draftRev: 0 },
    )
    expect(shell.setDraft).not.toHaveBeenCalled()
    expect(shell.notify).toHaveBeenCalledWith('info', expect.stringContaining('@src/index.ts'))
  })

  it('带行区间时引用载荷含 L 区间', async () => {
    const { shell } = makeShell()
    const add = createAddToConversation(makeCtx(shell))
    await add.appendReference('s1', 'src/index.ts', { startLine: 10, endLine: 20 })
    expect(shell.insertReference).toHaveBeenCalledWith(
      expect.objectContaining({ ref: '@src/index.ts L10-20', label: 'index.ts L10-20' }),
      expect.anything(),
    )
  })

  it('忙态（insertReference 拒绝）降级为纯文本 setDraft', async () => {
    const { shell } = makeShell()
    shell.insertReference.mockReturnValue(false)
    const add = createAddToConversation(makeCtx(shell))
    const outcome = await add.appendReference('s1', 'src/index.ts')
    expect(outcome).toBe('busy')
    expect(shell.setDraft).toHaveBeenCalledWith('@src/index.ts ')
  })

  it('已有草稿且无尾随空白时补一个空格再降级', async () => {
    const { shell } = makeShell()
    shell.insertReference.mockReturnValue(false)
    shell.state.getSnapshot = () => ({ draft: 'hello', draftRev: 3 })
    const add = createAddToConversation(makeCtx(shell))
    await add.appendReference('s1', 'src/index.ts')
    expect(shell.setDraft).toHaveBeenCalledWith('hello @src/index.ts ')
  })

  it('无会话/无输入门面时返回 unavailable 且不调用任何写路径', async () => {
    const add = createAddToConversation({ get: () => undefined })
    expect(await add.appendReference('s1', 'x')).toBe('unavailable')
    const add2 = createAddToConversation(makeCtx(makeShell().shell))
    expect(await add2.appendReference(undefined, 'x')).toBe('unavailable')
  })
})
