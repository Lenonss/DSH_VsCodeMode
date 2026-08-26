/**
 * 内容搜索（rg --json）解析、编排与 RPC 测试。
 * 作者 ddj 2026-08-26
 */
import { describe, expect, it, vi } from 'vitest'
import { applyCaps, byteToUtf16Col, contentArgv, ContentSearcher, displayPathOf, parseRgJsonLines } from '../src/search/content.js'
import { buildHandlers } from '../src/rpc.js'
import { splitGlobs } from '../src/client/sidebar/panels/SearchPanel.js'
import type { ContentSearchResult } from '../src/search/types.js'

function context(fs: unknown, policy?: unknown): any {
  return { get: (name: string) => name === 'fs' ? fs : name === 'sandboxPolicy' ? policy : undefined }
}

function fakeFs(): any {
  return {
    resolve: vi.fn(async (path: string) => ({ key: path })),
    processPath: vi.fn((target: { key: string }) => 'proc:' + target.key),
  }
}

function result(matches: ContentSearchResult['matches'], truncated = false): ContentSearchResult {
  return { matches, truncated, complete: !truncated, source: 'ripgrep' }
}

const RG_JSON = [
  '{"type":"begin","data":{"path":{"text":"C:\\\\ws\\\\a.lua"}}}',
  '{"type":"match","data":{"path":{"text":"C:\\\\ws\\\\a.lua"},"lines":{"text":"local foo = 1\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"foo"},"start":6,"end":9}]}}',
  '{"type":"match","data":{"path":{"text":"C:\\\\ws\\\\a.lua"},"lines":{"text":"中文 foo 内容\\n"},"line_number":2,"absolute_offset":14,"submatches":[{"match":{"text":"foo"},"start":7,"end":10}]}}',
  '{"type":"match","data":{"path":{"text":"C:\\\\ws\\\\b.lua"},"lines":{"text":"foo bar foo\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"foo"},"start":0,"end":3},{"match":{"text":"foo"},"start":8,"end":11}]}}',
  'not-json-line',
  '{"type":"end","data":{"path":{"text":"C:\\\\ws\\\\b.lua"}}}',
].join('\n')

describe('content column conversion', () => {
  it('converts line-relative byte offsets to 1-based UTF-16 columns', () => {
    expect(byteToUtf16Col('local foo = 1', 6)).toBe(7)
    expect(byteToUtf16Col('中文 foo 内容', 7)).toBe(4)
    expect(byteToUtf16Col('中文 foo 内容', 10)).toBe(7)
    expect(byteToUtf16Col('foo()', 0)).toBe(1)
    expect(byteToUtf16Col('abc', 99)).toBe(4) // 越界钳到行尾
  })

  it('normalizes display paths relative to root', () => {
    expect(displayPathOf('C:/ws/a.lua', 'C:/ws')).toBe('a.lua')
    expect(displayPathOf('C:\\ws\\a.lua', 'C:/ws')).toBe('a.lua')
    expect(displayPathOf('C:/ws', 'C:/ws')).toBe('.')
    expect(displayPathOf('D:/other/x.lua', 'C:/ws')).toBe('D:/other/x.lua')
  })
})

describe('rg json parsing', () => {
  it('parses match records into flattened matches with UTF-16 columns', () => {
    const matches = parseRgJsonLines(RG_JSON, 'C:/ws')
    expect(matches).toEqual([
      { path: 'a.lua', line: 1, startColumn: 7, endColumn: 10, text: 'local foo = 1' },
      { path: 'a.lua', line: 2, startColumn: 4, endColumn: 7, text: '中文 foo 内容' },
      { path: 'b.lua', line: 1, startColumn: 1, endColumn: 4, text: 'foo bar foo' },
      { path: 'b.lua', line: 1, startColumn: 9, endColumn: 12, text: 'foo bar foo' },
    ])
  })

  it('skips garbage and non-match records', () => {
    expect(parseRgJsonLines('garbage\n{"type":"summary","data":{}}', 'C:/ws')).toEqual([])
  })

  it('skips giant single-line records (source maps / bundled artifacts)', () => {
    const giant = 'x'.repeat((1 << 20) + 1)
    const line = '{"type":"match","data":{"path":{"text":"C:\\\\ws\\\\huge.map"},"lines":{"text":"' + giant + '\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"x"},"start":0,"end":1}]}}'
    expect(parseRgJsonLines(line, 'C:/ws')).toEqual([])
  })
})

