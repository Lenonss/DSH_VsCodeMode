/**
 * 全局替换纯逻辑测试：模式编译、空匹配拒绝、逐行替换、行尾/BOM 保真、候选路径归一。
 * @author ddj 2026年11月15号
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_PATTERN_LENGTH,
  compileReplace,
  countInText,
  countInLine,
  escapeRegExp,
  hasEmptyMatch,
  replaceInText,
} from '../src/search/replacePlan.js'
import { describeFailure, isBom, matchedFilesArgv, relativeCandidate } from '../src/search/replaceRun.js'
import { replaceSummary } from '../src/client/sidebar/panels/SearchPanel.js'

describe('模式编译', () => {
  it('字面量模式转义正则元字符', () => {
    expect(escapeRegExp('a.b*c')).toBe('a\\.b\\*c')
    const compiled = compileReplace({ query: 'a.b', replacement: 'x' })
    expect(replaceInText('a.b axb', compiled).text).toBe('x axb')
  })

  it('默认忽略大小写；matchCase 严格匹配', () => {
    expect(replaceInText('Foo foo', compileReplace({ query: 'foo', replacement: 'x' })).count).toBe(2)
    expect(replaceInText('Foo foo', compileReplace({ query: 'foo', replacement: 'x', matchCase: true })).count).toBe(1)
  })

  it('全词模式不误伤子串', () => {
    const compiled = compileReplace({ query: 'cat', replacement: 'dog', wholeWord: true })
    expect(replaceInText('cat category cat', compiled).text).toBe('dog category dog')
  })

  it('正则模式支持分组引用与 $ 字面量差异', () => {
    const grouped = compileReplace({ query: '(foo)(bar)', replacement: '$2-$1', regex: true })
    expect(replaceInText('foobar', grouped).text).toBe('bar-foo')
    const literal = compileReplace({ query: 'foo', replacement: 'price $9' })
    expect(replaceInText('foo', literal).text).toBe('price $9')
  })

  it('拒绝会匹配空串的模式', () => {
    expect(() => compileReplace({ query: 'a*', replacement: 'x', regex: true })).toThrow(/空字符串/)
    expect(() => compileReplace({ query: '(?:)', replacement: 'x', regex: true })).toThrow(/空字符串/)
    expect(() => compileReplace({ query: '', replacement: 'x' })).toThrow(/请先输入/)
  })

  it('拒绝无效正则与超长查询', () => {
    expect(() => compileReplace({ query: '(', replacement: 'x', regex: true })).toThrow(/正则表达式无效/)
    expect(() => compileReplace({ query: 'a'.repeat(MAX_PATTERN_LENGTH + 1), replacement: 'x' })).toThrow(/过长/)
  })

  it('hasEmptyMatch 识别零宽模式', () => {
    expect(hasEmptyMatch(/a*/g)).toBe(true)
    expect(hasEmptyMatch(/a+/g)).toBe(false)
  })
})

describe('逐行替换', () => {
  it('保留 CRLF 行尾与 BOM', () => {
    const text = '\uFEFFfoo one\r\nbar\r\nfoo two\r\n'
    const result = replaceInText(text, compileReplace({ query: 'foo', replacement: 'baz' }))
    expect(result.count).toBe(2)
    expect(result.text).toBe('\uFEFFbaz one\r\nbar\r\nbaz two\r\n')
  })

  it('只改写命中行，未命中的行字节不变', () => {
    const text = 'keep   \nfoo\nkeep\r\n'
    const result = replaceInText(text, compileReplace({ query: 'foo', replacement: 'bar' }))
    expect(result.text).toBe('keep   \nbar\nkeep\r\n')
  })

  it('^ / $ 按行生效（不跨行）', () => {
    const compiled = compileReplace({ query: '^foo$', replacement: 'bar', regex: true })
    expect(replaceInText('foo\nfoobar\nfoo\n', compiled).text).toBe('bar\nfoobar\nbar\n')
  })

  it('无命中时原样返回且计数为 0', () => {
    const text = 'nothing here'
    const result = replaceInText(text, compileReplace({ query: 'zzz', replacement: 'y' }))
    expect(result).toEqual({ text, count: 0 })
  })

  it('一行内多次命中全部替换并计数', () => {
    const result = replaceInText('foo foo foo', compileReplace({ query: 'foo', replacement: 'x' }))
    expect(result).toEqual({ text: 'x x x', count: 3 })
  })

  it('countInText 与 countInLine 语义一致', () => {
    const compiled = compileReplace({ query: 'ab', replacement: '' })
    expect(countInText('ab\r\nabab\n', compiled)).toBe(3)
    expect(countInLine('abab', compiled.pattern)).toBe(2)
  })
})

