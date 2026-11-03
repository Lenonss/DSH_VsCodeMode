/**
 * client downloadPickerModel.ts 纯逻辑单测（懒加载目录树 + 勾选集合，不触 React/DOM）。
 * 覆盖：合并子项（目录优先排序、忽略 other、清理已删子项）、展开/收起、勾选（目录/超限文件忽略）、
 * 全选只作用于已加载、行铺平的深度与顺序、加载态与错误态清除、体积文案。
 * 作者 ddj 2026年11月03号
 */
import { describe, expect, it } from 'vitest'
import type { TreeEntry } from '../src/shared/rpc.js'
import {
  DL_SIZE_CAP, clearSelected, collapseDir, createDlState, expandDir, formatSize, hasLoaded, isExpanded, isOversized,
  loadedFiles, markError, markLoading, mergeChildren, rowList, selectLoaded, selectedFiles, toggleFile,
} from '../src/client/downloadPickerModel.js'
import type { DlState } from '../src/client/downloadPickerModel.js'

/** 构造 TreeEntry（name 取路径末段）。 */
function entry(path: string, type: TreeEntry['type'], size?: number): TreeEntry {
  return { name: path.split('/').pop() || path, path, type, size }
}

/** 已加载根层子项的状态。 */
function stateWith(entries: TreeEntry[], root = ''): DlState {
  return mergeChildren(createDlState(root), root, entries)
}

describe('mergeChildren', () => {
  it('目录优先 + 名称排序，忽略 other，标记已加载', () => {
    const state = stateWith([entry('b.txt', 'file'), entry('a', 'directory'), entry('c', 'other')])
    expect(state.children.get('')).toEqual(['a', 'b.txt'])
    expect(state.nodes.get('a')).toMatchObject({ name: 'a', kind: 'directory' })
    expect(state.nodes.has('c')).toBe(false)
    expect(hasLoaded(state, '')).toBe(true)
  })

  it('带体积的文件保留 size，供界面预判上限', () => {
    const state = stateWith([entry('a.bin', 'file', 12)])
    expect(state.nodes.get('a.bin')?.size).toBe(12)
  })

  it('重新拉取时清理本次已不存在的旧子项（含其勾选）', () => {
    let state = stateWith([entry('old.txt', 'file')])
    state = toggleFile(state, 'old.txt')
    expect(selectedFiles(state)).toEqual(['old.txt'])
    state = mergeChildren(state, '', [entry('new.txt', 'file')])
    expect(state.nodes.has('old.txt')).toBe(false)
    expect(selectedFiles(state)).toEqual([])
  })
})

describe('展开状态', () => {
  it('根目录默认展开，收起后行消失', () => {
    let state = stateWith([entry('a', 'directory'), entry('b.txt', 'file')])
    expect(isExpanded(state, '')).toBe(true)
    expect(rowList(state).map((row) => row.path)).toEqual(['a', 'b.txt'])
    state = collapseDir(state, '')
    expect(rowList(state)).toEqual([])
    state = expandDir(state, '')
    expect(rowList(state).map((row) => row.path)).toEqual(['a', 'b.txt'])
  })

  it('展开子目录后按深度铺平（目录优先，子项缩进 +1）', () => {
    let state = stateWith([entry('src', 'directory'), entry('a.txt', 'file')])
    state = mergeChildren(state, 'src', [entry('src/main.ts', 'file'), entry('src/lib', 'directory')])
    state = expandDir(state, 'src')
    const rows = rowList(state)
    expect(rows.map((row) => [row.path, row.depth])).toEqual([
      ['src', 0],
      ['src/lib', 1],
      ['src/main.ts', 1],
      ['a.txt', 0],
    ])
    expect(rows[0].expanded).toBe(true)
  })

  it('工作区根（root="")也按同一规则展开', () => {
    const state = stateWith([entry('a.txt', 'file')])
    expect(rowList(state).map((row) => row.path)).toEqual(['a.txt'])
  })
})

describe('勾选集合', () => {
  it('文件可勾选，目录忽略，超限文件忽略', () => {
    let state = stateWith([
      entry('a', 'directory'),
      entry('b.txt', 'file'),
      entry('huge.bin', 'file', DL_SIZE_CAP + 1),
    ])
    state = toggleFile(state, 'a')
    expect(selectedFiles(state)).toEqual([])
    state = toggleFile(state, 'b.txt')
    expect(selectedFiles(state)).toEqual(['b.txt'])
    state = toggleFile(state, 'huge.bin')
    expect(selectedFiles(state)).toEqual(['b.txt'])
    state = toggleFile(state, 'b.txt')
    expect(selectedFiles(state)).toEqual([])
  })

  it('全选只覆盖已加载文件，跳过超限文件', () => {
    let state = stateWith([entry('a.txt', 'file'), entry('huge.bin', 'file', DL_SIZE_CAP + 1)])
    state = mergeChildren(state, 'sub', [entry('sub/c.txt', 'file')])
    state = selectLoaded(state)
    expect(selectedFiles(state)).toEqual(['a.txt', 'sub/c.txt'])
    expect(loadedFiles(state)).toEqual(['a.txt', 'huge.bin', 'sub/c.txt'])
  })

  it('清空勾选', () => {
    let state = stateWith([entry('a.txt', 'file')])
    state = clearSelected(selectLoaded(state))
    expect(selectedFiles(state)).toEqual([])
  })
})

describe('加载态与错误态', () => {
  it('markLoading 出加载态，合并结果后清除', () => {
    const loading = markLoading(createDlState(''), '')
    expect(rowList(loading)).toEqual([])
    expect(loading.loading.has('')).toBe(true)
    const done = mergeChildren(loading, '', [entry('a.txt', 'file')])
    expect(done.loading.has('')).toBe(false)
  })

  it('markError 保留主机原文，重新合并后清除', () => {
    let state = markError(createDlState(''), '', '读取目录失败')
    expect(state.errors.get('')).toBe('读取目录失败')
    expect(state.loading.has('')).toBe(false)
    state = mergeChildren(state, '', [entry('a.txt', 'file')])
    expect(state.errors.has('')).toBe(false)
  })
})

describe('体积文案与上限', () => {
  it('按量级切换单位', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(12 * 1024)).toBe('12 KB')
    expect(formatSize(3.4 * 1024 * 1024)).toBe('3.4 MB')
    expect(formatSize(-1)).toBe('')
  })

  it('超过上限判定（缺失体积不预判）', () => {
    expect(isOversized(undefined)).toBe(false)
    expect(isOversized(DL_SIZE_CAP)).toBe(false)
    expect(isOversized(DL_SIZE_CAP + 1)).toBe(true)
  })
})