describe('caps and argv', () => {
  it('caps matches and files with truncated flag', () => {
    const m = [
      { path: 'a', line: 1, startColumn: 1, endColumn: 2, text: 'x' },
      { path: 'a', line: 2, startColumn: 1, endColumn: 2, text: 'x' },
      { path: 'b', line: 1, startColumn: 1, endColumn: 2, text: 'x' },
    ]
    expect(applyCaps(m, 2, 10)).toEqual({ matches: m.slice(0, 2), truncated: true })
    expect(applyCaps(m, 10, 1)).toEqual({ matches: m.slice(0, 2), truncated: true })
    expect(applyCaps(m, 10, 10)).toEqual({ matches: m, truncated: false })
  })

  it('builds argv with literal flags and fixed-strings by default', () => {
    const argv = contentArgv('rg', 'C:/ws', { ctx: null, session: null, cwd: 'C:/ws', query: 'foo', matchCase: true, wholeWord: true })
    expect(argv).toContain('--case-sensitive')
    expect(argv).toContain('--word-regexp')
    expect(argv).toContain('--fixed-strings')
    expect(argv.slice(-3)).toEqual(['--', 'foo', 'C:/ws'])
  })

  it('excludes plugin sidecars and source maps from the scan', () => {
    const argv = contentArgv('rg', 'C:/ws', { ctx: null, session: null, cwd: 'C:/ws', query: 'foo' })
    expect(argv).toContain('!**/.dsh-edit-review.json')
    expect(argv).toContain('!**/.dsh-edit-review-archive.json')
    expect(argv).toContain('!**/*.map')
    expect(argv).toContain('!**/.pnpm-store/**')
  })

  it('turns include/exclude patterns into positive and negative globs', () => {
    const argv = contentArgv('rg', 'C:/ws', {
      ctx: null, session: null, cwd: 'C:/ws', query: 'foo',
      include: ['*.ts', 'src/**/include'], exclude: ['*.lua', 'generated/**'],
    })
    expect(argv).toContain('--glob')
    expect(argv).toContain('*.ts')
    expect(argv).toContain('src/**/include')
    expect(argv).toContain('!*.lua')
    expect(argv).toContain('!generated/**')
    // 正选 glob 不带 !，排除 glob 带 !
    const globs = argv.slice(argv.indexOf('--glob'), argv.indexOf('--'))
    expect(globs).toContain('*.ts')
    expect(globs).not.toContain('!*.ts')
  })

  it('ignores blank include/exclude entries', () => {
    const argv = contentArgv('rg', 'C:/ws', { ctx: null, session: null, cwd: 'C:/ws', query: 'foo', include: ['', '  '], exclude: [] })
    const globs = argv.slice(argv.indexOf('--glob'), argv.indexOf('--'))
    expect(globs.filter((g) => !g.startsWith('!'))).not.toContain('')
  })

  it('splits comma-separated glob text and drops empties', () => {
    expect(splitGlobs('*.ts, src/**/include, , a.lua')).toEqual(['*.ts', 'src/**/include', 'a.lua'])
    expect(splitGlobs('')).toEqual([])
    expect(splitGlobs('  ,  ')).toEqual([])
  })

  it('drops fixed-strings for regex mode', () => {
    const argv = contentArgv('rg', 'C:/ws', { ctx: null, session: null, cwd: 'C:/ws', query: 'fo+', regex: true })
    expect(argv).not.toContain('--fixed-strings')
  })
})

