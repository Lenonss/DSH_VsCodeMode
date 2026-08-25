/**
 * client diffDock 纯函数测试（不触 DOM/RPC）。
 * 作者 ddj 2026-08-26
 */
import { describe, expect, it } from 'vitest'
import { diffDockText, displayDiffTotal, editorDockMode, nextDiffPath } from '../src/client/diffDock.js'
import { clearDiffDock, publishDiffDock, readDiffDock, subscribeDiffDock } from '../src/client/diffDockStore.js'

describe('nextDiffPath', () => {
  it('空列表返回 null', () => {
    expect(nextDiffPath([], 0)).toEqual({ path: null, index: 0 })
  })
  it('按顺序循环', () => {
    const paths = ['a.ts', 'b.ts']
    expect(nextDiffPath(paths, 0)).toEqual({ path: 'a.ts', index: 1 })
    expect(nextDiffPath(paths, 1)).toEqual({ path: 'b.ts', index: 0 })
    expect(nextDiffPath(paths, 2)).toEqual({ path: 'a.ts', index: 1 })
  })
  it('非法和负索引安全归一', () => {
    expect(nextDiffPath(['a.ts'], -3)).toEqual({ path: 'a.ts', index: 0 })
    expect(nextDiffPath(['a.ts', 'b.ts'], Number.NaN)).toEqual({ path: 'a.ts', index: 1 })
  })
})

describe('diffDockText', () => {
  it('生成文件数量文案', () => {
    expect(diffDockText(13)).toBe('差异 13 个文件 · 查看下一个')
    expect(diffDockText(-1)).toBe('差异 0 个文件 · 查看下一个')
  })
})

describe('editorDockMode', () => {
  it('文件加载期间保持编辑态', () => {
    expect(editorDockMode('index.ts')).toBe('editor')
  })
  it('无活动文件时使用空态', () => {
    expect(editorDockMode(null)).toBe('editor-empty')
    expect(editorDockMode('')).toBe('editor-empty')
  })
})

describe('displayDiffTotal', () => {
  it('内容就绪时使用精确数量', () => {
    expect(displayDiffTotal(true, 3, 8)).toBe(3)
  })
  it('内容加载期间使用文件摘要数量', () => {
    expect(displayDiffTotal(false, 0, 8)).toBe(8)
  })
  it('非法或负数归一为零', () => {
    expect(displayDiffTotal(false, 0, -2)).toBe(0)
    expect(displayDiffTotal(false, 0, Number.NaN)).toBe(0)
  })
})

describe('diffDockStore', () => {
  it('按会话隔离快照并通知订阅者', () => {
    const source = {}
    let notices = 0
    const stop = subscribeDiffDock('session-store-test', () => { notices++ })
    publishDiffDock('session-store-test', { mode: 'editor', fileTotal: 2 }, source)
    publishDiffDock('other-session-store-test', { mode: 'chat', fileTotal: 1 })
    expect(readDiffDock('session-store-test')?.mode).toBe('editor')
    expect(readDiffDock('other-session-store-test')?.mode).toBe('chat')
    expect(notices).toBe(1)
    clearDiffDock('session-store-test', {})
    expect(readDiffDock('session-store-test')?.mode).toBe('editor')
    clearDiffDock('session-store-test', source)
    expect(readDiffDock('session-store-test')).toBeNull()
    stop()
    clearDiffDock('other-session-store-test')
  })
})
