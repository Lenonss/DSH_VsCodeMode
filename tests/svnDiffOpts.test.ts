// @ts-nocheck
/**
 * 只读并排差异编辑器选项（diffOptsOf）单测。
 * 守护：差异视觉三要素不回退——行首 +/- 指示符（renderIndicators + 足宽 lineDecorationsWidth，
 * 8px 会把 16px 的 codicon 裁没）、并排只读形态、滚动条变化色标（renderOverviewRuler）。
 * W1-1/W1-3 增补：视图开关缺省行为与 Monaco 默认一致、EOL 规范化、差异行数统计。
 * 作者 ddj 2026年09月18号 / 2026年09月20号
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_DIFF_VIEW_OPTS, diffOptsOf, diffStatsOf, navTargetOf, normalizeEolOf } from '../src/client/ui/SideBySideDiff.js'

describe('diffOptsOf（差异视图视觉三要素）', () => {
  const opts = diffOptsOf('edrv-dark')

  it('行首 +/- 指示符：renderIndicators 开启且装饰区宽度容纳 16px 图标', () => {
    expect(opts.renderIndicators).toBe(true)
    expect(opts.lineDecorationsWidth).toBeGreaterThanOrEqual(20)
  })

  it('并排只读形态与主题保持既有语义', () => {
    expect(opts.renderSideBySide).toBe(true)
    expect(opts.readOnly).toBe(true)
    expect(opts.originalEditable).toBe(false)
    expect(opts.theme).toBe('edrv-dark')
  })

  it('滚动条变化色标开启（大文件差异定位导航）', () => {
    expect(opts.renderOverviewRuler).toBe(true)
  })

  it('只读审阅附属物保持关闭（minimap/字形栏）', () => {
    expect(opts.minimap).toEqual({ enabled: false })
    expect(opts.glyphMargin).toBe(false)
  })
})

describe('diffOptsOf 视图开关（W1-1）', () => {
  it('缺省 viewOpts 与 Monaco 默认一致（行尾空白忽略开、折叠关）——现状行为不变', () => {
    const def = diffOptsOf('edrv-dark')
    expect(def.ignoreTrimWhitespace).toBe(true)
    expect(def.hideUnchangedRegions).toEqual({ enabled: false })
  })

  it('DEFAULT_DIFF_VIEW_OPTS 与缺省行为等价（选项条默认值守护）', () => {
    expect(DEFAULT_DIFF_VIEW_OPTS).toEqual({ trimWhitespace: true, hideUnchanged: false, eolNormalize: false })
    const opts = diffOptsOf('edrv-dark', DEFAULT_DIFF_VIEW_OPTS)
    expect(opts.ignoreTrimWhitespace).toBe(true)
    expect(opts.hideUnchangedRegions).toEqual({ enabled: false })
  })

  it('开关生效：关行尾空白、开折叠未变更', () => {
    const opts = diffOptsOf('edrv-dark', { trimWhitespace: false, hideUnchanged: true })
    expect(opts.ignoreTrimWhitespace).toBe(false)
    expect(opts.hideUnchangedRegions).toEqual({ enabled: true })
  })
})

describe('normalizeEolOf（W1-1 EOL 规范化）', () => {
  it('CRLF 与孤立 CR 都归一为 LF；纯 LF 原样', () => {
    expect(normalizeEolOf('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
    expect(normalizeEolOf('x\ny\n')).toBe('x\ny\n')
  })

  it('非字符串原样返回（null/undefined 侧照常走空串兜底）', () => {
    expect(normalizeEolOf(null)).toBe(null)
    expect(normalizeEolOf(undefined)).toBe(undefined)
  })
})

describe('diffStatsOf（W1-3 差异行数统计）', () => {
  it('纯新增/纯删除各计一侧（区间空侧 = end < start）', () => {
    const stats = diffStatsOf([
      { originalStartLineNumber: 3, originalEndLineNumber: 2, modifiedStartLineNumber: 3, modifiedEndLineNumber: 7 },
      { originalStartLineNumber: 10, originalEndLineNumber: 12, modifiedStartLineNumber: 10, modifiedEndLineNumber: 9 },
    ])
    expect(stats).toEqual({ added: 5, deleted: 3 })
  })

  it('修改行两侧各计（git diff --stat 口径）', () => {
    const stats = diffStatsOf([
      { originalStartLineNumber: 4, originalEndLineNumber: 6, modifiedStartLineNumber: 4, modifiedEndLineNumber: 6 },
    ])
    expect(stats).toEqual({ added: 3, deleted: 3 })
  })

  it('空清单与异常输入不抛错（nav.list 初值为 []）', () => {
    expect(diffStatsOf([])).toEqual({ added: 0, deleted: 0 })
    expect(diffStatsOf(undefined)).toEqual({ added: 0, deleted: 0 })
    expect(diffStatsOf([{}])).toEqual({ added: 0, deleted: 0 })
  })
})

describe('navTargetOf（顶部 ↑/↓ 跳转目标计算）', () => {
  it('修改与新增走修改侧（修改侧行区间有效即优先）', () => {
    expect(navTargetOf({ originalStartLineNumber: 3, originalEndLineNumber: 3, modifiedStartLineNumber: 3, modifiedEndLineNumber: 3 }))
      .toEqual({ side: 'modified', start: 3, end: 3 })
    expect(navTargetOf({ originalStartLineNumber: 5, originalEndLineNumber: 4, modifiedStartLineNumber: 5, modifiedEndLineNumber: 6 }))
      .toEqual({ side: 'modified', start: 5, end: 6 })
  })

  it('纯删除落原侧（修改侧区间空：end = start - 1）', () => {
    expect(navTargetOf({ originalStartLineNumber: 12, originalEndLineNumber: 12, modifiedStartLineNumber: 12, modifiedEndLineNumber: 11 }))
      .toEqual({ side: 'original', start: 12, end: 12 })
  })

  it('inline 单栏模式纯删除锚到修改侧锚点行（原侧是折叠残留）', () => {
    expect(navTargetOf({ originalStartLineNumber: 12, originalEndLineNumber: 12, modifiedStartLineNumber: 12, modifiedEndLineNumber: 11 }, true))
      .toEqual({ side: 'modified', start: 12, end: 12 })
    expect(navTargetOf({ originalStartLineNumber: 3, originalEndLineNumber: 3, modifiedStartLineNumber: 3, modifiedEndLineNumber: 3 }, true))
      .toEqual({ side: 'modified', start: 3, end: 3 })
  })

  it('异常输入兜底为原侧第 1 行且区间不倒挂', () => {
    expect(navTargetOf(undefined)).toEqual({ side: 'original', start: 1, end: 1 })
    expect(navTargetOf({ originalStartLineNumber: 0, originalEndLineNumber: -2 })).toEqual({ side: 'original', start: 1, end: 1 })
  })
})
