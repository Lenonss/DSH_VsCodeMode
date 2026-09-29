/**
 * 全局搜索面板的文件范围开关契约。
 * 作者 ddj 2026-09-29
 */
import { describe, expect, it } from 'vitest'
import { searchIncludes } from '../src/client/sidebar/panels/SearchPanel.js'

describe('search panel file scope', () => {
  it('does not search the workspace when only-current-file has no active file', () => {
    expect(searchIncludes(true, null, '*.ts')).toBeNull()
  })

  it('updates the included file when the active file changes', () => {
    expect(searchIncludes(true, 'src/first.ts', '*.lua')).toEqual(['src/first.ts'])
    expect(searchIncludes(true, 'src/second.ts', '*.lua')).toEqual(['src/second.ts'])
  })

  it('restores the include patterns when only-current-file is disabled', () => {
    expect(searchIncludes(false, null, '*.ts, src/**/include')).toEqual(['*.ts', 'src/**/include'])
  })
})
