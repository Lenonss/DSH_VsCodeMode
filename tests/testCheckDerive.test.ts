/**
 * 测试验收模式：派生视图与汇总计数（含「无证据 pass」与「需复验」的口径）。
 * @author ddj 2026年11月25号
 */
import { describe, expect, it } from 'vitest'
import {
  deriveSheetView,
  emptyView,
  type DeriveInput,
  type TestCheckEventFile,
} from '../src/shared/testCheck.js'

/** 造一条已读事件。 */
function eventFile(file: string, at: number, item: string, status: string, extra: Record<string, unknown> = {}): TestCheckEventFile {
  return { file, at, event: { item, status: status as never, ...extra } }
}

/** 派生入参的默认值（每个用例只覆盖自己关心的字段）。 */
function input(overrides: Partial<DeriveInput> = {}): DeriveInput {
  return {
    id: 'settings-ui',
    title: '设置页',
    root: '/repo',
    dir: '/repo/.dsh/test-check/settings-ui',
    itemsPath: '/repo/.dsh/test-check/settings-ui/items.json',
    eventsDir: '/repo/.dsh/test-check/settings-ui/events',
    definition: { items: [] },
    events: [],
    ...overrides,
  }
}

describe('deriveSheetView', () => {
  it('五格计数：通过 / 失败 / 阻塞 / 未验 / 需复验，退役条目不参与', () => {
    const view = deriveSheetView(input({
      definition: {
        items: [
          { id: 's.a.001', title: '一键', files: ['a.ts'] },
          { id: 's.a.002', title: '两键' },
          { id: 's.a.003', title: '三键' },
          { id: 's.a.004', title: '退役', retired: true },
          { id: 's.a.005', title: '无证据' },
          { id: 's.a.006', title: '文件变了', files: ['b.ts'] },
        ],
      },
      events: [
        eventFile('1.json', 10, 's.a.001', 'pass', { evidence: { summary: 'vitest 12/12' }, subject: { hash: 'sha256:aaa' } }),
        eventFile('2.json', 11, 's.a.002', 'fail', { evidence: { summary: '断言失败' } }),
        eventFile('3.json', 12, 's.a.003', 'blocked', { evidence: { summary: '缺依赖' } }),
        eventFile('5.json', 13, 's.a.005', 'pass'),
        eventFile('6.json', 14, 's.a.006', 'pass', { evidence: { summary: 'ok' }, subject: { hash: 'sha256:old' } }),
      ],
      hashes: { 's.a.001': 'sha256:aaa', 's.a.006': 'sha256:new' },
    }))
    expect(view.state).toBe('ready')
    expect(view.counts).toEqual({ total: 5, pass: 1, fail: 1, blocked: 1, todo: 1, stale: 1 })
  })

  it('无证据的 pass 归「未验」，且不计入通过', () => {
    const view = deriveSheetView(input({
      definition: { items: [{ id: 's.a.001', title: '一键' }] },
      events: [eventFile('1.json', 10, 's.a.001', 'pass', { evidence: {} })],
    }))
    const row = view.groups[0].items[0]
    expect(row.verdict).toBe('claimed')
    expect(row.counted).toBe(false)
    expect(view.counts.pass).toBe(0)
    expect(view.counts.todo).toBe(1)
  })

  it('skip 归「未验」但行内保留跳过标签', () => {
    const view = deriveSheetView(input({
      definition: { items: [{ id: 's.a.001', title: '一键' }] },
      events: [eventFile('1.json', 10, 's.a.001', 'skip', { evidence: { summary: '本机不支持' } })],
    }))
    expect(view.groups[0].items[0].label).toBe('跳过')
    expect(view.counts.todo).toBe(1)
  })

  it('没有 files 或没有 hash 时不做失效判定', () => {
    const view = deriveSheetView(input({
      definition: { items: [{ id: 's.a.001', title: '一键' }], },
      events: [eventFile('1.json', 10, 's.a.001', 'pass', { evidence: { summary: 'ok' }, subject: { hash: 'sha256:whatever' } })],
      hashes: {},
    }))
    expect(view.counts.stale).toBe(0)
    expect(view.counts.pass).toBe(1)
  })

  it('分组按定义顺序，缺省分组叫「未分组」', () => {
    const view = deriveSheetView(input({
      definition: {
        items: [
          { id: 's.a.001', title: '一', group: '设置' },
          { id: 's.b.001', title: '二' },
          { id: 's.a.002', title: '三', group: '设置' },
        ],
      },
    }))
    expect(view.groups.map((group) => group.name)).toEqual(['设置', '未分组'])
    expect(view.groups[0].items.map((item) => item.id)).toEqual(['s.a.001', 's.a.002'])
  })

  it('事件里带证据与时间时透出到行上', () => {
    const view = deriveSheetView(input({
      definition: { items: [{ id: 's.a.001', title: '一键' }] },
      events: [eventFile('1.json', 10, 's.a.001', 'pass', {
        at: '2026-11-25T10:12:03.000Z',
        evidence: { summary: 'vitest 12/12', command: 'npx vitest run' },
      })],
    }))
    const row = view.groups[0].items[0]
    expect(row.at).toBe('2026-11-25T10:12:03.000Z')
    expect(row.evidence?.summary).toBe('vitest 12/12')
    expect(row.status).toBe('pass')
  })

  it('数据指纹：同样的数据同串，状态一变就变', () => {
    const base = deriveSheetView(input({
      definition: { items: [{ id: 's.a.001', title: '一键' }] },
      events: [eventFile('1.json', 10, 's.a.001', 'fail', { evidence: { summary: 'x' } })],
    }))
    const same = deriveSheetView(input({
      definition: { items: [{ id: 's.a.001', title: '一键' }] },
      events: [eventFile('1.json', 10, 's.a.001', 'fail', { evidence: { summary: 'x' } })],
    }))
    const changed = deriveSheetView(input({
      definition: { items: [{ id: 's.a.001', title: '一键' }] },
      events: [eventFile('1.json', 11, 's.a.001', 'pass', { evidence: { summary: 'x' } })],
    }))
    expect(base.stamp).toBe(same.stamp)
    expect(base.stamp).not.toBe(changed.stamp)
  })

  it('被忽略的事件数量进指纹（页签会提示）', () => {
    const one = deriveSheetView(input({ ignored: [{ file: 'bad.json', reason: '坏 JSON' }] }))
    expect(one.stamp).not.toBe(deriveSheetView(input()).stamp)
    expect(one.ignored).toHaveLength(1)
  })
})

describe('emptyView', () => {
  it('missing 与 invalid 都能渲染，且带上可读原因', () => {
    const missing = emptyView({
      id: 'settings-ui',
      root: '/repo',
      dir: '/repo/.dsh/test-check/settings-ui',
      itemsPath: '/repo/.dsh/test-check/settings-ui/items.json',
      eventsDir: '/repo/.dsh/test-check/settings-ui/events',
    }, 'missing')
    expect(missing.state).toBe('missing')
    expect(missing.groups).toEqual([])
    expect(missing.counts.total).toBe(0)

    const invalid = emptyView({
      id: 'settings-ui',
      root: '/repo',
      dir: '/repo/.dsh/test-check/settings-ui',
      itemsPath: '/repo/.dsh/test-check/settings-ui/items.json',
      eventsDir: '/repo/.dsh/test-check/settings-ui/events',
    }, 'invalid', '第 2 条：重复 ID a.b.001')
    expect(invalid.error).toContain('重复 ID')
    expect(invalid.stamp).not.toBe(missing.stamp)
  })
})
