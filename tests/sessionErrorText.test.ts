/**
 * client sessionError 文案归一测试（不触 DOM/RPC）。
 * 作者 ddj 2026年10月27号
 */
import { describe, expect, it } from 'vitest'
import { sessionErrorText, sessionMissingTitle } from '../src/client/sessionError.js'

describe('sessionErrorText', () => {
  it('规范会话缺失文案归一为终态提示', () => {
    const text = sessionErrorText('会话不存在')
    expect(text.startsWith(sessionMissingTitle() + '：')).toBe(true)
    expect(text).toContain('其他 DSH 实例')
  })
  it('宿主拼接形态同样命中', () => {
    expect(sessionErrorText('会话不存在或没有工作区')).toContain(sessionMissingTitle())
    expect(sessionErrorText('会话不存在：/workspace/demo')).toContain(sessionMissingTitle())
  })
  it('非会话错误原样返回', () => {
    expect(sessionErrorText('官方审查记录不存在')).toBe('官方审查记录不存在')
    expect(sessionErrorText('保存失败：ENOENT')).toBe('保存失败：ENOENT')
  })
  it('空值安全', () => {
    expect(sessionErrorText('')).toBe('')
    expect(sessionErrorText(null)).toBe('')
    expect(sessionErrorText(undefined)).toBe('')
  })
})
