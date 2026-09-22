/**
 * 文件搜索 provider、排序和编排测试。
 * 作者 ddj 2026-08-24
 */
import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filesArgv, queryGlob, parseOutput, ripgrepPath, searchRoot } from '../src/search/ripgrep.js'
import { pathText, prepareQuery } from '../src/search/query.js'
import { candidateOf, rankCandidates } from '../src/search/ranker.js'
import { SearchCache, SearchOrchestrator } from '../src/search/orchestrator.js'
import type { WorkspaceSearchProvider } from '../src/search/types.js'

function context(fs: unknown, policy?: unknown): any {
  return { get: (name: string) => name === 'fs' ? fs : name === 'sandboxPolicy' ? policy : undefined }
}

function fakeFs(): any {
  return {
    resolve: vi.fn(async (path: string, opts?: { cwd?: string }) => ({ targetKey: path, displayPath: opts?.cwd ? opts.cwd + '/' + path : path })),
    processPath: vi.fn((target: { displayPath: string }) => 'processed:' + target.displayPath),
  }
}

function result(files: string[], truncated = false): any {
  return { files, truncated, complete: !truncated, source: 'ripgrep' }
}

describe('file search query', () => {
  it('normalizes slash direction and escapes glob syntax', () => {
    expect(pathText('Assets\\Scripts')).toBe('Assets/Scripts')
    expect(queryGlob('*?[]!')).toBe('**/*\\*\\?\\[\\]\\!*')
    // 路径分隔符保留，便于整段路径查询
    expect(queryGlob('Assets\\Scripts')).toContain('/')
    expect(queryGlob('Assets\\Scripts')).toBe('**/*[aA][sS][sS][eE][tT][sS]/[sS][cC][rR][iI][pP][tT][sS]*')
  })

  it('keeps shell metacharacters as literal argv data', () => {
    const glob = queryGlob('a&b|c;d$e')
    expect(glob).toContain('&')
    expect(glob).toContain('|')
    expect(glob).toContain(';')
    expect(glob).toContain('$')
    expect(glob).not.toContain('\\&')
  })

  it('encodes case-insensitivity as character classes, not a global flag', () => {
    expect(queryGlob('BuildLogic')).toBe('**/*[bB][uU][iI][lL][dD][lL][oO][gG][iI][cC]*')
    // 数字/中文等无大小写之分的字符原样保留
    expect(queryGlob('a1中')).toBe('**/*[aA]1中*')
  })
})

describe('search root', () => {
  it('prefers policy workspace root and processes the resolved target', async () => {
    const fs = fakeFs()
    const session = { header: { cwd: 'session-root' } }
    const root = await searchRoot(context(fs, { resolve: vi.fn(() => ({ workspaceRoot: 'policy-root' })) }), session)
    expect(root).toBe('processed:session-root/policy-root')
    expect(fs.resolve).toHaveBeenCalledWith('policy-root', { cwd: 'session-root' })
    expect(fs.processPath).toHaveBeenCalledOnce()
  })

  it('uses session cwd when policy is absent', async () => {
    const fs = fakeFs()
    const root = await searchRoot(context(fs), { header: { cwd: 'session-root' } })
    expect(root).toBe('processed:session-root/.')
  })
})

describe('ripgrep output', () => {
  it('parses unique paths and reports output loss', () => {
    const handle: any = { collected: { stdout: { readFrom: () => ({ text: 'a\nb\na\n', lossy: true }) } } }
    expect(parseOutput(handle, 10)).toEqual({ files: ['a', 'b'], truncated: true, complete: false })
  })
})

describe('ranker and cache', () => {
  it('ranks basename prefix before path matches stably', () => {
    const query = prepareQuery('sky')
    const candidates = [candidateOf('Assets/sky/data.lua', 'workspace'), candidateOf('SkyDashData.lua', 'workspace')]
    expect(rankCandidates(candidates, query).map((item) => item.path)).toEqual(['SkyDashData.lua', 'Assets/sky/data.lua'])
  })

  it('bounds cache entries and expires them', () => {
    const cache = new SearchCache()
    cache.set('root|query', result(['a']), 1)
    expect(cache.get('root|query', 2)?.files).toEqual(['a'])
    expect(cache.get('root|query', 60_001)).toBeUndefined()
  })
})

describe('orchestrator', () => {
  it('merges active diff when provider fails', async () => {
    const fs = fakeFs()
    const provider: WorkspaceSearchProvider = { search: vi.fn(async () => { throw new Error('unavailable') }) }
    const fallback: WorkspaceSearchProvider = { search: vi.fn(async () => { throw new Error('unavailable') }) }
    const searcher = new SearchOrchestrator(context(fs), provider, fallback)
    const response = await searcher.search({ session: { header: { cwd: 'ws' } }, cwd: 'ws', query: 'SkyDash', activePaths: ['Assets/SkyDashData.lua'] })
    expect(response.files).toEqual(['Assets/SkyDashData.lua'])
    expect(response.truncated).toBe(false)
  })

  it('caches successful provider results', async () => {
    const fs = fakeFs()
    const provider: WorkspaceSearchProvider = { search: vi.fn(async () => result(['SkyDashData.lua'])) }
    const searcher = new SearchOrchestrator(context(fs), provider, provider)
    await searcher.search({ session: { header: { cwd: 'ws' } }, cwd: 'ws', query: 'SkyDash', activePaths: [] })
    await searcher.search({ session: { header: { cwd: 'ws' } }, cwd: 'ws', query: 'SkyDash', activePaths: [] })
    expect(provider.search).toHaveBeenCalledOnce()
  })
})