describe('候选与失败原因', () => {
  it('matchedFilesArgv 带上大小写/全词/过滤口径', () => {
    const argv = matchedFilesArgv('rg', '/root', {
      query: 'foo',
      replacement: 'bar',
      matchCase: true,
      wholeWord: true,
      include: ['*.ts'],
      exclude: ['*.map'],
    })
    expect(argv[0]).toBe('rg')
    expect(argv).toContain('--files-with-matches')
    expect(argv).toContain('--case-sensitive')
    expect(argv).toContain('--word-regexp')
    expect(argv).toContain('--fixed-strings')
    expect(argv).toContain('!**/node_modules/**')
    expect(argv.slice(-3)).toEqual(['--', 'foo', '/root'])
    expect(argv).toContain('*.ts')
    expect(argv).toContain('!*.map')
  })

  it('relativeCandidate 归一分隔符并拒绝越界路径', () => {
    // 路径语义按平台取：node:path.relative 在 POSIX 上不认识 Windows 盘符，
    // 若把 Windows 字面量写死会在 ubuntu CI 上误报（真实 rg 输出与运行平台一致）。
    const root = process.platform === 'win32' ? 'C:\\root' : '/root'
    const inner = process.platform === 'win32' ? 'C:\\root\\src\\a.ts' : '/root/src/a.ts'
    const outside = process.platform === 'win32' ? 'C:\\other\\a.ts' : '/other/a.ts'
    expect(relativeCandidate(root, inner)).toBe('src/a.ts')
    expect(relativeCandidate(root, outside)).toBe('')
    expect(relativeCandidate(root, '')).toBe('')
  })

  it('版本冲突给出可读原因，长消息截断', () => {
    expect(describeFailure(Object.assign(new Error('changed since it was read'), { code: 'FS_STALE_VERSION' }))).toMatch(/替换期间被修改/)
    expect(describeFailure(new Error('x'.repeat(400)))).toHaveLength(301)
  })

  it('isBom 只认 UTF-8 BOM 前缀', () => {
    expect(isBom(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe(true)
    expect(isBom(new Uint8Array([0x61, 0x62, 0x63]))).toBe(false)
    expect(isBom(new Uint8Array([0xef, 0xbb]))).toBe(false)
    expect(isBom(null)).toBe(false)
    expect(isBom(undefined)).toBe(false)
  })
})

describe('替换结果摘要', () => {
  it('区分预览与已执行，并带跳过/失败/截断信息', () => {
    expect(replaceSummary({ totalReplaced: 3, totalFiles: 2, dryRun: true })).toContain('预览：3 处 · 2 个文件')
    expect(replaceSummary({ totalReplaced: 3, totalFiles: 2 })).toContain('已替换 3 处 · 2 个文件')
    const summary = replaceSummary({
      totalReplaced: 1, totalFiles: 1, skipped: 2, truncated: true,
      failed: [{ path: 'a.ts', reason: '文件在替换期间被修改，已跳过' }],
    })
    expect(summary).toContain('跳过 2 个文件')
    expect(summary).toContain('失败 1 个')
    expect(summary).toContain('截断')
  })

  it('空结果返回空串（不渲染空提示条）', () => {
    expect(replaceSummary(null)).toBe('')
  })
})
