/** 会话缺失错误识别与文案单测（跨端「会话不存在」兼容）。作者 ddj 2026年10月16号 */
import { describe, expect, it } from 'vitest'
import { isSessionMissingError, sessionMissingDetail, sessionMissingTitle } from '../src/client/sessionError.js'
import { SESSION_MISSING_ERROR } from '../src/shared/rpc.js'

describe('isSessionMissingError', () => {
  it('命中规范文案本身', () => {
    expect(isSessionMissingError(SESSION_MISSING_ERROR)).toBe(true)
  })

  it('命中 host 拼接形态（错误：路径）', () => {
    expect(isSessionMissingError(SESSION_MISSING_ERROR + ':C:/repo/a.lua')).toBe(true)
    expect(isSessionMissingError('文件加载失败：' + SESSION_MISSING_ERROR)).toBe(true)
  })

  it('非会话类错误不命中', () => {
    expect(isSessionMissingError('读取失败')).toBe(false)
    expect(isSessionMissingError('拒绝操作：目标不在会话工作区内')).toBe(false)
    expect(isSessionMissingError('会话无工作区')).toBe(false)
    expect(isSessionMissingError('read异常:TypeError')).toBe(false)
  })

  it('空值与异常输入安全', () => {
    expect(isSessionMissingError(null)).toBe(false)
    expect(isSessionMissingError(undefined)).toBe(false)
    expect(isSessionMissingError('')).toBe(false)
    expect(isSessionMissingError(42)).toBe(false)
  })
})

describe('友好文案', () => {
  it('标题与详情非空且自含主语', () => {
    expect(sessionMissingTitle().length).toBeGreaterThan(0)
    expect(sessionMissingDetail().length).toBeGreaterThan(10)
  })

  it('详情说明跨端占用成因并给出引导', () => {
    const detail = sessionMissingDetail()
    expect(detail).toContain('DSH 实例')
    expect(detail).toContain('重试')
  })
})
