/**
 * shared/externalOpen.ts 纯函数测试：深链参数解析（launcher/Unity → client 全链路解码往返）。
 * 覆盖：中文/空格/反斜杠/加号路径、多路径逗号分隔、行列正整数、非深链 no-op。
 * 作者 ddj 2026-09-07
 */
import { describe, expect, it } from 'vitest'
import { EDRV_PARAM_KEYS, parseOpenParams, PATHS_SEPARATOR } from '../src/shared/externalOpen.js'

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
