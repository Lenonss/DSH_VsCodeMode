/**
 * `ui_builder_intake` 工具契约测试：名称、参数、成功/失败回执与提示。
 * @author ddj 2026年11月26号
 */
import { describe, expect, it } from 'vitest'
import { toolResultOf, uiIntakeToolOptions } from '../src/uiIntakeTool.js'

describe('ui_builder_intake tool', () => {
  it('工具名与 slug 参数固定，回执是模型可读 JSON', () => {
    const options = uiIntakeToolOptions(() => 'D:/Project')
    expect(options.name).toBe('ui_builder_intake')
    expect(options.parameters.slug.required).toBe(true)
    expect(options.isConcurrencySafe).toBe(false)
    const text = options.output.render({}, toolResultOf({
      ok: true,
      pagePath: 'plans/ui/x/intake/materials.html',
      absolutePath: 'D:/Project/plans/ui/x/intake/materials.html',
      slug: 'x',
    }))
    expect(Array.isArray(text)).toBe(true)
    const payload = JSON.parse(text[0].text)
    expect(payload.ok).toBe(true)
    expect(payload.pagePath).toBe('plans/ui/x/intake/materials.html')
    expect(payload.hint).toContain('自动打开')
  })

  it('toolResultOf 保留告警并给出失败原因', () => {
    const ok = toolResultOf({
      ok: true,
      pagePath: 'plans/ui/x/intake/materials.html',
      absolutePath: 'D:/P/plans/ui/x/intake/materials.html',
      slug: 'x',
      warnings: ['w'],
      defaults: { pagesDir: 'plans/ui', screen: { w: 1, h: 1 }, ui: { system: 'ugui', bindStyle: 'componentName', commonDir: '', matchMode: 'width' }, assets: { inProject: '', artRoot: '' } },
    })
    expect(ok.warnings).toEqual(['w'])
    expect(ok.hint).toBeTruthy()
    const bad = toolResultOf({ ok: false, error: 'slug 非法', warnings: ['w'] })
    expect(bad.ok).toBe(false)
    expect(bad.error).toBe('slug 非法')
  })
})
