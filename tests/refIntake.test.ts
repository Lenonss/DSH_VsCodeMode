/**
 * 引用接入的同步判定测试：拖拽载荷识别、粘贴意图判定（不需要真实 DOM）。
 * @author ddj 2026年11月15号
 */
import { describe, expect, it } from 'vitest'
import { DRAG_MIME, MAX_INSERT_REFS, dragRefItems, isRefDrop, pasteIntent } from '../src/client/refIntake.js'

/** 造一个最小 DataTransfer 替身。 */
function transfer(types: string[], data: Record<string, string> = {}, files: unknown[] = []) {
  return {
    types,
    files,
    getData: (type: string) => data[type] ?? '',
    setData: () => {},
    dropEffect: 'none',
  }
}

describe('拖拽载荷', () => {
  it('识别内部路径 MIME 与系统文件', () => {
    expect(isRefDrop(transfer([DRAG_MIME]))).toBe(true)
    expect(isRefDrop(transfer(['Files']))).toBe(true)
    expect(isRefDrop(transfer(['text/plain']))).toBe(false)
    expect(isRefDrop(undefined)).toBe(false)
  })

  it('解析内部路径载荷（含行范围）', () => {
    const items = dragRefItems(transfer([DRAG_MIME], { [DRAG_MIME]: JSON.stringify({ path: 'src/a.ts', range: { startLine: 3, endLine: 5 } }) }))
    expect(items).toEqual([{ path: 'src/a.ts', range: { startLine: 3, endLine: 5 } }])
  })

  it('非法 JSON 不抛错；系统文件按文件名兜底', () => {
    expect(dragRefItems(transfer([DRAG_MIME], { [DRAG_MIME]: '{oops' }))).toEqual([])
    const items = dragRefItems(transfer(['Files'], {}, [{ name: 'a.ts' }, { name: '' }]))
    expect(items).toEqual([{ path: 'a.ts', range: undefined }])
  })

  it('超出上限的拖入项被截断', () => {
    const files = Array.from({ length: MAX_INSERT_REFS + 3 }, (_, index) => ({ name: 'f' + index + '.ts' }))
    expect(dragRefItems(transfer(['Files'], {}, files))).toHaveLength(MAX_INSERT_REFS)
  })
})

describe('粘贴意图', () => {
  it('@ 开头的文本按引用处理', () => {
    expect(pasteIntent(transfer(['text/plain'], { 'text/plain': '  @src/a.ts L3-L5 ' }))).toBe('ref')
  })

  it('普通文本放行原生粘贴', () => {
    expect(pasteIntent(transfer(['text/plain'], { 'text/plain': 'const a = 1' }))).toBeNull()
    expect(pasteIntent(transfer(['text/plain'], { 'text/plain': 'src/a.ts' }))).toBeNull()
    expect(pasteIntent(undefined)).toBeNull()
  })

  it('非图片文件按文件处理；纯图片放行（走 DSH 附件）', () => {
    expect(pasteIntent(transfer(['Files'], {}, [{ name: 'a.ts', type: 'text/plain' }]))).toBe('file')
    expect(pasteIntent(transfer(['Files'], {}, [{ name: 'a.png', type: 'image/png' }]))).toBeNull()
  })
})
