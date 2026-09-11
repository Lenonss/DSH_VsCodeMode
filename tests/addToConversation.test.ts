/**
 * 添加到对话：纯函数（mention/引用载荷/坐标换算）与 ctx 桥（chip 插入、非破坏降级、不可用守卫）。
 *
 * 事故回顾（「连续添加多个引用显示异常」）：旧实现把 **clipboard 投影**长度（`draft.length`）
 * 当作 **detect 投影**坐标传给 insertReference。DSH 的 `$composerLayout()` 里 chip 在 detect
 * 投影中只占 1 个 U+FFFC、在 clipboard 投影中占全文长度，于是草稿里一旦有 chip，坐标就越界，
 * `selectSpan` 返回 null → 插入被拒 → 落入 `setDraft` 兜底，而 setDraft 会整篇重建并剔除
 * U+FFFC → **既有 chip 被销毁、引用退化成重复纯文本**。
 * 本文件钉住：坐标用 detect 投影、降级走 insertText（保留既有 chip）、绝不调用 setDraft。
 * 作者 ddj 2026年08月25号 / 2026年09月11号
 */
import { describe, expect, it, vi } from 'vitest'
import { buildFileRef, createAddToConversation, detectEndOf, detectToClipboardOf, insertOffsetOf, mentionOf, paddingAt, statusOfAdd } from '../src/client/addToConversation.js'

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

/** 假 shell：state + caretSpan/insertReference/insertText/setDraft 记录调用。 */
const makeShell = (snapshot, caret) => {
  const shell = {
    state: { getSnapshot: () => snapshot ?? { draft: '', draftRev: 0 } },
    insertReference: vi.fn(() => true),
    insertText: vi.fn(() => true),
    setDraft: vi.fn(),
  }
  if (caret !== undefined) shell.caretSpan = vi.fn(() => caret)
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

  it('文件夹引用：appearance 为 folder，ref/label 用目录名（缺省外观仍为 file）', () => {
    const dir = buildFileRef('src/components', 'C:/work/app', undefined, 'folder')
    expect(dir.mention).toBe('@src/components')
    expect(dir.reference).toMatchObject({
      source: 'reference',
      ref: '@src/components',
      label: 'components',
      appearance: 'folder',
      clipboardText: '@src/components',
    })
    expect(buildFileRef('src/index.ts', 'C:/work/app').reference.appearance).toBe('file')
  })
})

describe('statusOfAdd', () => {
  it('四态文案映射：ok / busy 降级提示 / failed 重试 / unavailable', () => {
    expect(statusOfAdd('ok', '已添加文件引用')).toBe('已添加文件引用')
    expect(statusOfAdd('busy', '已添加文件引用')).toBe('已添加文件引用（已降级纯文本）')
    expect(statusOfAdd('failed', '已添加文件引用')).toContain('失败')
    expect(statusOfAdd('unavailable', '已添加文件引用')).toContain('无法添加')
  })
})

describe('detectEndOf 坐标换算（clipboard → detect 投影）', () => {
  it('无 chip 时等于 draft 长度（两投影一致）', () => {
    expect(detectEndOf({ draft: 'hello', draftRev: 1 })).toBe(5)
  })

  it('每个 chip 在 clipboard 中多算 length-1，逐个扣回（回归：越界致插入被拒）', () => {
    // 草稿 = chip(68) + ' ' → clipboard 69 字符；detect = 1 + 1 = 2
    expect(detectEndOf({ draft: 'x'.repeat(69), draftRev: 1, occurrences: [{ length: 68 }] })).toBe(2)
  })

  it('多个 chip 累计扣减', () => {
    expect(detectEndOf({ draft: 'x'.repeat(100), draftRev: 1, occurrences: [{ length: 40 }, { length: 30 }] })).toBe(32)
  })

  it('occurrences 缺失（旧版 DSH）退化为 draft 长度 —— 行为兼容', () => {
    expect(detectEndOf({ draft: 'abcd', draftRev: 1 })).toBe(4)
    expect(detectEndOf({ draft: 'abcd', draftRev: 1, occurrences: [] })).toBe(4)
  })

  it('length ≤ 1 或非法值不参与扣减（防负偏移）', () => {
    expect(detectEndOf({ draft: 'abcd', draftRev: 1, occurrences: [{ length: 1 }, { length: 0 }, { length: NaN }, {}] })).toBe(4)
  })

  it('结果不为负（异常输入兜底）', () => {
    expect(detectEndOf({ draft: 'ab', draftRev: 1, occurrences: [{ length: 999 }] })).toBe(0)
  })
})

