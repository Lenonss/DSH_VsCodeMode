import React from 'react'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { ReviewAllConfirm } from '../src/client/ui/ReviewAllConfirm.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Modal: vi.fn(), Button: vi.fn() }))

describe('workspace review confirmation', () => {
  it.each([false, true])('uses the DSH modal with explicit action and count (reject=%s)', (reject) => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const dialog = ReviewAllConfirm({ reject, count: 4, onCancel, onConfirm })
    const props = dialog.props as any
    expect(props.open).toBe(true)
    expect(props.title).toBe((reject ? 'Undo All' : 'Keep All') + ' 确认')
    expect(props.description).toContain('全部 4 个待审差异文件（含其他轮次）')
    expect(props.children.props.children).toContain(reject ? '撤销会改写磁盘' : '不改写文件')
    expect(onConfirm).not.toHaveBeenCalled()

    props.onClose()
    const [cancel, confirm] = props.footer.props.children
    cancel.props.onClick()
    expect(cancel.props.autoFocus).toBe(true)
    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(onConfirm).not.toHaveBeenCalled()
    confirm.props.onClick()
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('routes both batch actions through confirmation and checks the opening session lifetime', () => {
    const source = readFileSync(new URL('../src/client/ui/EditorView.ts', import.meta.url), 'utf8')
    const batch = source.slice(source.indexOf('async function actReviewAll('), source.indexOf('const rollbackFile ='))
    expect(batch).not.toContain('window.confirm')
    expect(batch).toContain('const acceptAllFiles = () => askReviewAll(false)')
    expect(batch).toContain('const undoAllFiles = () => askReviewAll(true)')
    expect(batch).toContain('if (!prompt?.token?.live || prompt.token !== reviewLifeRef.current) return')
    expect(batch).toContain('return actReviewAll(prompt.reject)')
    expect(source).toContain('onCancel: cancelReviewAll, onConfirm: confirmReviewAll')
  })
})
