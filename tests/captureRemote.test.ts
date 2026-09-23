/**
 * host capture.ts 远端写入捕获测试（issue #7）。
 * 覆盖：remote_ssh_write 捕获 + 镜像写穿 / 内容无变化跳过 / 新建 / 非远程不进分支 /
 *       非编辑类工具与失败结果跳过 / 镜像外路径 note / 写穿失败降级 / 本地 write 回归。
 * CI 为 ubuntu：路径断言 path.join 构造 + 反斜杠归一，不写死盘符/分隔符。
 * 作者 ddj 2026-09-23
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureToolResult } from '../src/capture.js'
import type { DiffRecord } from '../src/shared/types.js'
import type { Registry } from '../src/registry.js'
import { clearWsCache } from '../src/remoteWorkspace.js'
import { disposeIndex } from '../src/treeIndex.js'

/** 反斜杠归一（Windows 本地与 ubuntu CI 同断言）。 */
const norm = (p: string): string => p.replace(/\\/g, '/')

const FULL_MARKER = { profileId: 'p1', host: 'hpc.example', user: 'u', remotePath: '/home/u/proj' }
/** remote_ssh_write 成功结果的最小形状（本实现只看 isError/value 存在性）。 */
const okResult = { value: { ok: true }, isError: false }

/** fake ctx：fs 服务以 node:fs 实现代理 sidecar IO（loadBucket/saveBucket 用）。 */
function fakeCtx() {
  return {
    get: (name: string) => {
      if (name !== 'fs') return undefined
      return {
        resolve: async (p: string, opts?: { cwd?: string }) => (opts?.cwd ? join(opts.cwd, p) : p),
        processPath: (p: string) => p,
        readText: (p: string) => readFile(p, 'utf8'),
        writeText: async (p: string, text: string) => {
          await mkdir(dirname(p), { recursive: true })
          await writeFile(p, text, 'utf8')
        },
      }
    },
  }
}

let base: string
const cwds: string[] = []

/** 造一个会话工作区（withMarker 时写入合法远程标记）。 */
function mkWorkspace(withMarker: boolean): string {
  const root = mkdtempSync(join(base, 'ws-'))
  cwds.push(root)
  if (withMarker) writeFileSync(join(root, '.remote-ssh.json'), JSON.stringify(FULL_MARKER))
  return root
}

/** 构造 tools/result 的 exec 形状（cwd 经 agent.session.header.cwd 提供）。 */
function execOf(name: string, args: Record<string, unknown>, cwd: string, callId = 'c1') {
  return { name, callId, arguments: args, agent: { session: { header: { cwd } } } }
}

/** 取某工作区捕获桶里的记录。 */
function recOf(registry: Registry, cwd: string, callId: string): DiffRecord | undefined {
  return registry.get(cwd)?.get(callId)
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'edrv-cap-'))
  cwds.length = 0
  clearWsCache()
})

afterEach(() => {
  for (const cwd of cwds) disposeIndex(cwd)
  clearWsCache()
  rmSync(base, { recursive: true, force: true })
})

