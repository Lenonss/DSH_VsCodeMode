/**
 * 文件搜索 provider、排序和编排测试。
 * 作者 ddj 2026-08-24
 */
import { describe, expect, it, vi } from 'vitest'
import { queryGlob, parseOutput, searchRoot } from '../src/search/ripgrep.js'
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
    expect(queryGlob('a*b?[x]!')).toBe('**/*a\\*b\\?\\[x\\]\\!*')
    expect(queryGlob('Assets\\Scripts')).toBe('**/*Assets/Scripts*')
  })

  it('keeps shell metacharacters as literal argv data', () => {
    const glob = queryGlob('a&b|c;d$e')
    expect(glob).toContain('a&b|c;d$e')
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
    expect(calls[0].argv).toContain('**/*a&b*')
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

