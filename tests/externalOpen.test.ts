/**
 * shared/externalOpen.ts 纯函数测试：深链参数解析（launcher/Unity → client 全链路解码往返）。
 * 覆盖：中文/空格/反斜杠/加号路径、多路径逗号分隔、行列正整数、非深链 no-op。
 * 作者 ddj 2026-09-07
 */
import { describe, expect, it } from 'vitest'
import { EDRV_PARAM_KEYS, parseInboxOpen, parseOpenParams, PATHS_SEPARATOR, sameProfile } from '../src/shared/externalOpen.js'

/** 模拟 launcher（Uri.EscapeDataString ≡ encodeURIComponent）拼出的查询串。 */
function buildSearch(paths: string[], extra = ''): string {
  return '?edrvOpen=1&edrvPaths=' + paths.map((p) => encodeURIComponent(p)).join(PATHS_SEPARATOR) + extra
}

describe('parseOpenParams', () => {
  it('非深链 / 缺路径 → null', () => {
    expect(parseOpenParams('')).toBeNull()
    expect(parseOpenParams('?edrvOpen=0&edrvPaths=x')).toBeNull()
    expect(parseOpenParams('?edrvOpen=1')).toBeNull()
  })

  it('单路径全链路解码往返：中文 + 空格 + 反斜杠', () => {
    const search = buildSearch(['D:\\My Projects\\测试\\场景.lua'])
    expect(parseOpenParams(search)).toEqual({ paths: ['D:\\My Projects\\测试\\场景.lua'], line: undefined, column: undefined })
  })

  it('多路径逗号分隔 + 行列定位', () => {
    const search = buildSearch(['D:\\a.cs', 'D:\\b dir\\b.cs'], '&edrvLine=12&edrvColumn=3')
    expect(parseOpenParams(search)).toEqual({ paths: ['D:\\a.cs', 'D:\\b dir\\b.cs'], line: 12, column: 3 })
  })

  it('路径含加号/百分号字符安全（编码兜底）', () => {
    const search = buildSearch(['D:\\a+b\\100%.cs'])
    expect(parseOpenParams(search)?.paths).toEqual(['D:\\a+b\\100%.cs'])
  })

  it('非法行列忽略（0/负数/小数）', () => {
    const search = buildSearch(['D:\\a.cs'], '&edrvLine=0&edrvColumn=-3')
    const params = parseOpenParams(search)
    expect(params?.line).toBeUndefined()
    expect(params?.column).toBeUndefined()
  })

  it('深链参数键全集用于 URL 清理', () => {
    expect(EDRV_PARAM_KEYS).toEqual(['edrvOpen', 'edrvPaths', 'edrvLine', 'edrvColumn'])
  })
})

describe('sameProfile', () => {
  it('accepts the same Windows profile written with either separator or case', () => {
    expect(sameProfile('C:/Users/a/.dsh/profiles/desktop', 'C:\\Users\\a\\.dsh\\profiles\\desktop', 'win32')).toBe(true)
    expect(sameProfile('C:\\Users\\A\\.dsh\\profiles\\desktop\\', 'c:\\users\\a\\.dsh\\profiles\\desktop', 'win32')).toBe(true)
  })

  it('keeps POSIX profiles exact and separator-sensitive', () => {
    expect(sameProfile('/home/a/.dsh/profiles/desktop/', '/home/a/.dsh/profiles/desktop', 'linux')).toBe(true)
    expect(sameProfile('/home/a/.dsh/profiles/desktop', '/home/a/.dsh/profiles/Desktop', 'linux')).toBe(false)
  })
})

describe('parseInboxOpen', () => {
  /** @author ddj 2026年09月28号 @param profile Declared profile. @returns Valid request payload. */
  const payload = (profile: string) => ({
    version: 1,
    requestId: '6c3946fa-94a1-4bed-ba60-5125fcb29a54',
    profile,
    paths: ['C:\\work\\a.ts'],
    createdAt: Date.now(),
  })

  it('accepts the running profile written with forward slashes', () => {
    const parsed = parseInboxOpen(payload('C:/Users/a/.dsh/profiles/desktop'), 'C:\\Users\\a\\.dsh\\profiles\\desktop', Date.now(), 'win32')
    expect(parsed?.profile).toBe('C:/Users/a/.dsh/profiles/desktop')
  })

  it('still rejects a different profile, bad ids and expired requests', () => {
    const expected = 'C:\\Users\\a\\.dsh\\profiles\\desktop'
    expect(parseInboxOpen(payload('C:\\Users\\other\\.dsh\\profiles\\desktop'), expected, Date.now(), 'win32')).toBeNull()
    const badId = { ...payload('C:/x'), requestId: 'not-a-uuid' }
    expect(parseInboxOpen(badId, 'C:/x', Date.now(), 'linux')).toBeNull()
    const expired = { ...payload('/home/a/.dsh/profiles/desktop'), createdAt: Date.now() - 120_000 }
    expect(parseInboxOpen(expired, '/home/a/.dsh/profiles/desktop', Date.now(), 'linux')).toBeNull()
  })

  it('keeps POSIX profile identity case-sensitive through the parser', () => {
    const declared = '/home/a/.dsh/profiles/desktop'
    expect(parseInboxOpen(payload(declared), '/home/a/.dsh/profiles/Desktop', Date.now(), 'linux')).toBeNull()
    expect(parseInboxOpen(payload(declared), declared, Date.now(), 'linux')?.profile).toBe(declared)
  })
})
