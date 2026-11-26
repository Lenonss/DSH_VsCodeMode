/**
 * 测试验收模式：页面渲染器（完整文档、转义、无脚本、导出页脚、建单引导）。
 * @author ddj 2026年11月25号
 */
import { describe, expect, it } from 'vitest'
import { deriveSheetView, emptyView, type TestCheckView } from '../src/shared/testCheck.js'
import { escapeHtml, itemsTemplateOf, renderSheetHtml, timeTextOf, verdictToneOf } from '../src/shared/testCheckHtml.js'

/** 造一份有两条用例的视图。 */
function readyView(): TestCheckView {
  return deriveSheetView({
    id: 'settings-ui',
    title: '设置页',
    root: '/repo',
    dir: '/repo/.dsh/test-check/settings-ui',
    itemsPath: '/repo/.dsh/test-check/settings-ui/items.json',
    eventsDir: '/repo/.dsh/test-check/settings-ui/events',
    definition: {
      items: [
        { id: 's.a.001', title: '开关切换后立即生效', group: '设置' },
        { id: 's.a.002', title: '重置按钮恢复默认', group: '设置' },
      ],
    },
    events: [
      { file: '1.json', at: 1, event: { item: 's.a.001', status: 'pass', at: '2026-11-25T10:12:03.000Z', evidence: { summary: 'vitest 12/12' } } },
      { file: '2.json', at: 2, event: { item: 's.a.002', status: 'fail', evidence: { summary: '断言失败', command: 'npx vitest run' } } },
    ],
  })
}

/** 造一份「还没建单」的视图。 */
function missingView(): TestCheckView {
  return emptyView({
    id: 'settings-ui',
    root: '/repo',
    dir: '/repo/.dsh/test-check/settings-ui',
    itemsPath: '/repo/.dsh/test-check/settings-ui/items.json',
    eventsDir: '/repo/.dsh/test-check/settings-ui/events',
  }, 'missing')
}

describe('renderSheetHtml', () => {
  it('输出完整单文件 HTML，含标题、汇总与用例行', () => {
    const html = renderSheetHtml(readyView())
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('设置页')
    expect(html).toContain('data-state="ready"')
    expect(html).toContain('s.a.001')
    expect(html).toContain('开关切换后立即生效')
    expect(html).toContain('vitest 12/12')
    expect(html).toContain('失败')
    expect(html).toContain('设置')
  })

  it('不引入脚本（沙箱 iframe 与导出都靠它安全）', () => {
    const html = renderSheetHtml(readyView())
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror=')
  })

  it('动态文本一律转义，注入标签不会变成元素', () => {
    const view = readyView()
    view.title = '<img src=x onerror=alert(1)>'
    const html = renderSheetHtml(view)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img src=x')
  })

  it('导出时附页脚，页签模式不附', () => {
    const plain = renderSheetHtml(readyView())
    const exported = renderSheetHtml(readyView(), { exported: true, at: new Date(Date.UTC(2026, 10, 25, 12, 0, 0)) })
    expect(exported).toContain('导出快照')
    expect(exported).toContain('2026-11-25T12:00:00.000Z')
    expect(plain).not.toContain('导出快照')
  })

  it('缺定义时给建单引导与模板', () => {
    const html = renderSheetHtml(missingView())
    expect(html).toContain('还没有验收单')
    expect(html).toContain('items.json')
    expect(html).toContain('&quot;items&quot;')
  })

  it('定义有错时逐条列出原因', () => {
    const view = emptyView({
      id: 'settings-ui',
      root: '/repo',
      dir: '/repo/.dsh/test-check/settings-ui',
      itemsPath: '/repo/.dsh/test-check/settings-ui/items.json',
      eventsDir: '/repo/.dsh/test-check/settings-ui/events',
    }, 'invalid', '第 2 条：重复 ID a.b.001\n第 3 条：title 不能为空')
    const html = renderSheetHtml(view)
    expect(html).toContain('校验没通过')
    expect(html).toContain('重复 ID a.b.001')
    expect(html).toContain('title 不能为空')
  })

  it('被忽略的事件文件会在页脚提示', () => {
    const view = missingView()
    view.ignored = [{ file: 'bad.json', reason: '不是合法 JSON' }]
    const html = renderSheetHtml(view)
    expect(html).toContain('已忽略 1 个事件文件')
    expect(html).toContain('bad.json')
  })
})

describe('渲染小工具', () => {
  it('escapeHtml 覆盖五个危险字符', () => {
    expect(escapeHtml('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })

  it('时间格式化：ISO 显示为 MM-DD HH:mm，坏值原样返回', () => {
    const text = timeTextOf('2026-11-25T10:12:03.000Z')
    expect(text).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(timeTextOf('not-a-date')).toBe('not-a-date')
    expect(timeTextOf('')).toBe('')
  })

  it('条目模板包含单子 id 与 version', () => {
    const template = itemsTemplateOf('settings-ui')
    expect(template).toContain('"id": "settings-ui"')
    expect(template).toContain('"version": 1')
    expect(() => JSON.parse(template)).not.toThrow()
  })

  it('每种派生状态都有配色类', () => {
    const view = readyView()
    const tones = view.groups.flatMap((group) => group.items.map((item) => verdictToneOf(item)))
    expect(tones.every((tone) => ['ok', 'bad', 'warn', 'stale', 'dim'].includes(tone))).toBe(true)
  })
})
