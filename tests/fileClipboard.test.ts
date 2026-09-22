/**
 * client/fileClipboard.ts 文件剪贴板单测。
 * 覆盖：copy/cut 单槽写入与覆盖、读取不清空、清空语义（剪切粘贴成功后收尾）。
 * 作者 ddj 2026年09月22号
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { clearFileClip, fileClipOf, setFileClip } from '../src/client/fileClipboard.js'

describe('文件剪贴板单槽', () => {
  beforeEach(() => clearFileClip())

  it('初始为空；set 后 fileClipOf 读到（读取不清空）', () => {
    expect(fileClipOf()).toBeNull()
    setFileClip('copy', 'src/a.ts')
    expect(fileClipOf()).toEqual({ mode: 'copy', path: 'src/a.ts' })
    expect(fileClipOf()).toEqual({ mode: 'copy', path: 'src/a.ts' })
  })

  it('重复写入以最后一次为准（copy 覆盖 cut）', () => {
    setFileClip('cut', 'src/a.ts')
    setFileClip('copy', 'src/b.ts')
    expect(fileClipOf()).toEqual({ mode: 'copy', path: 'src/b.ts' })
  })

  it('cut 模式保留（粘贴执行方据此走移动并清槽）', () => {
    setFileClip('cut', 'docs')
    expect(fileClipOf()?.mode).toBe('cut')
  })

  it('clear 清空槽（剪切粘贴成功后的收尾动作）', () => {
    setFileClip('cut', 'src/a.ts')
    clearFileClip()
    expect(fileClipOf()).toBeNull()
  })
})
