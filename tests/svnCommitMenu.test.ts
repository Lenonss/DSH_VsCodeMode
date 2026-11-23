// @ts-nocheck
/**
 * 提交窗口右键菜单条目的投影测试。
 * 守护两件事：单选/多选/信息框各给哪些条目；菜单对象缺失或条目缺失时不得抛异常
 * （抛穿渲染层会让整个 EditorView 被卸载——右键后弹窗与编辑页一起白屏）。
 * @author ddj 2026年11月21号
 */
import { describe, expect, it } from 'vitest'
import { commitMenuEntriesOf } from '../src/client/ui/SvnCommitDialog.js'

const view = {
  busy: false,
  aiBusy: false,
  checked: new Set(['a.cs']),
  message: 'fix: 修复',
  toggle: () => {},
  rowAction: () => {},
  setPickChecked: () => {},
  notify: () => {},
}
const entry = { path: 'a.cs', status: 'modified', versioned: true }

describe('提交窗口右键菜单条目', () => {
  it('单选行：核对 / 打开 / 勾选 / 写动作 / 复制逐项齐全', () => {
    const entries = commitMenuEntriesOf(view, { kind: 'row', entry, paths: ['a.cs'] })
    expect(entries.map((item) => item.id)).toEqual(['compare', 'log', 'open', 'parent', 'toggle', 'add', 'revert', 'copy'])
    expect(entries.find((item) => item.id === 'revert').danger).toBe(true)
    expect(entries.find((item) => item.id === 'toggle').label).toBe('取消勾选此项')
  })

  it('多选行：只给批量勾选与批量复制，破坏性动作不下放', () => {
    const entries = commitMenuEntriesOf(view, { kind: 'row', entry, paths: ['a.cs', 'b.txt'] })
    expect(entries.map((item) => item.id)).toEqual(['pick-on', 'pick-off', 'copy'])
    expect(entries[2].label).toBe('复制 2 条路径')
  })

  it('未版本控制行：加入可用、还原置灰', () => {
    const entries = commitMenuEntriesOf(view, { kind: 'row', entry: { path: 'n.txt', status: 'unversioned', versioned: false }, paths: ['n.txt'] })
    expect(entries.find((item) => item.id === 'add').disabled).toBe(false)
    expect(entries.find((item) => item.id === 'revert').disabled).toBe(true)
  })

  it('提交进行中：写动作与勾选全部置灰', () => {
    const entries = commitMenuEntriesOf({ ...view, busy: true }, { kind: 'row', entry, paths: ['a.cs'] })
    expect(['toggle', 'add', 'revert', 'compare', 'log'].every((id) => entries.find((item) => item.id === id).disabled)).toBe(true)
  })

  it('菜单目标缺失或缺条目时返回空表而不是抛异常', () => {
    expect(commitMenuEntriesOf(view, null)).toEqual([])
    expect(commitMenuEntriesOf(view, { kind: 'row', entry: null, paths: [] })).toEqual([])
    expect(commitMenuEntriesOf(view, { kind: 'msg', node: null, start: 0, end: 0 })).toHaveLength(6)
  })
})
