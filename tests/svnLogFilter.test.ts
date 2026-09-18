/**
 * SVN 日志过滤语法单测（P0-1，官方 7 示例 + 字段/正则）：
 * 蓝图 §5 P0-1 / §2.2；parseLogFilter 纯函数（G2：前端过滤）。
 * 作者 ddj 2026-09-17
 */
import { describe, expect, it } from 'vitest'
import { parseLogFilter, tokenizeLogQuery } from '../src/client/ui/SvnLogDialog.js'
import type { SvnLogEntry } from '../src/shared/svn.js'

/** 构造条目（paths 按需给 relPath）。 */
function mk(partial: Partial<SvnLogEntry>): SvnLogEntry {
  return {
    revision: 1, author: '', date: '', message: '', paths: [], ...partial,
  }
}

describe('tokenizeLogQuery 词元切分', () => {
  it('引号内空格不切分；"" 为字面引号', () => {
    expect(tokenizeLogQuery('Alice "and Bob"')).toEqual(['Alice', 'and Bob'])
    expect(tokenizeLogQuery('say ""hi""')).toEqual(['say', '"hi"'])
    expect(tokenizeLogQuery('"Alice says ""hi"" to Bob"')).toEqual(['Alice says "hi" to Bob'])
  })
})

describe('官方 7 示例（§2.2）', () => {
  it('1. Alice Bob -Eve = 含 Alice 与 Bob 且不含 Eve', () => {
    const f = parseLogFilter('Alice Bob -Eve')
    expect(f(mk({ author: 'Alice', message: 'Bob did it' }))).toBe(true)
    expect(f(mk({ author: 'Alice', message: 'Bob and Eve' }))).toBe(false)
    expect(f(mk({ author: 'Alice', message: 'solo' }))).toBe(false)
  })

  it('2. Alice -Bob +Eve = 含 Alice 且不含 Bob，或含 Eve', () => {
    const f = parseLogFilter('Alice -Bob +Eve')
    expect(f(mk({ author: 'Alice', message: 'ok' }))).toBe(true)
    expect(f(mk({ author: 'Alice', message: 'Bob here' }))).toBe(false)
    expect(f(mk({ author: 'Eve', message: 're-included' }))).toBe(true)
    expect(f(mk({ author: 'Zoe', message: 'Bob and Eve both' }))).toBe(true) // 后写 +Eve 覆盖 -Bob
  })

  it('3. -Case +SpecialCase = 不含 Case，但含 SpecialCase 的仍保留（顺序敏感）', () => {
    const f = parseLogFilter('-Case +SpecialCase')
    expect(f(mk({ message: 'has Case only' }))).toBe(false)
    expect(f(mk({ message: 'Case and SpecialCase' }))).toBe(true)
    expect(f(mk({ message: 'SpecialCase alone' }))).toBe(true)
    expect(f(mk({ message: 'unrelated' }))).toBe(true)
  })

  it('4. !Alice Bob = 不是「Alice 与 Bob 同时出现」', () => {
    const f = parseLogFilter('!Alice Bob')
    expect(f(mk({ author: 'Alice', message: 'Bob' }))).toBe(false)
    expect(f(mk({ author: 'Alice', message: 'solo' }))).toBe(true)
    expect(f(mk({ author: 'Zoe', message: 'Bob' }))).toBe(true)
  })

  it('5. !-Alice -Bob ≡ Alice OR Bob', () => {
    const f = parseLogFilter('!-Alice -Bob')
    expect(f(mk({ author: 'Alice' }))).toBe(true)
    expect(f(mk({ author: 'Bob' }))).toBe(true)
    expect(f(mk({ author: 'Zoe' }))).toBe(false)
  })

  it('6. "Alice and Bob" 按字面短语匹配', () => {
    const f = parseLogFilter('"Alice and Bob"')
    expect(f(mk({ message: 'Alice and Bob met' }))).toBe(true)
    expect(f(mk({ message: 'Alice met Bob' }))).toBe(false)
  })

  it('7. "" 匹配字面双引号', () => {
    const f = parseLogFilter('""')
    expect(f(mk({ message: 'say "hi" now' }))).toBe(true)
    expect(f(mk({ message: 'no quotes here' }))).toBe(false)
  })
})

describe('字段与正则', () => {
  it('字段限定：author 只搜作者，revision 支持子串，paths 搜相对路径', () => {
    const entry = mk({ revision: 292834, author: 'asong', message: '钓鱼调整', paths: [{ path: '/trunk/a.lua', relPath: 'Assets/a.lua', action: 'M' }] })
    expect(parseLogFilter('asong', 'author')(entry)).toBe(true)
    expect(parseLogFilter('alice', 'author')(entry)).toBe(false)
    expect(parseLogFilter('92', 'revision')(entry)).toBe(true)
    expect(parseLogFilter('a.lua', 'paths')(entry)).toBe(true)
    expect(parseLogFilter('钓鱼', 'message')(entry)).toBe(true)
    expect(parseLogFilter('钓鱼', 'author')(entry)).toBe(false)
  })

  it('all 字段为四段拼接；大小写不敏感', () => {
    const entry = mk({ revision: 5, author: 'Asong', message: 'Fix Bug', paths: [] })
    expect(parseLogFilter('asong fix')(entry)).toBe(true)
    expect(parseLogFilter('ASONG')(entry)).toBe(true)
  })

  it('正则模式：逐词元编译，非法正则回落子串', () => {
    const entry = mk({ message: 'rev r292834 done', author: 'a1' })
    expect(parseLogFilter('r\\d{6}', 'message', true)(entry)).toBe(true)
    expect(parseLogFilter('r\\d{6}', 'message', false)(entry)).toBe(false)
    expect(parseLogFilter('r\\d{6}', 'message', true)(mk({ message: 'no digits' }))).toBe(false)
    // 非法正则 [ 回落为子串匹配，不抛错
    expect(() => parseLogFilter('[', 'message', true)).not.toThrow()
    expect(parseLogFilter('[', 'message', true)(mk({ message: 'a [ b' }))).toBe(true)
  })

  it('空查询恒真', () => {
    expect(parseLogFilter('')(mk({}))).toBe(true)
    expect(parseLogFilter('   ')(mk({}))).toBe(true)
  })
})
