/** Monaco model 路径归一化纯函数测试（编辑器切换断点与面板新增断点共用口径）。作者 ddj 2026年09月21号 */
import { describe, expect, it } from 'vitest'
import { editorModelPathOf } from '../src/client/dap/modelPath.js'

/** 构造最小编辑器替身。 */
function fakeEditor(uriPath?: string) {
  return { getModel: () => (uriPath === undefined ? null : { uri: { path: uriPath } }) }
}

describe('editorModelPathOf', () => {
  it('取 uri.path 并去首斜杠', () => {
    expect(editorModelPathOf(fakeEditor('/D:/Work/a.lua'))).toBe('D:/Work/a.lua')
  })

  it('decodeURIComponent 还原中文路径', () => {
    expect(editorModelPathOf(fakeEditor('/D:/%E6%B8%B8%E6%88%8F/a.lua'))).toBe('D:/游戏/a.lua')
  })

  it('无 model / 无 uri.path / 无编辑器返回 null', () => {
    expect(editorModelPathOf(fakeEditor())).toBeNull()
    expect(editorModelPathOf(fakeEditor(undefined))).toBeNull()
    expect(editorModelPathOf({})).toBeNull()
    expect(editorModelPathOf(null)).toBeNull()
    expect(editorModelPathOf(undefined)).toBeNull()
  })
})
