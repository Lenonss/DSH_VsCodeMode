/**
 * P2-15 shared 文件夹子树聚合（svnFolderStatusOf）测试。
 * 覆盖：嵌套传播 / 计数子树求和与兄弟隔离 / 优先级决胜 / 目录条目只计入祖先 /
 * normal·external·ignored 排除 / 反斜杠容错 / 空清单与根路径。
 * 手法：纯函数直测（shared/svn.ts 无副作用，无需 stub）。
 * 作者 ddj 2026-10-09
 */
import { describe, expect, it } from 'vitest'
import type { SvnChangeEntry } from '../src/shared/svn.js'
import { svnFolderStatusOf } from '../src/shared/svn.js'

/** 一条变更条目（缺省 modified + 受版本控制）。 */
const entry = (path: string, over: Partial<SvnChangeEntry> = {}): SvnChangeEntry => ({
  path, status: 'modified', versioned: true, ...over,
})

describe('svnFolderStatusOf', () => {
  it('嵌套传播：深层文件变更累加到每一级祖先目录', () => {
    const agg = svnFolderStatusOf([entry('a/b/c.ts')])
    expect(agg['a']).toEqual({ status: 'modified', count: 1 })
    expect(agg['a/b']).toEqual({ status: 'modified', count: 1 })
    expect(agg['']).toBeUndefined()
    expect(agg['a/b/c.ts']).toBeUndefined()
  })

  it('计数求和：目录累计子树全部变更，兄弟目录互不污染', () => {
    const agg = svnFolderStatusOf([
      entry('src/a.ts'), entry('src/sub/b.ts'), entry('src/sub/deep/c.ts'), entry('docs/d.md'),
    ])
    expect(agg['src'].count).toBe(3)
    expect(agg['src/sub'].count).toBe(2)
    expect(agg['src/sub/deep'].count).toBe(1)
    expect(agg['docs'].count).toBe(1)
  })

  it('优先级决胜：混合状态取最强（modified+unversioned→modified，加 conflicted→conflicted）', () => {
    const agg = svnFolderStatusOf([
      entry('x/u.txt', { status: 'unversioned', versioned: false }),
      entry('x/m.txt'),
    ])
    expect(agg['x'].status).toBe('modified')
    const agg2 = svnFolderStatusOf([
      entry('x/m.txt'),
      entry('x/u.txt', { status: 'unversioned', versioned: false }),
      entry('x/c.txt', { status: 'conflicted' }),
    ])
    expect(agg2['x'].status).toBe('conflicted')
  })

  it('danger 态优先：deleted 强于 modified', () => {
    const agg = svnFolderStatusOf([entry('p/m.ts'), entry('p/d.ts', { status: 'deleted' })])
    expect(agg['p'].status).toBe('deleted')
    expect(agg['p'].count).toBe(2)
  })

  it('目录条目自身只计入祖先：unversioned 目录给父级聚合、不给自己造表项', () => {
    const agg = svnFolderStatusOf([entry('x/build', { status: 'unversioned', versioned: false })])
    expect(agg['x/build']).toBeUndefined()
    expect(agg['x']).toEqual({ status: 'unversioned', count: 1 })
    expect(agg['']).toBeUndefined()
  })

  it('normal/external/ignored 不参与聚合', () => {
    const agg = svnFolderStatusOf([
      entry('a/b.ts', { status: 'normal' }),
      entry('a/c.ts', { status: 'external' }),
      entry('a/d.ts', { status: 'ignored', versioned: false }),
    ])
    expect(Object.keys(agg)).toEqual([])
  })

  it('反斜杠路径容错（host 已归一，此处防御）', () => {
    const agg = svnFolderStatusOf([entry('a\\b\\c.ts')])
    expect(agg['a/b']).toEqual({ status: 'modified', count: 1 })
  })

  it('空清单返回空表', () => {
    expect(svnFolderStatusOf([])).toEqual({})
  })
})
