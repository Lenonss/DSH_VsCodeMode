/**
 * W1-4 前端导出工具（svnExport.ts）单测。
 * 守护：CSV BOM（Excel 中文直开）、RFC 4180 转义、HTML 转义防注入、行数与输入一致、
 * downloadText 无 DOM 时优雅降级返回 false（不抛错）。
 * 作者 ddj 2026年09月20号
 */
import { describe, expect, it } from 'vitest'
import { csvOf, downloadText, htmlTableOf } from '../src/client/ui/svnExport.js'

describe('csvOf', () => {
  it('前置 UTF-8 BOM（Excel 直开中文不乱码的关键）', () => {
    const text = csvOf([['状态', '路径'], ['M', '资.产/场景.lua']])
    expect(text.charCodeAt(0)).toBe(0xfeff)
    expect(text.slice(1).startsWith('状态,路径')).toBe(true)
  })

  it('含逗号/引号/换行的字段按 RFC 4180 加引号且内部引号翻倍；行尾 CRLF', () => {
    const text = csvOf([['h1', 'h2'], ['a,b', 'say "hi"'], ['line1\nline2', 'plain']])
    const body = text.slice(1)
    expect(body).toBe('h1,h2\r\n"a,b","say ""hi"""\r\n"line1\nline2",plain\r\n')
  })

  it('null/undefined 单元格输出空串；行数与输入一致（与面板逐条对齐的前提）', () => {
    const rows = [['a'], [null, undefined], ['c']]
    const text = csvOf(rows)
    const lines = text.slice(1).split('\r\n').filter((line) => line !== '')
    expect(lines.length).toBe(3)
    expect(lines[1]).toBe(',')
  })
})

describe('htmlTableOf', () => {
  it('HTML 转义 & < > "，防止路径中的特殊字符破坏结构', () => {
    const html = htmlTableOf(['路径'], [['<a&b>"']], 't"t')
    expect(html).toContain('&lt;a&amp;b&gt;&quot;')
    expect(html).toContain('<title>t&quot;t</title>')
    expect(html).not.toContain('<a&b>')
  })

  it('结构完整：charset 声明 + 表头 th + 逐行 tr/td，行数一致', () => {
    const html = htmlTableOf(['修订', '路径'], [['r1', 'a'], ['r2', 'b']], 'SVN 日志')
    expect(html).toContain('charset="utf-8"')
    expect(html).toContain('<th>修订</th><th>路径</th>')
    expect(html).toContain('<td>r1</td><td>a</td>')
    expect(html).toContain('<td>r2</td><td>b</td>')
    expect(html.match(/<tr>/g)?.length).toBe(3)
  })

  it('caption 空值安全', () => {
    expect(htmlTableOf(['h'], [['v']], '')).toContain('<h3></h3>')
  })
})

describe('downloadText', () => {
  it('无 DOM 环境优雅降级：返回 false 不抛错（浏览器能力缺失时调用方提示）', () => {
    expect(downloadText('x.csv', 'a,b', 'text/csv')).toBe(false)
  })
})
