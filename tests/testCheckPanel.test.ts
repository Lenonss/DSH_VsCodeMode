/**
 * 测试验收侧栏面板的纯逻辑（状态文案、按钮可用性、行提示）。
 *
 * 组件本身留在浏览器里验证，这里只锁「什么情况写什么字、按钮能不能点」，
 * 免得以后改文案时把「空内容＝恢复默认」的语义悄悄改掉。
 * @author ddj 2026年11月26号
 */
import { describe, expect, it } from 'vitest'
import {
  canSavePolicy,
  isPolicyOversize,
  mergeSheetCounts,
  policyBytesOf,
  policySaveLabel,
  policySizeText,
  policyStatusText,
  removeConfirmText,
  sheetRowHint,
  sheetTallyOf,
} from '../src/client/testCheckPanelState.js'
import type { TestCheckCounts, TestCheckSheetSummary, TestCheckView } from '../src/shared/testCheck.js'

describe('规范状态行', () => {
  it('用默认规则时说明「保存会写到哪」', () => {
    const text = policyStatusText({ path: '/proj/.dsh/test-check/policy.md', text: 'x', isDefault: true })
    expect(text).toContain('当前使用默认规则')
    expect(text).toContain('/proj/.dsh/test-check/policy.md')
  })

  it('已保存时说明「已保存到」', () => {
    const text = policyStatusText({ path: '/proj/.dsh/test-check/policy.md', text: 'x', isDefault: false })
    expect(text.startsWith('已保存到')).toBe(true)
  })

  it('拿不到路径时说明没有工作区', () => {
    expect(policyStatusText({ path: '', text: '', isDefault: true })).toContain('没有工作区')
  })
})

describe('保存按钮', () => {
  it('空内容时按钮写「恢复默认」', () => {
    expect(policySaveLabel('')).toBe('恢复默认')
    expect(policySaveLabel('  \n ')).toBe('恢复默认')
    expect(policySaveLabel('有内容')).toBe('保存')
  })

  it('没有工作区不能保存', () => {
    expect(canSavePolicy({ cwd: null, draft: '新规则', savedText: '旧规则', isDefault: false })).toBe(false)
    expect(canSavePolicy({ cwd: '', draft: '新规则', savedText: '旧规则', isDefault: false })).toBe(false)
  })

  it('没有改动不能保存', () => {
    expect(canSavePolicy({ cwd: '/proj', draft: '同一份', savedText: '同一份', isDefault: false })).toBe(false)
  })

  it('改了内容可以保存', () => {
    expect(canSavePolicy({ cwd: '/proj', draft: '新规则', savedText: '旧规则', isDefault: false })).toBe(true)
  })

  it('清空内容＝删除自定义规则，仅当已有自定义规则时可点', () => {
    expect(canSavePolicy({ cwd: '/proj', draft: '', savedText: '旧规则', isDefault: false })).toBe(true)
    expect(canSavePolicy({ cwd: '/proj', draft: '', savedText: '默认规则', isDefault: true })).toBe(false)
  })
})

describe('列表行', () => {
  it('计数写成 通过/总数，空单单独提示', () => {
    const counts = { total: 7, pass: 3, fail: 1, blocked: 0, todo: 2, stale: 1 }
    expect(sheetTallyOf(counts)).toBe('3/7')
    expect(sheetTallyOf({ total: 0, pass: 0, fail: 0, blocked: 0, todo: 0, stale: 0 })).toBe('空单')
    expect(sheetTallyOf(null)).toBe('空单')
  })

  it('快照缺失时提示可以移除', () => {
    expect(sheetRowHint(true)).toContain('打开')
    expect(sheetRowHint(false)).toContain('移除')
  })

  it('移除确认里写出两个路径', () => {
    const text = removeConfirmText('设置页', '/proj/.dsh/test-check/settings-ui', '/proj/docs/acceptance-settings-ui.html')
    expect(text).toContain('/proj/.dsh/test-check/settings-ui')
    expect(text).toContain('/proj/docs/acceptance-settings-ui.html')
    expect(text).toContain('不能恢复')
  })
})

describe('规则体积', () => {
  it('按 UTF-8 字节算（中文占 3 字节）', () => {
    expect(policyBytesOf('abc')).toBe(3)
    expect(policyBytesOf('中文')).toBe(6)
    expect(policyBytesOf('')).toBe(0)
  })

  it('上限 8 KB，刚好 8192 不算超', () => {
    expect(isPolicyOversize(8192)).toBe(false)
    expect(isPolicyOversize(8193)).toBe(true)
  })

  it('体积文案带上限，超限时能看出差多少', () => {
    expect(policySizeText(9216)).toBe('9.0 KB / 上限 8 KB')
  })
})

describe('列表计数同步', () => {
  /** 造一行列表数据。 */
  function rowOf(id: string, counts: TestCheckCounts): TestCheckSheetSummary {
    return {
      id,
      title: id,
      counts,
      itemsPath: '/p/.dsh/test-check/' + id + '/items.json',
      snapshotPath: '/p/docs/acceptance-' + id + '.html',
      hasSnapshot: true,
      updatedAt: 1,
    }
  }

  /** 造一个最小视图（只带 id/title/counts）。 */
  function viewOf(id: string, counts: TestCheckCounts): TestCheckView {
    return {
      id,
      title: id,
      root: '/p',
      dir: '/p/.dsh/test-check/' + id,
      state: 'ready',
      itemsPath: '/p/.dsh/test-check/' + id + '/items.json',
      eventsDir: '/p/.dsh/test-check/' + id + '/events',
      groups: [],
      counts,
      ignored: [],
      stamp: 'x',
    }
  }

  const empty = { total: 2, pass: 1, fail: 0, blocked: 0, todo: 1, stale: 0 }

  it('计数没变时返回原数组（不触发重渲染）', () => {
    const rows = [rowOf('a', empty)]
    expect(mergeSheetCounts(rows, viewOf('a', empty))).toBe(rows)
    expect(mergeSheetCounts(rows, null)).toBe(rows)
    expect(mergeSheetCounts(rows, viewOf('other', empty))).toBe(rows)
  })

  it('计数变化时只替换对应那一行', () => {
    const rows = [rowOf('a', empty), rowOf('b', empty)]
    const next = mergeSheetCounts(rows, viewOf('a', { total: 2, pass: 2, fail: 0, blocked: 0, todo: 0, stale: 0 }))
    expect(next).not.toBe(rows)
    expect(next[0].counts.pass).toBe(2)
    expect(next[1]).toBe(rows[1])
  })
})
