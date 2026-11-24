/**
 * SVN 窗口行图标的目录判定测试（纯函数）。
 * 用例覆盖：子项推断、待查集去重、分块与总量上限、类型合并、missing 不画目录。
 * @author ddj 2026年11月23号
 */
import { describe, expect, it } from 'vitest'
import { PATH_KINDS_CAP } from '../src/shared/svn.js'
import { KIND_QUERY_MAX, dirsFromChildren, isDirOf, kindCandidatesOf, kindQueryChunksOf, mergeKindsOf } from '../src/client/ui/svnIcons.js'

describe('SVN 窗口行图标的目录判定', () => {
  it('某路径是另一条目的上级目录时判为目录，不在清单里的上级不参与', () => {
    const dirs = dirsFromChildren(['Assets', 'Assets/Art', 'Assets/Art/hero.png', 'Tools/build/x.sh'])
    expect([...dirs].sort()).toEqual(['Assets', 'Assets/Art'])
    expect(dirsFromChildren(['a.txt', 'b/c.txt']).has('b')).toBe(false)
    expect(dirsFromChildren([]).size).toBe(0)
  })

  it('待查集去重去空，并跳过已由子项关系确定的目录', () => {
    const paths = ['Assets/Art/hero.png', 'Assets/Art', 'Assets/New', '', 'Assets/New']
    const dirs = dirsFromChildren(paths)
    expect(kindCandidatesOf(paths, dirs)).toEqual(['Assets/Art/hero.png', 'Assets/New'])
    expect(kindCandidatesOf([], dirs)).toEqual([])
  })

  it('待查路径按 host 单次上限分块，并截到总量上限', () => {
    const few = ['a', 'b', 'c']
    expect(kindQueryChunksOf(few)).toEqual([few])
    expect(kindQueryChunksOf([])).toEqual([])
    const many = Array.from({ length: PATH_KINDS_CAP + 5 }, (_, i) => 'f' + i)
    expect(kindQueryChunksOf(many).map((chunk) => chunk.length)).toEqual([PATH_KINDS_CAP, 5])
    const huge = Array.from({ length: KIND_QUERY_MAX + 50 }, (_, i) => 'g' + i)
    expect(kindQueryChunksOf(huge).flat().length).toBe(KIND_QUERY_MAX)
  })

  it('多块类型表合并后逐条可取，后到覆盖先到', () => {
    const merged = mergeKindsOf({ 'a.txt': 'file' }, { 'b/dir': 'dir', 'a.txt': 'file' })
    expect(merged).toEqual({ 'a.txt': 'file', 'b/dir': 'dir' })
    expect(mergeKindsOf()).toEqual({})
  })

  it('目录判定：子项关系或 host 答 dir 都算目录，missing 与未查到按文件', () => {
    const dirs = new Set(['Assets'])
    const kinds = { 'Assets/New': 'dir', 'Assets/gone': 'missing' } as const
    expect(isDirOf('Assets', dirs, kinds)).toBe(true)
    expect(isDirOf('Assets/New', dirs, kinds)).toBe(true)
    expect(isDirOf('Assets/gone', dirs, kinds)).toBe(false)
    expect(isDirOf('Assets/hero.png', dirs, kinds)).toBe(false)
    expect(isDirOf('Assets/unknown', dirs, {})).toBe(false)
  })
})