describe('captureToolResult · remote_ssh_write（issue #7）', () => {
  it('捕获远端写入并写穿镜像（before=镜像快照，after=参数 content）', async () => {
    const cwd = mkWorkspace(true)
    mkdirSync(join(cwd, 'src'))
    writeFileSync(join(cwd, 'src', 'a.txt'), 'old')
    const registry: Registry = new Map()
    await captureToolResult(fakeCtx(), registry, execOf('remote_ssh_write', { path: 'src/a.txt', content: 'new' }, cwd), okResult)
    const rec = recOf(registry, cwd, 'c1')
    expect(rec).toBeDefined()
    expect(rec!.toolName).toBe('remote_ssh_write')
    expect(norm(rec!.path)).toBe(norm(join(cwd, 'src', 'a.txt')))
    expect(rec!.before).toBe('old')
    expect(rec!.after).toBe('new')
    expect(rec!.create).toBe(false)
    expect(rec!.note).toBeNull()
    expect(rec!.hunks[0]).toEqual({ oldText: 'old', newText: 'new', afterStart: 0, afterEnd: 3 })
    expect(readFileSync(join(cwd, 'src', 'a.txt'), 'utf8')).toBe('new')
  })

  it('内容无变化不产记录', async () => {
    const cwd = mkWorkspace(true)
    writeFileSync(join(cwd, 'a.txt'), 'same')
    const registry: Registry = new Map()
    await captureToolResult(fakeCtx(), registry, execOf('remote_ssh_write', { path: 'a.txt', content: 'same' }, cwd, 'c2'), okResult)
    expect(recOf(registry, cwd, 'c2')).toBeUndefined()
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('same')
  })

  it('目标不存在 → create 记录并 mkdir -p 写穿新建', async () => {
    const cwd = mkWorkspace(true)
    const registry: Registry = new Map()
    await captureToolResult(fakeCtx(), registry, execOf('remote_ssh_write', { path: 'sub/new.txt', content: 'x' }, cwd, 'c3'), okResult)
    const rec = recOf(registry, cwd, 'c3')
    expect(rec).toBeDefined()
    expect(rec!.create).toBe(true)
    expect(rec!.before).toBeNull()
    expect(rec!.hunks[0].oldText).toBeNull()
    expect(rec!.note).toContain('新建文件')
    expect(readFileSync(join(cwd, 'sub', 'new.txt'), 'utf8')).toBe('x')
  })

  it('非远程工作区（无标记）→ 不进远端分支', async () => {
    const cwd = mkWorkspace(false)
    const registry: Registry = new Map()
    await captureToolResult(fakeCtx(), registry, execOf('remote_ssh_write', { path: 'a.txt', content: 'x' }, cwd, 'c4'), okResult)
    expect(recOf(registry, cwd, 'c4')).toBeUndefined()
    expect(existsSync(join(cwd, 'a.txt'))).toBe(false)
  })

  it('非编辑类工具直接跳过', async () => {
    const cwd = mkWorkspace(true)
    const registry: Registry = new Map()
    await captureToolResult(fakeCtx(), registry, execOf('bash', { command: 'ls' }, cwd, 'c5'), okResult)
    expect(registry.get(cwd)).toBeUndefined()
  })

  it('工具失败（isError）不产记录', async () => {
    const cwd = mkWorkspace(true)
    const registry: Registry = new Map()
    await captureToolResult(fakeCtx(), registry, execOf('remote_ssh_write', { path: 'a.txt', content: 'x' }, cwd, 'c6'), { value: {}, isError: true })
    expect(recOf(registry, cwd, 'c6')).toBeUndefined()
  })

  it('镜像外路径 → 仍记录（note 标不在镜像内），不写穿', async () => {
    const cwd = mkWorkspace(true)
    const registry: Registry = new Map()
    await captureToolResult(fakeCtx(), registry, execOf('remote_ssh_write', { path: '/data/out.txt', content: 'x' }, cwd, 'c7'), okResult)
    const rec = recOf(registry, cwd, 'c7')
    expect(rec).toBeDefined()
    expect(rec!.path).toBe('/data/out.txt')
    expect(rec!.note).toContain('不在工作区镜像内')
    expect(existsSync(join(cwd, 'data'))).toBe(false)
  })

  it('写穿失败 → 记录仍保存，note 附失败原因', async () => {
    const cwd = mkWorkspace(true)
    writeFileSync(join(cwd, 'sub'), 'i am a file') // 父路径是文件 → mkdir/write 必失败
    const registry: Registry = new Map()
    await captureToolResult(fakeCtx(), registry, execOf('remote_ssh_write', { path: 'sub/a.txt', content: 'x' }, cwd, 'c8'), okResult)
    const rec = recOf(registry, cwd, 'c8')
    expect(rec).toBeDefined()
    expect(rec!.note).toContain('写回镜像失败')
  })

  it('缺 callId → 不产记录', async () => {
    const cwd = mkWorkspace(true)
    const registry: Registry = new Map()
    const exec = execOf('remote_ssh_write', { path: 'a.txt', content: 'x' }, cwd)
    await captureToolResult(fakeCtx(), registry, { ...exec, callId: undefined }, okResult)
    expect(recOf(registry, cwd, 'c1')).toBeUndefined()
  })
})

describe('captureToolResult · 本地 write 回归（S4）', () => {
  it('无标记工作区的 write 仍按原语义捕获', async () => {
    const cwd = mkWorkspace(false)
    const registry: Registry = new Map()
    const abs = join(cwd, 'f.txt')
    await captureToolResult(fakeCtx(), registry,
      execOf('write', { file_path: abs, content: 'x' }, cwd),
      { value: { path: abs, before: null, after: 'x' }, isError: false })
    const rec = recOf(registry, cwd, 'c1')
    expect(rec).toBeDefined()
    expect(rec!.toolName).toBe('write')
    expect(rec!.create).toBe(true)
    expect(norm(rec!.path)).toBe(norm(abs))
    expect(rec!.note).toContain('新建文件')
  })

  it('远程工作区里的本地 edit/write 照旧走原分支（toolName=edit）', async () => {
    const cwd = mkWorkspace(true)
    const registry: Registry = new Map()
    const abs = join(cwd, 'a.txt')
    writeFileSync(abs, 'old text')
    await captureToolResult(fakeCtx(), registry,
      execOf('edit', { file_path: abs, old_string: 'old', new_string: 'new' }, cwd, 'e1'),
      { value: { path: abs, before: 'old text', after: 'new text' }, isError: false })
    const rec = recOf(registry, cwd, 'e1')
    expect(rec).toBeDefined()
    expect(rec!.toolName).toBe('edit')
    expect(rec!.hunks[0]).toEqual({ oldText: 'old', newText: 'new', afterStart: 0, afterEnd: 3 })
  })
})
