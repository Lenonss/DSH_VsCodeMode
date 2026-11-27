/**
 * UI 材料页共享契约测试：slug/路径/页面配置解析/清单消息/客户端消息纯函数。
 * @author ddj 2026年11月26号
 */
import { describe, expect, it } from 'vitest'
import {
  UI_INTAKE_SOURCE,
  buildIntakeMessage,
  intakePagePathOf,
  isIntakePagePath,
  isIntakeSlug,
  isIntakeSubmissionId,
  isIntakeToken,
  normalizeRelPath,
  parseIntakePageConfig,
  slugOfIntakePage,
} from '../src/shared/uiIntake.js'
import {
  base64Of,
  bytesOf,
  intakeBindingOk,
  intakeMessageOf,
  intakeToolPayloadOf,
  pathUnder,
  receiptOf,
  sendOutcomeOf,
  toolTextOf,
} from '../src/client/uiIntakeProtocol.js'

/** 构造一份页面配置。 */
function pageConfig() {
  return {
    token: 'a'.repeat(32),
    pagePath: 'plans/ui/gift-popup/intake/materials.html',
    slug: 'gift-popup',
    pagesDir: 'plans/ui',
    projectRoot: 'D:/Work/Project',
    title: '礼包弹窗',
    screen: { w: 1080, h: 2400 },
    ui: { system: 'ugui', bindStyle: 'componentName', commonDir: 'Assets/UI/Common', matchMode: 'width' },
    assets: { inProject: 'Assets/GameData', artRoot: '' },
    limits: { maxFiles: 50, maxFileBytes: 8388608, maxTotalBytes: 33554432, maxPixels: 40000000, maxSide: 10000, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    createdAt: '2026-11-26T00:00:00.000Z',
  }
}

/** 把配置塞进页面脚本。 */
function pageOf(config: unknown): string {
  return '<html><body><script type="application/json" id="dsh-ui-intake-config">' + JSON.stringify(config) + '</script></body></html>'
}

describe('shared ui intake', () => {
  it('slug 与提交编号只接受安全字符', () => {
    expect(isIntakeSlug('gift-popup')).toBe(true)
    expect(isIntakeSlug('Gift')).toBe(false)
    expect(isIntakeSlug('../x')).toBe(false)
    expect(isIntakeSubmissionId('12345678-abcd-4abc-9abc-1234567890ab')).toBe(true)
    expect(isIntakeSubmissionId('../x')).toBe(false)
    expect(isIntakeToken('a'.repeat(32))).toBe(true)
    expect(isIntakeToken('')).toBe(false)
  })

  it('相对路径拒绝绝对路径与 .. 段', () => {
    expect(normalizeRelPath('plans/ui/x')).toBe('plans/ui/x')
    expect(normalizeRelPath('./plans/ui/x')).toBe('plans/ui/x')
    expect(normalizeRelPath('plans\\ui\\x')).toBe('plans/ui/x')
    expect(normalizeRelPath('../outside')).toBeNull()
    expect(normalizeRelPath('C:/outside')).toBeNull()
    expect(normalizeRelPath('/outside')).toBeNull()
  })

  it('材料页路径可构造、可识别、可反取 slug', () => {
    const path = intakePagePathOf('plans/ui', 'gift-popup')
    expect(path).toBe('plans/ui/gift-popup/intake/materials.html')
    expect(isIntakePagePath(path, 'plans/ui')).toBe(true)
    expect(isIntakePagePath(path, 'plans/ui', 'gift-popup')).toBe(true)
    expect(isIntakePagePath(path, 'plans/ui', 'other')).toBe(false)
    expect(slugOfIntakePage(path, 'plans/ui')).toBe('gift-popup')
    expect(slugOfIntakePage('plans/ui/gift-popup/plan.html', 'plans/ui')).toBeNull()
  })

  it('页面配置能读回；缺关键字段返回 null', () => {
    const config = pageConfig()
    const parsed = parseIntakePageConfig(pageOf(config))
    expect(parsed?.token).toBe(config.token)
    expect(parsed?.screen).toEqual({ w: 1080, h: 2400 })
    expect(parsed?.limits.maxFiles).toBe(50)
    expect(parseIntakePageConfig('<html></html>')).toBeNull()
    expect(parseIntakePageConfig(pageOf({ ...config, token: '' }))).toBeNull()
    expect(parseIntakePageConfig(pageOf({ ...config, pagePath: '../x' }))).toBeNull()
  })

  it('清单消息包含继续设计意图、清单路径与本阶段边界', () => {
    const text = buildIntakeMessage({
      pagesDir: 'plans/ui',
      slug: 'gift-popup',
      manifestPath: 'plans/ui/gift-popup/intake/submissions/x/request.json',
      title: '礼包弹窗',
      screen: { w: 1080, h: 2400 },
      assets: [
        { role: 'mock', relativePath: 'plans/ui/gift-popup/intake/submissions/x/original/a.png', originalName: 'a.png' },
        { role: 'material', relativePath: 'plans/ui/gift-popup/intake/submissions/x/original/b.png', originalName: 'b.png' },
      ],
      hasMockPath: false,
    })
    expect(text).toContain('/ui-builder 继续设计')
    expect(text).toContain('材料清单：plans/ui/gift-popup/intake/submissions/x/request.json')
    expect(text).toContain('1080×2400')
    expect(text).toContain('效果图：plans/ui/gift-popup/intake/submissions/x/original/a.png')
    expect(text).toContain('素材图：1 张')
    expect(text).toContain('只生成 HTML 设计页')
    expect(text).toContain('暂不搭建 Unity 预制体')
  })

  it('客户端协议：来源、工具结果、路径归属、字节与状态', () => {
    expect(intakeMessageOf({ source: UI_INTAKE_SOURCE, type: 'hello' })?.type).toBe('hello')
    expect(intakeMessageOf({ source: 'other', type: 'hello' })).toBeNull()
    expect(toolTextOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
    const payload = intakeToolPayloadOf(JSON.stringify({ ok: true, pagePath: 'plans/ui/x/intake/materials.html', absolutePath: 'D:/p/x', slug: 'x' }))
    expect(payload?.pagePath).toBe('plans/ui/x/intake/materials.html')
    expect(intakeToolPayloadOf(JSON.stringify({ ok: false }))).toBeNull()
    expect(pathUnder('D:/Work/Project', 'D:/Work/Project/sub')).toBe(true)
    expect(pathUnder('D:/Work/Project', 'D:/Work/Other')).toBe(false)
    expect(pathUnder('D:/Work/Project', 'D:/Work/Project2')).toBe(false)
    const bytes = new Uint8Array([1, 2, 3])
    expect(Array.from(bytesOf(bytes.buffer) ?? [])).toEqual([1, 2, 3])
    expect(base64Of(bytes)).toBe('AQID')
    expect(receiptOf({ ok: true, value: { receiptId: 'r1' } })).toBe('r1')
    expect(receiptOf({ ok: false, error: { message: 'x' } })).toBeNull()
    expect(sendOutcomeOf({ status: 'accepted' })).toBe('accepted')
    expect(sendOutcomeOf({ status: 'submitted' })).toBe('unconfirmed')
    expect(sendOutcomeOf({ status: 'rejected' })).toBe('failed')
  })

  it('页面消息与配置的绑定校验', () => {
    const config = pageConfig()
    const message = intakeMessageOf({
      source: UI_INTAKE_SOURCE,
      type: 'submit',
      token: config.token,
      pagePath: config.pagePath,
      projectRoot: config.projectRoot,
    })
    expect(message).not.toBeNull()
    expect(intakeBindingOk(config, message!, config.pagesDir)).toBe(true)
    expect(intakeBindingOk(config, { ...message!, token: 'b'.repeat(32) }, config.pagesDir)).toBe(false)
    expect(intakeBindingOk(config, { ...message!, projectRoot: 'D:/Other' }, config.pagesDir)).toBe(false)
  })
})