describe('insertOffsetOf 插入点解析（光标优先，末尾兜底）', () => {
  it('塌缩光标取该位置', () => {
    expect(insertOffsetOf({ start: 3, end: 3 }, 10)).toBe(3)
  })

  it('非塌缩选区取右边界（插入而非替换，不删用户选中内容）', () => {
    expect(insertOffsetOf({ start: 2, end: 5 }, 10)).toBe(5)
  })

  it('caret 缺失/非法一律回落文档末尾（旧行为）', () => {
    expect(insertOffsetOf(null, 10)).toBe(10)
    expect(insertOffsetOf(undefined, 10)).toBe(10)
    expect(insertOffsetOf({}, 10)).toBe(10)
    expect(insertOffsetOf({ start: NaN, end: NaN }, 10)).toBe(10)
    expect(insertOffsetOf({ end: 'x' }, 10)).toBe(10)
    expect(insertOffsetOf('nope', 10)).toBe(10)
  })

  it('end 缺失但 start 有值 → 用 start', () => {
    expect(insertOffsetOf({ start: 4 }, 10)).toBe(4)
  })

  it('越界夹到 [0, detectLength]（坐标会随编辑变化，防越界被拒）', () => {
    expect(insertOffsetOf({ end: 99 }, 10)).toBe(10)
    expect(insertOffsetOf({ end: -3 }, 10)).toBe(0)
  })
})

describe('detectToClipboardOf / paddingAt（插入点两侧空格）', () => {
  it('无 chip：两投影同偏移', () => {
    expect(detectToClipboardOf({ draft: 'abcdef', draftRev: 1 }, 3)).toBe(3)
  })

  it('chip 之前的偏移需要补上 chip 在 clipboard 中多占的长度', () => {
    // chip(clipboard 长度 10, clipboard 起点 0) 之后：detect 1 → clipboard 10
    expect(detectToClipboardOf({ draft: 'x'.repeat(11), draftRev: 1, occurrences: [{ offset: 0, length: 10 }] }, 1)).toBe(10)
  })

  it('末尾行为与旧实现逐字符一致：前非空白 → 前后各补空格（回归）', () => {
    expect(paddingAt({ draft: 'hello', draftRev: 1 }, 5)).toEqual({ lead: true, tail: true })
  })

  it('末尾行为：前已是空白 → 只补尾随空格（回归）', () => {
    expect(paddingAt({ draft: 'hello ', draftRev: 1 }, 6)).toEqual({ lead: false, tail: true })
  })

  it('空草稿 → 不补前导，只补尾随', () => {
    expect(paddingAt({ draft: '', draftRev: 1 }, 0)).toEqual({ lead: false, tail: true })
  })

  it('插在文本中间：两侧都不是空白 → 前后各补（不再贴字）', () => {
    expect(paddingAt({ draft: 'abcd', draftRev: 1 }, 2)).toEqual({ lead: true, tail: true })
  })

  it('插在空白之后、非空白之前 → 只补尾随', () => {
    // 'ab cd' 偏移 3 = ' ' 之后、'c' 之前
    expect(paddingAt({ draft: 'ab cd', draftRev: 1 }, 3)).toEqual({ lead: false, tail: true })
  })

  it('插在非空白之后、空白之前 → 只补前导', () => {
    // 'ab cd' 偏移 2 = 'b' 之后、' ' 之前
    expect(paddingAt({ draft: 'ab cd', draftRev: 1 }, 2)).toEqual({ lead: true, tail: false })
  })
})

