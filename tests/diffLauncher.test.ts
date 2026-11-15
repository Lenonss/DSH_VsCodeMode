import { describe, expect, it, vi } from 'vitest'

// DiffLauncher 的归档纯函数与 Univer 无关：mock 掉 Univer UI，避免测试拉入 primitives 的未声明传递依赖
vi.mock('../src/client/univer/UniverHost.js', () => ({ UniverReviews: () => null }))
import { archiveKey, mergeArchives } from '../src/client/ui/DiffLauncher.js'

describe('归档分页视图', () => {
  it('同路径不同批次分别展开，重复页只保留一条', () => {
    const first = { path: '/a.ts', batch: 1 }
    const second = { path: '/a.ts', batch: 2 }
    expect(archiveKey(first)).not.toBe(archiveKey(second))
    expect(mergeArchives([first], [first, second])).toEqual([first, second])
  })

  it('相同批次不同文件与 null 批次不发生键冲突', () => {
    const rows = [{ path: '/a.ts', batch: null }, { path: '/a.ts', batch: 1 }, { path: '/b.ts', batch: 1 }]
    expect(new Set(rows.map(archiveKey)).size).toBe(3)
    expect(mergeArchives(null, rows)).toEqual(rows)
  })
})
