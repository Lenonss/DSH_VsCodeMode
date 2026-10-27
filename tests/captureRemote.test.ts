/**
 * host capture.ts 远端写入捕获测试（issue #7）。
 * 覆盖：remote_ssh_write 捕获 + 镜像写穿 / 内容无变化跳过 / 新建 / 非远程不进分支 /
 *       非编辑类工具与失败结果跳过 / 镜像外路径 note / 写穿失败降级 / 本地 write 回归。
 * CI 为 ubuntu：路径断言 path.join 构造 + 反斜杠归一，不写死盘符/分隔符。
 * 作者 ddj 2026-09-23
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureToolResult } from '../src/capture.js'
import { closeArchiveDbs, readActive, readArchives } from '../src/archiveDb.js'
import { archiveCanceled } from '../src/store.js'
import { archiveDbFile } from '../src/paths.js'
import { DatabaseSync } from 'node:sqlite'
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
        stat: async (p: string) => {
          try {
            const info = await stat(p)
            return { type: info.isFile() ? 'file' : 'directory', size: info.size,
              version: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw error
          }
        },
        writeText: async (p: string, text: string) => {
          await mkdir(dirname(p), { recursive: true })
          await writeFile(p, text, 'utf8')
        },
      }
    },
  }
}

let base: string
let previousHome: string | undefined
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
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(base, 'home')
  cwds.length = 0
  clearWsCache()
})

afterEach(() => {
  for (const cwd of cwds) disposeIndex(cwd)
  clearWsCache()
  closeArchiveDbs()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
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

describe('captureToolResult · 过程抵消归档', () => {
  it('本地 edit 新增后移除立即归档，真实修改仍保留待审查', async () => {
    const cwd = mkWorkspace(false)
    const registry: Registry = new Map()
    const ctx = fakeCtx()
    const path = join(cwd, 'a.txt')
    await captureToolResult(ctx, registry,
      execOf('edit', { file_path: path, old_string: 'base', new_string: 'fixed' }, cwd, 'real'),
      { value: { path, before: 'base\n', after: 'fixed\n' } })
    await captureToolResult(ctx, registry,
      execOf('edit', { file_path: path, old_string: '', new_string: 'debug\n' }, cwd, 'add'),
      { value: { path, before: 'fixed\n', after: 'fixed\ndebug\n' } })
    await captureToolResult(ctx, registry,
      execOf('edit', { file_path: path, old_string: 'debug\n', new_string: '' }, cwd, 'remove'),
      { value: { path, before: 'fixed\ndebug\n', after: 'fixed\n' } })
    expect(recOf(registry, cwd, 'real')).toMatchObject({ superseded: false, archived: false })
    expect(recOf(registry, cwd, 'add')).toMatchObject({ superseded: true, archived: true })
    expect(recOf(registry, cwd, 'remove')).toMatchObject({ superseded: true, archived: true })
    expect(readArchives(cwd, path)).toHaveLength(2)
    expect(readActive(cwd).get('remove')).toMatchObject({ archived: true, superseded: true })
  })

  it('归档事务失败回滚全部标志，但新捕获记录仍落盘；维护扫描可重试', async () => {
    const cwd = mkWorkspace(false)
    const registry: Registry = new Map()
    const ctx = fakeCtx()
    const path = join(cwd, 'a.txt')
    await captureToolResult(ctx, registry,
      execOf('write', { file_path: path, content: 'base debug' }, cwd, 'add'),
      { value: { path, before: 'base', after: 'base debug' } })
    const firstAt = recOf(registry, cwd, 'add')!.at
    const db = new DatabaseSync(archiveDbFile(cwd))
    db.exec("CREATE TRIGGER fail_archive BEFORE INSERT ON batches WHEN NEW.batch=2 BEGIN SELECT RAISE(ABORT, 'archive denied'); END")
    try {
      await captureToolResult(ctx, registry,
        execOf('write', { file_path: path, content: 'base' }, cwd, 'remove'),
        { value: { path, before: 'base debug', after: 'base' } })
      expect(recOf(registry, cwd, 'add')).toMatchObject({ archived: false, superseded: false, at: firstAt })
      const removed = recOf(registry, cwd, 'remove')!
      expect(removed).toMatchObject({ archived: false, superseded: false })
      expect(readActive(cwd).get('remove')).toEqual(removed)
      expect(readArchives(cwd, path)).toEqual([])
      const removedAt = removed.at
      // 第二次（维护扫描）也失败，仍须恢复 at/superseded/archived，数据库没有半对归档。
      await expect(archiveCanceled(ctx, {}, cwd, registry.get(cwd)!)).rejects.toThrow('archive denied')
      expect(removed.at).toBe(removedAt)
      expect(removed.archived).toBe(false)
      expect(removed.superseded).toBe(false)
      db.exec('DROP TRIGGER fail_archive')
      expect(await archiveCanceled(ctx, {}, cwd, registry.get(cwd)!)).toBe(2)
      expect(readArchives(cwd, path)).toHaveLength(2)
      expect(await archiveCanceled(ctx, {}, cwd, registry.get(cwd)!)).toBe(0)
    } finally { db.close() }
  })

  it('remote_ssh_write 使用相同抵消机制，镜像写穿仍保持最终内容', async () => {
    const cwd = mkWorkspace(true)
    const path = join(cwd, 'a.txt')
    writeFileSync(path, 'base')
    const registry: Registry = new Map()
    const ctx = fakeCtx()
    await captureToolResult(ctx, registry, execOf('remote_ssh_write', { path: 'a.txt', content: 'base debug' }, cwd, 'add'), okResult)
    await captureToolResult(ctx, registry, execOf('remote_ssh_write', { path: 'a.txt', content: 'base' }, cwd, 'remove'), okResult)
    expect(recOf(registry, cwd, 'add')).toMatchObject({ archived: true, superseded: true })
    expect(recOf(registry, cwd, 'remove')).toMatchObject({ archived: true, superseded: true })
    expect(readFileSync(path, 'utf8')).toBe('base')
  })
})

describe('captureToolResult · 本地 write 回归（S4）', () => {
  it('无标记工作区的 write 仍按原语义捕获', async () => {
    const cwd = mkWorkspace(false)
    const registry: Registry = new Map()
    const abs = join(cwd, 'f.txt')
    await captureToolResult(fakeCtx(), registry,
      execOf('write', { file_path: abs, content: 'x' }, cwd),
      { value: { path: abs, before: null, after: 'x', operation: 'create' }, isError: false })
    const rec = recOf(registry, cwd, 'c1')
    expect(rec).toBeDefined()
    expect(rec!.toolName).toBe('write')
    expect(rec!.create).toBe(true)
    expect(norm(rec!.path)).toBe(norm(abs))
    expect(rec!.note).toContain('新建文件')
  })

  it('before=null 的 update 不得误判新建', async () => {
    const cwd = mkWorkspace(false)
    const registry: Registry = new Map()
    const abs = join(cwd, 'existing.txt')
    await captureToolResult(fakeCtx(), registry,
      execOf('write', { file_path: abs, content: 'x' }, cwd),
      { value: { path: abs, before: null, after: 'x', operation: 'update' }, isError: false })
    expect(recOf(registry, cwd, 'c1')?.create).toBe(false)
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
