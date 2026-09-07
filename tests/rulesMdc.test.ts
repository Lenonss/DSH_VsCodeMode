/**
 * client rulesMdc.ts 测试：frontmatter 解析（类型推导/extra 键/BOM/CRLF/YAML globs）/
 * 按类型改写（always/auto/manual 三向、enabled 与 extra 保留、无 frontmatter 边界）。
 * 作者 ddj 2026年09月07号
 */
import { describe, expect, it } from 'vitest'
import { parseRuleFm, applyRuleMeta } from '../src/client/rulesMdc.js'

// --region 解析
describe('parseRuleFm', () => {
  it('alwaysApply: true → 总是；缺省 enabled true；正文保留', () => {
    const parsed = parseRuleFm('---\ndescription: 码风\nalwaysApply: true\n---\n\n正文A\n')
    expect(parsed.hasFm).toBe(true)
    expect(parsed.type).toBe('always')
    expect(parsed.description).toBe('码风')
    expect(parsed.alwaysApply).toBe(true)
    expect(parsed.enabled).toBe(true)
    expect(parsed.hasEnabledLine).toBe(false)
    expect(parsed.body).toBe('\n正文A\n')
  })

  it('内联 globs → 自动', () => {
    const parsed = parseRuleFm('---\ndescription: d\nglobs: src/**/*.ts, *.md\n---\n正文')
    expect(parsed.type).toBe('auto')
    expect(parsed.globs).toEqual(['src/**/*.ts', '*.md'])
  })

  it('YAML 短横 globs 列表 → 自动', () => {
    const parsed = parseRuleFm('---\nglobs:\n  - a.ts\n  - b.ts\n---\n正文')
    expect(parsed.type).toBe('auto')
    expect(parsed.globs).toEqual(['a.ts', 'b.ts'])
  })

  it('无 frontmatter → 手动 / hasFm false / 全文当正文', () => {
    const parsed = parseRuleFm('# 纯 markdown\n')
    expect(parsed.hasFm).toBe(false)
    expect(parsed.type).toBe('manual')
    expect(parsed.body).toBe('# 纯 markdown\n')
  })

  it('无闭合 --- → 整体当正文（不误吞）', () => {
    const text = '---\ndescription: 半截'
    const parsed = parseRuleFm(text)
    expect(parsed.hasFm).toBe(false)
    expect(parsed.body).toBe(text)
  })

  it('enabled: false 识别并记录 hasEnabledLine', () => {
    const parsed = parseRuleFm('---\nenabled: false\n---\n正文')
    expect(parsed.enabled).toBe(false)
    expect(parsed.hasEnabledLine).toBe(true)
  })

  it('未知键进 fmExtra 原样保留', () => {
    const parsed = parseRuleFm('---\ndescription: d\nupdatedAt: 2026-07-30T08:53:14.711Z\nprovider: ---\n---\n正文')
    expect(parsed.fmExtra).toEqual(['updatedAt: 2026-07-30T08:53:14.711Z', 'provider: ---'])
  })

  it('BOM 识别与剥离', () => {
    const parsed = parseRuleFm('\uFEFF---\nalwaysApply: true\n---\n正文')
    expect(parsed.bom).toBe(true)
    expect(parsed.body).toBe('正文')
  })

  it('CRLF 正文按 \n 归一（与 host 解析一致）', () => {
    const parsed = parseRuleFm('---\nalwaysApply: true\n---\r\nA\r\nB\r\n')
    expect(parsed.body).toBe('A\nB\n')
  })
})
// --endregion

// --region 改写
describe('applyRuleMeta', () => {
  it('总是 → 自动：去 alwaysApply、写 globs、描述更新、正文不动', () => {
    const parsed = parseRuleFm('---\ndescription: 旧\nalwaysApply: true\n---\n\n正文\n')
    const next = applyRuleMeta(parsed, { type: 'auto', description: '新', globs: ['src/*.ts'] })
    expect(next).toBe('---\ndescription: 新\nglobs: src/*.ts\n---\n\n正文\n')
  })

  it('自动 → 手动：去 globs 行', () => {
    const parsed = parseRuleFm('---\ndescription: d\nglobs: a.ts\n---\n正文')
    const next = applyRuleMeta(parsed, { type: 'manual', description: 'd', globs: [] })
    expect(next).toBe('---\ndescription: d\n---\n正文')
  })

  it('手动 → 总是：写 alwaysApply: true', () => {
    const parsed = parseRuleFm('---\ndescription: d\n---\n正文')
    const next = applyRuleMeta(parsed, { type: 'always', description: 'd', globs: [] })
    expect(next).toBe('---\ndescription: d\nalwaysApply: true\n---\n正文')
  })

  it('无 frontmatter + 手动 + 无描述 → 原文返回', () => {
    const text = '# 纯 markdown\n'
    const next = applyRuleMeta(parseRuleFm(text), { type: 'manual', description: '', globs: [] })
    expect(next).toBe(text)
  })

  it('无 frontmatter + 手动 + 有描述 → 新建仅含描述的 frontmatter', () => {
    const next = applyRuleMeta(parseRuleFm('# 纯 markdown\n'), { type: 'manual', description: '说明', globs: [] })
    expect(next).toBe('---\ndescription: 说明\n---\n# 纯 markdown\n')
  })

  it('无 frontmatter → 总是：新建 frontmatter + 原正文', () => {
    const next = applyRuleMeta(parseRuleFm('# 纯 markdown\n'), { type: 'always', description: '', globs: [] })
    expect(next).toBe('---\ndescription: \nalwaysApply: true\n---\n# 纯 markdown\n')
  })

  it('enabled: false 改写后保留 false', () => {
    const parsed = parseRuleFm('---\nenabled: false\nalwaysApply: true\n---\n正文')
    const next = applyRuleMeta(parsed, { type: 'always', description: 'd', globs: [] })
    expect(next).toBe('---\ndescription: d\nalwaysApply: true\nenabled: false\n---\n正文')
  })

  it('额外键（updatedAt 等）原样保留', () => {
    const parsed = parseRuleFm('---\ndescription: d\nupdatedAt: 2026-07-30T08:53:14.711Z\n---\n正文')
    const next = applyRuleMeta(parsed, { type: 'auto', description: 'd', globs: ['a.ts'] })
    expect(next).toBe('---\ndescription: d\nglobs: a.ts\nupdatedAt: 2026-07-30T08:53:14.711Z\n---\n正文')
  })

  it('BOM 回填；改写幂等（再次解析/改写结果稳定）', () => {
    const source = '\uFEFF---\ndescription: d\nalwaysApply: true\n---\n正文'
    const parsed = parseRuleFm(source)
    const next = applyRuleMeta(parsed, { type: 'auto', description: 'd', globs: ['a.ts'] })
    expect(next.startsWith('\uFEFF')).toBe(true)
    const again = applyRuleMeta(parseRuleFm(next), { type: 'auto', description: 'd', globs: ['a.ts'] })
    expect(again).toBe(next)
  })

  it('正文含 CRLF 时保存归一为 \n（host rules.save 原样写盘可接受）', () => {
    const parsed = parseRuleFm('---\nalwaysApply: true\n---\r\nA\r\n')
    const next = applyRuleMeta(parsed, { type: 'always', description: '', globs: [] })
    expect(next).toBe('---\ndescription: \nalwaysApply: true\n---\nA\n')
  })
})
// --endregion
