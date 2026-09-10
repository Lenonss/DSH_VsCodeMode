/**
 * 代码片段（VS Code 兼容 .code-snippets）测试：
 * 纯函数（文件名校验 / JSON 容错解析 / 语言推导 / 条目展开 / 模板）、
 * IO（tmpdir + mock ctx：全局与项目域 save → list → read → remove 全链路）、
 * 全局路径判定（isSnippetFilePath）、补全条目按语言的过滤与项目覆盖（client 纯函数）。
 * 作者 ddj 2026-09-10
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  entriesOfFile, flattenSnippetEntries, isSnippetFilePath, languageOfSnippetFile,
  normalizeBody, normalizePrefix, normalizeScope,
  parseSnippetsJson, projectSnippetsDir,
  snippetsEntries, snippetsList,
  snippetsRead, snippetsRemove, snippetsSave, userSnippetsDir, validateSnippetFile,
} from '../src/snippets.js'
import { entriesForLanguage } from '../src/client/snippets/provider.js'
import {
  normalizeSnippetFileName, snippetFileNameFor, snippetFileTemplate,
} from '../src/shared/snippets.js'
import type { SnippetInfo } from '../src/shared/snippets.js'

// --region 纯函数：文件名与语言推导
describe('validateSnippetFile', () => {
  it('合法名通过（返回 null）', () => {
    expect(validateSnippetFile('global.code-snippets')).toBeNull()
    expect(validateSnippetFile('typescript.code-snippets')).toBeNull()
    expect(validateSnippetFile('lua51.code-snippets')).toBeNull()
    expect(validateSnippetFile('my-team.code-snippets')).toBeNull()
  })

  it('非法名拒绝：路径穿越 / 空扩展 / 其它后缀 / 保留设备名', () => {
    expect(validateSnippetFile('../evil.code-snippets')).not.toBeNull()
    expect(validateSnippetFile('a\\b.code-snippets')).not.toBeNull()
    expect(validateSnippetFile('noext')).not.toBeNull()
    expect(validateSnippetFile('x.json')).not.toBeNull()
    expect(validateSnippetFile('CON.code-snippets')).not.toBeNull()
  })
})

describe('languageOfSnippetFile', () => {
  it('按文件名前缀推导语言；global / 空前缀为空串（全语言）', () => {
    expect(languageOfSnippetFile('typescript.code-snippets')).toBe('typescript')
    expect(languageOfSnippetFile('Lua.code-snippets')).toBe('lua')
    expect(languageOfSnippetFile('global.code-snippets')).toBe('')
    expect(languageOfSnippetFile('.code-snippets')).toBe('')
  })
})

describe('normalizeSnippetFileName / snippetFileNameFor', () => {
  it('裸语言名补后缀；已有后缀保持不变；空串为空', () => {
    expect(normalizeSnippetFileName('python')).toBe('python.code-snippets')
    expect(normalizeSnippetFileName('python.code-snippets')).toBe('python.code-snippets')
    expect(normalizeSnippetFileName('  ')).toBe('')
  })

  it('语言 id → 默认文件名；空语言回退 global', () => {
    expect(snippetFileNameFor('lua')).toBe('lua.code-snippets')
    expect(snippetFileNameFor('Lua')).toBe('lua.code-snippets')
    expect(snippetFileNameFor('')).toBe('global.code-snippets')
    expect(snippetFileNameFor(undefined as unknown as string)).toBe('global.code-snippets')
  })

  it('host 侧同名导出与 shared 同一实现（单一真源，避免两处漂移）', async () => {
    const host = await import('../src/snippets.js')
    expect(host.normalizeSnippetFileName).toBe(normalizeSnippetFileName)
    expect(host.snippetFileTemplate).toBe(snippetFileTemplate)
  })
})
// --endregion

// --region 纯函数：JSON 容错解析
describe('parseSnippetsJson', () => {
  it('标准声明：prefix/body/description/scope 归一化', () => {
    const parsed = parseSnippetsJson(JSON.stringify({
      '日志打印': { prefix: 'log', body: ['console.log($1)', '$2'], description: '打日志' },
    }))
    expect(parsed.error).toBeUndefined()
    expect(parsed.entries['日志打印'].prefix).toBe('log')
    expect(parsed.entries['日志打印'].body).toBe('console.log($1)\n$2')
    expect(parsed.entries['日志打印'].description).toBe('打日志')
  })

  it('body 字符串直接使用；prefix 数组取首项；scope 数组小写化', () => {
    const parsed = parseSnippetsJson(JSON.stringify({
      a: { prefix: ['p1', 'p2'], body: 'BODY', scope: ['Lua', 'CSS'] },
    }))
    expect(parsed.entries.a.prefix).toBe('p1')
    expect(parsed.entries.a.body).toBe('BODY')
    expect(parsed.entries.a.scope).toEqual(['lua', 'css'])
  })

  it('body 缺失/非法的条目静默跳过（不拖垮其他条目）', () => {
    const parsed = parseSnippetsJson(JSON.stringify({
      good: { prefix: 'g', body: 'G' },
      noBody: { prefix: 'n' },
      badType: { body: 42 },
    }))
    expect(Object.keys(parsed.entries)).toEqual(['good'])
  })

  it('JSON 损坏 / 顶层非对象 → error 文案且 entries 为空', () => {
    expect(parseSnippetsJson('{ 不是 json').error).toContain('JSON 解析失败')
    expect(parseSnippetsJson('[1,2,3]').error).toContain('顶层必须是对象')
    expect(Object.keys(parseSnippetsJson('[1,2,3]').entries)).toEqual([])
  })

  it('空文本视为空片段集（不报错）', () => {
    expect(parseSnippetsJson('')).toEqual({ entries: {} })
    expect(parseSnippetsJson('   ')).toEqual({ entries: {} })
  })

  it('BOM 前缀可解析', () => {
    expect(Object.keys(parseSnippetsJson('\uFEFF{"a":{"body":"A"}}').entries)).toEqual(['a'])
  })
})

describe('normalizeBody / normalizePrefix / normalizeScope', () => {
  it('body 数组按行拼接并丢弃非字符串项', () => {
    expect(normalizeBody(['a', 1, 'b'])).toBe('a\nb')
    expect(normalizeBody(null)).toBe('')
  })

  it('prefix 数组取首个字符串项并去空白', () => {
    expect(normalizePrefix(['  x  '])).toBe('x')
    expect(normalizePrefix(42)).toBe('')
  })

  it('scope 归一为小写去空数组', () => {
    expect(normalizeScope(' Lua ')).toEqual(['lua'])
    expect(normalizeScope(['A', ''])).toEqual(['a'])
    expect(normalizeScope(undefined)).toEqual([])
  })
})
// --endregion

// --region 纯函数：条目展开
describe('entriesOfFile / flattenSnippetEntries', () => {
  const info = (file: string, language: string, scope: SnippetInfo['scope'] = 'user'): SnippetInfo => ({
    scope, file, absPath: join('~', file), relHint: scope === 'project' ? '.dsh/snippets/' : 'snippets/',
    language, count: 1, size: 10, mtime: 0,
  })

  it('条目无 scope 时继承文件语言；global 文件 → 全语言（language 空串）', () => {
    const parsed = parseSnippetsJson('{"a":{"prefix":"p","body":"B"}}')
    expect(entriesOfFile(info('lua.code-snippets', 'lua'), parsed)[0].language).toBe('lua')
    expect(entriesOfFile(info('global.code-snippets', ''), parsed)[0].language).toBe('')
  })

  it('条目 scope 覆盖文件语言（一条声明可挂多语言）', () => {
    const parsed = parseSnippetsJson('{"a":{"prefix":"p","body":"B","scope":["lua","csharp"]}}')
    const entries = entriesOfFile(info('global.code-snippets', ''), parsed)
    expect(entries.map((e) => e.language).sort()).toEqual(['csharp', 'lua'])
  })

  it('flatten 汇总多文件条目', () => {
    const one = parseSnippetsJson('{"a":{"prefix":"p","body":"A"}}')
    const two = parseSnippetsJson('{"b":{"prefix":"q","body":"B"}}')
    const flat = flattenSnippetEntries([
      { info: info('lua.code-snippets', 'lua'), parsed: one },
      { info: info('global.code-snippets', ''), parsed: two },
    ])
    expect(flat.map((e) => e.key)).toEqual(['a', 'b'])
  })
})

describe('snippetFileTemplate', () => {
  it('生成合法 JSON 且可被自身解析（含尾换行）', () => {
    const text = snippetFileTemplate('lua')
    expect(text.endsWith('\n')).toBe(true)
    const parsed = parseSnippetsJson(text)
    expect(parsed.error).toBeUndefined()
    expect(Object.keys(parsed.entries).length).toBe(1)
    expect(parsed.entries[Object.keys(parsed.entries)[0]].prefix).toBe('hello')
  })
})
// --endregion

// --region 全局路径判定
describe('isSnippetFilePath', () => {
  it('命中全局片段目录内文件（分隔符归一化）', () => {
    const dir = userSnippetsDir()
    expect(isSnippetFilePath(dir + '/lua.code-snippets')).toBe(true)
    expect(isSnippetFilePath(dir.replace(/\//g, '\\') + '\\lua.code-snippets')).toBe(true)
  })

  it('拒绝目录外 / 子目录 / 非片段文件', () => {
    expect(isSnippetFilePath('/tmp/other/lua.code-snippets')).toBe(false)
    expect(isSnippetFilePath(userSnippetsDir() + '/sub/lua.code-snippets')).toBe(false)
    expect(isSnippetFilePath(userSnippetsDir() + '/notes.txt')).toBe(false)
    expect(isSnippetFilePath('')).toBe(false)
  })
})
// --endregion

// --region IO（tmpdir + mock ctx）
let home = ''
let projectA = ''
/** 项目写盘捕获（ctx fs mock）。 */
const written = new Map<string, string>()