describe('ripgrep provider argv', () => {
  it('passes query and root as separate argv values', async () => {
    const calls: any[] = []
    const fs = fakeFs()
    const subprocess = {
      spawn: vi.fn((spec: any) => {
        calls.push(spec)
        return { done: Promise.resolve({ exitCode: 1, signal: null }), collected: { stdout: { readFrom: () => ({ text: '' }) } } }
      }),
    }
    const ctx: any = { get: (name: string) => name === 'fs' ? fs : name === 'subprocess' ? subprocess : undefined }
    const { searchRipgrep } = await import('../src/search/ripgrep.js')
    const output = await searchRipgrep({ ctx, session: { header: { cwd: 'ws' } }, cwd: 'ws', query: 'a&b', maxResults: 10, root: 'root' })
    expect(output).toEqual({ files: [], truncated: false, complete: true, source: 'ripgrep' })
    expect(calls[0].argv).toContain('**/*[aA]&[bB]*')
    expect(calls[0].argv).toContain('--')
    expect(calls[0].argv.at(-1)).toBe('root')
    expect(calls[0].cwd).toBe('root')
  })

  it('keeps partial results with a warning on traversal errors (exit 2)', async () => {
    const fs = fakeFs()
    const subprocess = { spawn: vi.fn(() => ({ done: Promise.resolve({ exitCode: 2, signal: null }), collected: { stderr: { readFrom: () => ({ text: 'rg: C:\\ws\\broken: 系统找不到指定的文件。 (os error 2)' }) } } })) }
    const ctx: any = { get: (name: string) => name === 'fs' ? fs : name === 'subprocess' ? subprocess : undefined }
    const { searchRipgrep } = await import('../src/search/ripgrep.js')
    const output = await searchRipgrep({ ctx, session: { header: { cwd: 'ws' } }, cwd: 'ws', query: 'bad', maxResults: 10, root: 'root' })
    expect(output.complete).toBe(false)
    expect(output.warning).toContain('部分路径无法访问')
    expect(output.warning).toContain('os error 2')
  })

  it('does not turn hard process failure into an empty success', async () => {
    const fs = fakeFs()
    const subprocess = { spawn: vi.fn(() => ({ done: Promise.resolve({ exitCode: 3, signal: null }) })) }
    const ctx: any = { get: (name: string) => name === 'fs' ? fs : name === 'subprocess' ? subprocess : undefined }
    const { searchRipgrep } = await import('../src/search/ripgrep.js')
    await expect(searchRipgrep({ ctx, session: { header: { cwd: 'ws' } }, cwd: 'ws', query: 'bad', maxResults: 10, root: 'root' })).rejects.toThrow('退出码')
  })
})

/**
 * 回归：全局 --glob-case-insensitive 会把排除 glob 一起变成大小写不敏感，
 * 连 `Module/Build/` 这类源码目录都被 `!**\/build/**` 剔除（Ctrl+P 搜 BuildLogic 恒空）。
 * 正确做法 = 查询词走 --iglob，排除项保持大小写敏感的 --glob。
 * 作者 ddj 2026-09-20
 */
describe('ripgrep case sensitivity contract', () => {
  it('scopes case-insensitivity to the query glob only', () => {
    const argv = filesArgv('rg', 'root', 'buildlogic')
    // 查询词走大小写不敏感的字符类 glob
    const inc = argv.indexOf('--glob')
    expect(argv[inc + 1]).toBe('**/*[bB][uU][iI][lL][dD][lL][oO][gG][iI][cC]*')
    // 这两个开关都会破坏排除项：前者波及黑名单 glob，后者覆盖全部黑名单 glob
    expect(argv).not.toContain('--glob-case-insensitive')
    expect(argv).not.toContain('--iglob')
    // 排除项必须是大小写敏感的 --glob
    const idx = argv.indexOf('!**/build/**')
    expect(idx).toBeGreaterThan(-1)
    expect(argv[idx - 1]).toBe('--glob')
  })

  it('finds Build/ sources while still excluding build/ and node_modules', () => {
    const binary = ripgrepPath()
    if (!binary) return
    const root = mkdtempSync(join(tmpdir(), 'edrv-search-'))
    try {
      mkdirSync(join(root, 'Assets', 'Module', 'Build', 'Logic'), { recursive: true })
      mkdirSync(join(root, 'build'), { recursive: true })
      mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(root, 'Assets', 'Module', 'Build', 'Logic', 'BuildLogic.lua'), 'return {}')
      writeFileSync(join(root, 'build', 'GenBuild.js'), 'var x = 1')
      writeFileSync(join(root, 'node_modules', 'pkg', 'BuildLogicCopy.js'), 'var y = 2')
      const run = (query: string): string[] => {
        // argv[0] 是二进制自身，execFileSync 的 file 参数才是它，必须剥离，
        // 否则会被当成又一个搜索路径而使排除 glob 失效
        const argv = filesArgv(binary, root, query).slice(1)
        try {
          return execFileSync(binary, argv, { encoding: 'utf8' })
            .split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        } catch (error) {
          // rg 无命中时退出码 1，此时 stdout 仍为有效（空）结果
          return String((error as { stdout?: string })?.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        }
      }
      // ① 小写查询必须命中大写目录下的源码（本 bug 的正题）
      const hits = run('buildlogic')
      expect(hits.some((p) => p.endsWith('BuildLogic.lua'))).toBe(true)
      // ② 小写 build/ 构建产物与被忽略的 node_modules 必须仍被排除
      expect(hits.some((p) => p.endsWith('GenBuild.js'))).toBe(false)
      expect(hits.some((p) => p.includes('node_modules'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