describe('ContentSearcher', () => {
  const fs = fakeFs()
  const ctx = context(fs)

  it('caches per query/root and skips short queries', async () => {
    const provider = vi.fn(async () => result([{ path: 'a.lua', line: 1, startColumn: 1, endColumn: 4, text: 'foo' }]))
    const searcher = new ContentSearcher(ctx, { search: provider })
    const request = { session: { header: { cwd: 'ws' } }, cwd: 'ws', query: 'foo' }
    const first = await searcher.search(request)
    const second = await searcher.search(request)
    expect(first.matches).toEqual(second.matches)
    expect(provider).toHaveBeenCalledTimes(1)
    const short = await searcher.search({ ...request, query: 'f' })
    expect(short.matches).toEqual([])
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('aborts the previous inflight search for the same root', async () => {
    const provider = vi.fn((input) => new Promise((resolve, reject) => {
      input.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      setTimeout(() => { if (!input.signal?.aborted) resolve(result([{ path: 'a.lua', line: 1, startColumn: 1, endColumn: 4, text: 'x' }])) }, 20)
    }))
    const searcher = new ContentSearcher(ctx, { search: provider })
    const request = { session: { header: { cwd: 'ws' } }, cwd: 'ws', query: 'foo' }
    const first = searcher.search(request)
    const second = await searcher.search(request)
    expect(second.matches).toHaveLength(1)
    expect(await first).toEqual({ matches: [], truncated: false })
    expect(provider).toHaveBeenCalledTimes(2)
  })

  it('rethrows provider failures and clears cache on dispose', async () => {
    const provider = vi.fn(async () => { throw new Error('boom') })
    const searcher = new ContentSearcher(ctx, { search: provider })
    await expect(searcher.search({ session: { header: { cwd: 'ws' } }, cwd: 'ws', query: 'foo' })).rejects.toThrow('boom')
    searcher.dispose('ws')
  })

  it('distinguishes cache entries by include/exclude filters', async () => {
    const provider = vi.fn(async () => result([{ path: 'a.lua', line: 1, startColumn: 1, endColumn: 4, text: 'x' }]))
    const searcher = new ContentSearcher(ctx, { search: provider })
    const base = { session: { header: { cwd: 'ws' } }, cwd: 'ws', query: 'foo' }
    await searcher.search(base)
    await searcher.search(base)
    await searcher.search({ ...base, include: ['*.ts'] })
    expect(provider).toHaveBeenCalledTimes(2)
    expect(provider.mock.calls[1][0].include).toEqual(['*.ts'])
  })
})

describe('edrv.searchContent RPC handler', () => {
  function rpcCtx() {
    const sessions = { get: (id: string) => ({ id, header: { cwd: 'ws1' } }), list: () => [] }
    return { get: (name: string) => (name === 'sessions' ? sessions : undefined) }
  }

  it('maps request args and returns matches', async () => {
    const search = vi.fn(async () => ({ matches: [{ path: 'a.lua', line: 2, startColumn: 4, endColumn: 7, text: 'x' }], truncated: false }))
    const handlers = buildHandlers(rpcCtx(), new Map(), undefined, { search })
    const out = await handlers['edrv.searchContent']({ sessionId: 's1', query: 'foo', matchCase: true, maxResults: 50, include: ['*.ts'], exclude: ['*.lua'] })
    expect(out).toEqual({ ok: true, matches: [{ path: 'a.lua', line: 2, startColumn: 4, endColumn: 7, text: 'x' }], truncated: false })
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: 'foo', cwd: 'ws1', matchCase: true, maxResults: 50, include: ['*.ts'], exclude: ['*.lua'] }))
  })

  it('returns error response when the searcher fails', async () => {
    const search = vi.fn(async () => { throw new Error('ripgrep 不可用') })
    const handlers = buildHandlers(rpcCtx(), new Map(), undefined, { search })
    const out = await handlers['edrv.searchContent']({ sessionId: 's1', query: 'foo' })
    expect(out.ok).toBe(false)
    expect((out as { error: string }).error).toContain('ripgrep 不可用')
  })
})
