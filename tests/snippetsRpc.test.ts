/**
 * host rpc.ts 代码片段接线测试：
 * ① snippets.* 五个 handler 的 ok/err 传播；
 * ② edrv.read / edrv.save 的「全局片段文件」分支——片段目录在工作区之外，
 *    必须在无会话/无 cwd 时也能读写，且保存不得触发差异审查（afterManualSave 跳过）；
 * ③ 非片段路径仍走原会话前置（行为不变，防止分支过宽）。
 * 作者 ddj 2026-09-10
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHandlers } from '../src/rpc.js'
import { userSnippetsDir } from '../src/snippets.js'

const SIDECAR = '.dsh-edit-review.json'
const CWD = '/ws'

/** 内存 fake fs（含 stat/writeText 捕获，sidecar 读写可见）。 */
function fakeFs(files: Record<string, string> = {}): any {
  const store = new Map(Object.entries(files))
  const written: string[] = []
  return {
    written,
    store,
    resolve: async (p: string, opts?: { cwd?: string }) => {
      const cwd = opts?.cwd ?? ''
      if (p === SIDECAR) return cwd + '/' + p
      if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return p
      return cwd + '/' + p
    },
    readText: async (target: string) => {
      if (!store.has(target)) throw new Error('not found: ' + target)
      return store.get(target)!
    },
    writeText: async (target: string, content: string) => { written.push(target); store.set(target, content) },
    stat: async (target: string) => (store.has(target) ? { type: 'file', size: store.get(target)!.length } : undefined),
  }
}

/** 无会话 / 有会话两种 ctx（片段分支不应依赖会话）。 */
function fakeCtx(fs: any, opts: { withSession?: boolean; withWorkspace?: boolean } = {}): any {
  const ws = opts.withWorkspace ? [{ path: CWD, title: 'WS' }] : []
  const sessions = {
    get: (id: string) => (id === 's1' ? { id: 's1', header: { cwd: CWD } } : undefined),
    list: () => (opts.withSession ? [{ id: 's1', header: { cwd: CWD } }] : []),
  }
  return {
    get: (name: string) => {
      if (name === 'fs') return fs
      if (name === 'sessions') return sessions
      if (name === 'workspaceRegistry') return { list: () => ws }
      if (name === 'sandboxPolicy') return { resolve: (r: { mode: string }) => ({ mode: r.mode }) }
      return undefined
    },
  }
}

let home = ''

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'edrv-snippets-rpc-'))
  process.env.DSH_HOME = home
  await mkdir(userSnippetsDir(home), { recursive: true })
})

afterAll(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

describe('edrv.read 全局片段分支', () => {
  it('无会话也不会报「会话不存在」：片段目录在工作区之外，不走 cwd 解析', async () => {
    const file = join(userSnippetsDir(home), 'missing.code-snippets')
    const handlers = buildHandlers(fakeCtx(fakeFs()))
    const res = await handlers['edrv.read']({ path: file })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      // 命中片段分支（而非被会话前置拦下），并带出解析后的真实路径便于诊断
      expect(String(res.error)).toContain('读取片段文件失败')
      expect(String(res.error)).not.toContain('会话不存在')
    }
  })

  it('文件存在时直读内容', async () => {
    const file = join(userSnippetsDir(home), 'read.code-snippets')
    const handlers = buildHandlers(fakeCtx(fakeFs()))
    await handlers['edrv.save']({ path: file, content: '{"a":{"body":"A"}}' } as never)
    const res = await handlers['edrv.read']({ path: file })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.content).toBe('{"a":{"body":"A"}}')
      expect(res.size).toBe('{"a":{"body":"A"}}'.length)
    }
  })

  it('非片段路径仍走会话前置（分支不过宽）', async () => {
    const handlers = buildHandlers(fakeCtx(fakeFs()))
    const res = await handlers['edrv.read']({ path: CWD + '/a.ts' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(String(res.error)).toBe('会话不存在')
  })
})

describe('edrv.save 全局片段分支', () => {
  it('无会话可保存，且不触发差异审查（不写 sidecar）', async () => {
    const fs = fakeFs()
    const handlers = buildHandlers(fakeCtx(fs))
    const file = join(userSnippetsDir(home), 'save.code-snippets')
    const res = await handlers['edrv.save']({ path: file, content: '{"a":{"body":"A"}}' } as never)
    expect(res.ok).toBe(true)
    // 真落盘
    expect(await readFile(file, 'utf8')).toBe('{"a":{"body":"A"}}')
    // afterManualSave 被跳过：没有任何 sidecar 写入
    expect(fs.written.some((p: string) => p.includes(SIDECAR))).toBe(false)
  })

  it('非片段路径仍走会话前置（分支不过宽）', async () => {
    const handlers = buildHandlers(fakeCtx(fakeFs()))
    const res = await handlers['edrv.save']({ path: CWD + '/a.ts', content: 'x' } as never)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(String(res.error)).toBe('会话不存在')
  })
})

describe('snippets.* handler 分派', () => {
  it('list / read / save / remove / entries 全链路可用', async () => {
    const ctx = fakeCtx(fakeFs())
    const handlers = buildHandlers(ctx)
    const file = 'rpc-demo.code-snippets'

    const saved = await handlers['snippets.save']({ scope: 'user', file, content: '{"d":{"prefix":"dd","body":"D"}}' })
    expect(saved.ok).toBe(true)

    const listed = await handlers['snippets.list']({} as never)
    expect(listed.ok).toBe(true)
    if (listed.ok) expect(listed.user.map((item) => item.file)).toContain(file)

    const read = await handlers['snippets.read']({ scope: 'user', file })
    expect(read.ok).toBe(true)

    const entries = await handlers['snippets.entries']({})
    expect(entries.ok).toBe(true)
    if (entries.ok) expect(entries.entries.map((item) => item.key)).toContain('d')

    const removed = await handlers['snippets.remove']({ scope: 'user', file })
    expect(removed.ok).toBe(true)
  })

  it('失败以 ok:false + 中文错误返回（不抛出）', async () => {
    const handlers = buildHandlers(fakeCtx(fakeFs()))
    const bad = await handlers['snippets.save']({ scope: 'user', file: '../evil.code-snippets', content: '{}' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(String(bad.error)).toContain('保存代码片段失败')

    const missing = await handlers['snippets.read']({ scope: 'user', file: 'nope.code-snippets' })
    expect(missing.ok).toBe(false)

    const denied = await handlers['snippets.save']({ scope: 'project', workspacePath: CWD, file: 'p.code-snippets', content: '{}' })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(String(denied.error)).toContain('未注册')
  })

  it('entries 在无会话时降级为仅全局片段（不报错，补全仍可用）', async () => {
    const handlers = buildHandlers(fakeCtx(fakeFs()))
    const res = await handlers['snippets.entries']({ sessionId: 'missing' })
    expect(res.ok).toBe(true)
  })
})