/** 构造最小 mock ctx（fs / sandboxPolicy / workspaceRegistry）。 */
function mockCtx(withWorkspace: boolean): any {
  return {
    get(name: string) {
      if (name === 'fs') {
        return {
          resolve: async (p: string, o: { cwd: string }) => join(o.cwd, p),
          writeText: async (t: string, c: string) => { written.set(t, c); await writeFile(t, c, 'utf8') },
          readText: async (t: string) => readFile(t, 'utf8'),
        }
      }
      if (name === 'sandboxPolicy') return { resolve: (r: { mode: string }) => ({ mode: r.mode }) }
      if (name === 'workspaceRegistry') return { list: () => (withWorkspace ? [{ path: projectA, title: '项目A' }] : []) }
      return undefined
    },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  }
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'edrv-snippets-'))
  projectA = join(home, 'projA')
  process.env.DSH_HOME = home
  await mkdir(projectA, { recursive: true })
})

afterAll(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

describe('snippets IO（全局域）', () => {
  it('save → list → read → remove 全链路', async () => {
    const ctx = mockCtx(false)
    const content = JSON.stringify({ '日志': { prefix: 'log', body: 'console.log($1)' } })
    const saved = await snippetsSave(ctx, { scope: 'user', file: 'typescript.code-snippets', content })
    expect(saved.language).toBe('typescript')
    expect(saved.count).toBe(1)
    expect(saved.absPath).toBe(join(userSnippetsDir(), 'typescript.code-snippets'))

    const list = await snippetsList(ctx)
    expect(list.user.map((f) => f.file)).toContain('typescript.code-snippets')
    expect(await snippetsRead(ctx, { scope: 'user', file: 'typescript.code-snippets' })).toBe(content)

    await snippetsRemove(ctx, { scope: 'user', file: 'typescript.code-snippets' })
    expect(existsSync(join(home, 'snippets', 'typescript.code-snippets'))).toBe(false)
  })

  it('save 非法文件名拒绝', async () => {
    await expect(snippetsSave(mockCtx(false), { scope: 'user', file: '../evil.code-snippets', content: '{}' })).rejects.toThrow()
  })

  it('JSON 损坏的文件仍列出（error 提示），不影响其他文件', async () => {
    const ctx = mockCtx(false)
    await snippetsSave(ctx, { scope: 'user', file: 'broken.code-snippets', content: '{ oops' })
    await snippetsSave(ctx, { scope: 'user', file: 'good.code-snippets', content: '{"a":{"body":"A"}}' })
    const list = await snippetsList(ctx)
    const broken = list.user.find((f) => f.file === 'broken.code-snippets')
    const good = list.user.find((f) => f.file === 'good.code-snippets')
    expect(broken?.error).toBeTruthy()
    expect(good?.error).toBeUndefined()
    expect(good?.count).toBe(1)
    await snippetsRemove(ctx, { scope: 'user', file: 'broken.code-snippets' })
    await snippetsRemove(ctx, { scope: 'user', file: 'good.code-snippets' })
  })

  it('list 目录缺失返回空而非报错', async () => {
    const list = await snippetsList(mockCtx(false))
    expect(Array.isArray(list.user)).toBe(true)
    expect(Array.isArray(list.projects)).toBe(true)
  })
})

describe('snippets IO（项目域）', () => {
  it('未注册 workspace 拒绝写入', async () => {
    await expect(snippetsSave(mockCtx(false), { scope: 'project', workspacePath: projectA, file: 'p.code-snippets', content: '{}' })).rejects.toThrow('未注册')
  })

  it('已注册 workspace：mkdir + ctx fs 写盘（fullPolicy），list 可见', async () => {
    const ctx = mockCtx(true)
    const saved = await snippetsSave(ctx, { scope: 'project', workspacePath: projectA, file: 'lua.code-snippets', content: '{"p":{"prefix":"x","body":"P"}}' })
    expect(saved.scope).toBe('project')
    expect(saved.relHint).toBe('.dsh/snippets/')
    const key = [...written.keys()].find((k) => k.endsWith('lua.code-snippets'))
    expect(key).toBeDefined()
    expect(existsSync(projectSnippetsDir(projectA))).toBe(true)

    const list = await snippetsList(ctx)
    const proj = list.projects.find((p) => p.workspacePath === projectA)
    expect(proj?.title).toBe('项目A')
    expect(proj?.files.map((f) => f.file)).toContain('lua.code-snippets')
  })

  it('无 .dsh/snippets 的已注册工作区 → missingDir 标记', async () => {
    const bare = join(home, 'projBare')
    await mkdir(bare, { recursive: true })
    const ctx = mockCtx(false)
    ctx.get = (name: string) => (name === 'workspaceRegistry' ? { list: () => [{ path: bare, title: 'Bare' }] } : undefined)
    const list = await snippetsList(ctx)
    expect(list.projects[0]?.missingDir).toBe(true)
  })
})

describe('snippetsEntries（补全载荷）', () => {
  it('聚合全局片段；带已注册工作区时叠加项目片段（项目靠后）', async () => {
    const ctx = mockCtx(true)
    await snippetsSave(ctx, { scope: 'user', file: 'global.code-snippets', content: '{"g":{"prefix":"gg","body":"G"}}' })
    await snippetsSave(ctx, { scope: 'project', workspacePath: projectA, file: 'lua.code-snippets', content: '{"p":{"prefix":"pp","body":"P"}}' })

    const all = await snippetsEntries(ctx)
    expect(all.entries.map((e) => e.key)).toEqual(['g'])

    const withProject = await snippetsEntries(ctx, projectA)
    expect(withProject.entries.map((e) => e.key)).toEqual(['g', 'p'])
    expect(withProject.entries[1].scope).toBe('project')
  })

  it('未注册工作区路径不叠加项目片段（不报错）', async () => {
    const ctx = mockCtx(true)
    const result = await snippetsEntries(ctx, join(home, 'not-registered'))
    expect(Array.isArray(result.entries)).toBe(true)
  })

  it('损坏文件不进入载荷', async () => {
    const ctx = mockCtx(false)
    await snippetsSave(ctx, { scope: 'user', file: 'bad.code-snippets', content: 'nope' })
    const result = await snippetsEntries(ctx)
    expect(result.entries.every((e) => e.file !== 'bad.code-snippets')).toBe(true)
    await snippetsRemove(ctx, { scope: 'user', file: 'bad.code-snippets' })
  })
})
// --endregion

// --region client 补全过滤（纯函数）
describe('entriesForLanguage', () => {
  const entry = (key: string, language: string, scope = 'user') => ({ key, prefix: key, body: 'B', description: '', scope, file: key + '.code-snippets', language })

  it('全语言条目对所有语言生效；指定语言条目只对该语言生效', () => {
    const list = [entry('any', ''), entry('luaOnly', 'lua'), entry('cssOnly', 'css')]
    expect(entriesForLanguage(list, 'lua').map((e) => e.key)).toEqual(['any', 'luaOnly'])
    expect(entriesForLanguage(list, 'css').map((e) => e.key)).toEqual(['any', 'cssOnly'])
    expect(entriesForLanguage(list, 'python').map((e) => e.key)).toEqual(['any'])
  })

  it('项目条目覆盖同 key 的全局条目，且排在全局之后', () => {
    const list = [entry('same', '', 'user'), entry('own', '', 'user'), entry('same', '', 'project')]
    const merged = entriesForLanguage(list, 'lua')
    expect(merged.map((e) => e.key)).toEqual(['own', 'same'])
    expect(merged[merged.length - 1].scope).toBe('project')
  })

  it('语言 id 大小写不敏感', () => {
    expect(entriesForLanguage([entry('x', 'Lua')], 'lua').map((e) => e.key)).toEqual(['x'])
  })

  it('空输入返回空数组', () => {
    expect(entriesForLanguage([], 'lua')).toEqual([])
  })
})
// --endregion
