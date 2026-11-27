/**
 * 客户端 UI 材料协议纯函数测试：消息识别、路径边界、工具回执、投递证据。
 * @author ddj 2026年11月26号
 */
import { describe, expect, it } from 'vitest'
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
  uploadErrorOf,
} from '../src/client/uiIntakeProtocol.js'

describe('ui intake protocol', () => {
  it('只识别带 source 的提交/重试消息', () => {
    expect(intakeMessageOf({ source: 'edrv-ui-intake', type: 'submit', token: 't', pagePath: 'p' })?.type).toBe('submit')
    expect(intakeMessageOf({ source: 'edrv-ui-intake', type: 'retry-send', token: 't', pagePath: 'p' })?.type).toBe('retry-send')
    expect(intakeMessageOf({ type: 'submit' })).toBeNull()
  })

  it('路径边界按目录段判断，拒绝同前缀与越界', () => {
    expect(pathUnder('plans/ui/x', 'plans/ui/x/intake/materials.html')).toBe(true)
    expect(pathUnder('plans/ui/x', 'plans/ui/x2/intake/materials.html')).toBe(false)
    expect(pathUnder('plans/ui/x', 'plans/ui/x/../y/intake/materials.html')).toBe(false)
  })

  it('工具结果解析要求 pagePath / absolutePath 都是字符串', () => {
    const text = JSON.stringify({ ok: true, pagePath: 'plans/ui/x/intake/materials.html', absolutePath: 'D:/P/plans/ui/x/intake/materials.html', slug: 'x' })
    const payload = intakeToolPayloadOf(text)
    expect(payload?.pagePath).toBe('plans/ui/x/intake/materials.html')
    expect(intakeToolPayloadOf(JSON.stringify({ ok: true, pagePath: 1 }))).toBeNull()
    expect(toolTextOf([{ type: 'text', text }])).toBe(text)
  })

  it('绑定校验要求页面路径落在项目下且 token 非空', () => {
    const config = { token: 'a'.repeat(32), pagePath: 'plans/ui/x/intake/materials.html', pagesDir: 'plans/ui', projectRoot: 'D:/P' }
    const message = { source: 'edrv-ui-intake' as const, type: 'submit' as const, token: config.token, pagePath: config.pagePath, projectRoot: 'D:/P' }
    expect(intakeBindingOk(config, message, 'plans/ui')).toBe(true)
    expect(intakeBindingOk(config, { ...message, projectRoot: 'D:/Other' }, 'plans/ui')).toBe(false)
    expect(intakeBindingOk({ ...config, token: '' }, { ...message, token: '' }, 'plans/ui')).toBe(false)
  })

  it('字节/回执/失败原因/投递结果归一', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(bytesOf(bytes)).toBe(bytes)
    expect(bytesOf(bytes.buffer)).toEqual(bytes)
    expect(base64Of(bytes)).toBe('AQID')
    expect(receiptOf({ ok: true, value: { receiptId: 'r1' } })).toBe('r1')
    expect(receiptOf({ ok: false })).toBeNull()
    expect(uploadErrorOf({ error: { message: '太大' } })).toBe('太大')
    expect(sendOutcomeOf({ status: 'accepted' })).toBe('accepted')
    expect(sendOutcomeOf({ status: 'submitted' })).toBe('unconfirmed')
    expect(sendOutcomeOf({ status: 'failed' })).toBe('failed')
  })
})