describe('createAddToConversation.appendReference', () => {
  it('插入点用光标位置，不再固定追加到末尾（本次调优）', async () => {
    const { shell } = makeShell({ draft: 'hello world', draftRev: 4 }, { start: 5, end: 5 })
    const add = createAddToConversation(makeCtx(shell))
    expect(await add.appendReference('s1', 'src/index.ts')).toBe('ok')
    const span = shell.insertReference.mock.calls[0][1]
    expect(span, '插在光标处而非末尾 11').toEqual({ start: 5, end: 5, draftRev: 4 })
  })

  it('无 caretSpan（旧版 facade）时回落文档末尾 —— 行为兼容', async () => {
    const { shell } = makeShell({ draft: 'hello', draftRev: 2 })
    const add = createAddToConversation(makeCtx(shell))
    expect(await add.appendReference('s1', 'src/index.ts')).toBe('ok')
    expect(shell.insertReference.mock.calls[0][1]).toEqual({ start: 5, end: 5, draftRev: 2 })
  })

  it('caretSpan 抛异常时回落文档末尾（不冒泡）', async () => {
    const { shell } = makeShell({ draft: 'hello', draftRev: 2 })
    shell.caretSpan = () => { throw new Error('locked') }
    const add = createAddToConversation(makeCtx(shell))
    expect(await add.appendReference('s1', 'src/index.ts')).toBe('ok')
    expect(shell.insertReference.mock.calls[0][1]).toEqual({ start: 5, end: 5, draftRev: 2 })
  })

  it('光标在含 chip 的草稿中：detect 坐标直接用，无需换算（caretSpan 已是 detect）', async () => {
    // chip(clipboard 9) + ' ' → detect 长度 2；光标在 detect 0（chip 前）
    const { shell } = makeShell(
      { draft: '@src/a.ts ', draftRev: 8, occurrences: [{ offset: 0, length: 9 }] },
      { start: 0, end: 0 },
    )
    const add = createAddToConversation(makeCtx(shell))
    expect(await add.appendReference('s1', 'src/b.ts')).toBe('ok')
    expect(shell.insertReference.mock.calls[0][1], '插到 chip 前').toEqual({ start: 0, end: 0, draftRev: 8 })
  })

  it('降级纯文本：插在文本中间时前后各补空格（不再与相邻字粘连）', async () => {
    const { shell } = makeShell({ draft: 'ab cd', draftRev: 6 }, { start: 2, end: 2 })
    shell.insertReference.mockReturnValue(false)
    const add = createAddToConversation(makeCtx(shell))
    expect(await add.appendReference('s1', 'src/index.ts')).toBe('busy')
    // 偏移 2：前为 'b'（非空白）→ 补前导；后为 ' '（空白）→ 不补尾随
    expect(shell.insertText).toHaveBeenCalledWith(' @src/index.ts', { start: 2, end: 2, draftRev: 6 })
    expect(shell.setDraft).not.toHaveBeenCalled()
  })

  it('空草稿：chip 插入成功，span 起点为 detect 末尾（0）', async () => {
    const { shell } = makeShell()
    const add = createAddToConversation(makeCtx(shell))
    const outcome = await add.appendReference('s1', 'src/index.ts')
    expect(outcome).toBe('ok')
    expect(shell.insertReference).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'reference', ref: '@src/index.ts', label: 'index.ts' }),
      { start: 0, end: 0, draftRev: 0 },
    )
    expect(shell.setDraft, '绝不整篇重建（会销毁既有 chip）').not.toHaveBeenCalled()
  })

  it('草稿已有 chip：span 用 detect 坐标而非 clipboard 长度（回归：越界导致 chip 被销毁）', async () => {
    // 现场：`@src/a.ts`(9 字符 chip) + ' ' → clipboard 10，detect 2
    const { shell } = makeShell({ draft: '@src/a.ts ', draftRev: 7, occurrences: [{ length: 9 }] })
    const add = createAddToConversation(makeCtx(shell))
    const outcome = await add.appendReference('s1', 'src/b.ts')
    expect(outcome, '第二个引用必须也走 chip 通道成功').toBe('ok')
    const span = shell.insertReference.mock.calls[0][1]
    expect(span, 'detect 末尾 = 1(chip) + 1(空格)').toEqual({ start: 2, end: 2, draftRev: 7 })
    expect(span.start, '不得等于 clipboard 长度 10（那会越界被拒）').not.toBe(10)
    expect(shell.insertText, '未走降级').not.toHaveBeenCalled()
    expect(shell.setDraft).not.toHaveBeenCalled()
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

  it('folder 外观透传：insertReference 载荷 appearance 为 folder', async () => {
    const { shell } = makeShell()
    const add = createAddToConversation(makeCtx(shell))
    await add.appendReference('s1', 'src/components', undefined, 'folder')
    expect(shell.insertReference).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'reference', ref: '@src/components', label: 'components', appearance: 'folder' }),
      expect.anything(),
    )
  })

  it('chip 通道被拒 → 走 insertText 且保留既有 chip（不再 setDraft 整篇重建）', async () => {
    const { shell } = makeShell(
      { draft: '@src/a.ts ', draftRev: 3, occurrences: [{ offset: 0, length: 9 }] },
      { start: 2, end: 2 },
    )
    shell.insertReference.mockReturnValue(false)
    const add = createAddToConversation(makeCtx(shell))
    const outcome = await add.appendReference('s1', 'src/index.ts')
    expect(outcome).toBe('busy')
    // 插入点 detect 2 = chip + 其尾随空格之后；其前在 clipboard 投影里已是空格 → 不补前导
    expect(shell.insertText, '降级走纯文本通道').toHaveBeenCalledWith('@src/index.ts ', { start: 2, end: 2, draftRev: 3 })
    expect(shell.setDraft, '回归：旧实现此处销毁了既有 chip').not.toHaveBeenCalled()
  })

  it('草稿不以空白结尾时降级文本补一个前导空格', async () => {
    // 现场：chip(9) 无尾随空格 → clipboard 9，detect 1
    const { shell } = makeShell({ draft: '@src/a.ts', draftRev: 5, occurrences: [{ length: 9 }] })
    shell.insertReference.mockReturnValue(false)
    const add = createAddToConversation(makeCtx(shell))
    expect(await add.appendReference('s1', 'src/index.ts')).toBe('busy')
    expect(shell.insertText).toHaveBeenCalledWith(' @src/index.ts ', { start: 1, end: 1, draftRev: 5 })
  })

  it('空草稿下 chip 被拒 → insertText 不补前导空格', async () => {
    const { shell } = makeShell()
    shell.insertReference.mockReturnValue(false)
    const add = createAddToConversation(makeCtx(shell))
    expect(await add.appendReference('s1', 'src/index.ts')).toBe('busy')
    expect(shell.insertText).toHaveBeenCalledWith('@src/index.ts ', { start: 0, end: 0, draftRev: 0 })
  })

  it('两条通道都被拒 → failed 且不写任何内容（安全失败，内容不变）', async () => {
    const { shell } = makeShell()
    shell.insertReference.mockReturnValue(false)
    shell.insertText.mockReturnValue(false)
    const add = createAddToConversation(makeCtx(shell))
    expect(await add.appendReference('s1', 'src/index.ts')).toBe('failed')
    expect(shell.setDraft).not.toHaveBeenCalled()
  })

  it('旧版 facade 无 insertText：chip 被拒即 failed（不退回破坏性 setDraft）', async () => {
    const { shell } = makeShell()
    shell.insertReference.mockReturnValue(false)
    delete shell.insertText
    const add = createAddToConversation(makeCtx(shell))
    expect(await add.appendReference('s1', 'src/index.ts')).toBe('failed')
    expect(shell.setDraft).not.toHaveBeenCalled()
  })

  it('insertText 抛异常按未应用处理（不冒泡）', async () => {
    const { shell } = makeShell()
    shell.insertReference.mockReturnValue(false)
    shell.insertText.mockImplementation(() => { throw new Error('locked') })
    const add = createAddToConversation(makeCtx(shell))
    expect(await add.appendReference('s1', 'src/index.ts')).toBe('failed')
  })

  it('无会话/无输入门面时返回 unavailable 且不调用任何写路径', async () => {
    const add = createAddToConversation({ get: () => undefined })
    expect(await add.appendReference('s1', 'x')).toBe('unavailable')
    const add2 = createAddToConversation(makeCtx(makeShell().shell))
    expect(await add2.appendReference(undefined, 'x')).toBe('unavailable')
  })
})
