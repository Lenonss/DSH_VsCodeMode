/**
 * host treeIndex 树索引测试：纯函数（相对化/祖先/序列化/裁剪）+ 状态机
 * （命中/失效/force 重列/后台自愈/落盘加载/旧侧车清理）用真实临时目录 + 假 ctx
 * 集成验证；缓存落盘走 DSH_HOME 注入的临时 home（~/.dsh/dsh-vscode-mode/cache）。
 * 作者 ddj 2026-08-31 / 2026-09-01
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ancestorsOf,
  disposeIndex,
  entryOf,
  hitIndex,
  indexParse,
  indexSerialize,
  invalidateIndex,
  listDirCached,
  relOf,
  trimPersist,
} from '../src/treeIndex.js'
import { LEGACY_TREE_SIDECARS, pluginCacheRoot, treeCacheFile } from '../src/paths.js'

const roots: string[] = []
const homes: string[] = []
let root = ''
let home = ''
const prevHome = process.env.DSH_HOME

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'edrv-tree-index-'))
  roots.push(root)
  home = await mkdtemp(join(tmpdir(), 'edrv-tree-home-'))
  homes.push(home)
  process.env.DSH_HOME = home
})

afterEach(async () => {
  vi.useRealTimers()
  disposeIndex(root)
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome
  // dispose 会异步补写缓存：rm 加重试容忍该竞态
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })))
  await Promise.all(homes.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })))
})

/** 最小 ctx：'fs' 指向真实 node fs 的适配层（resolve 直通，不做 realpath）。 */
function makeCtx(workspace: string) {
  const fs = {
    async resolve(p: string, opts?: { cwd?: string }) {
      return { targetKey: resolve(opts?.cwd ?? workspace, p), displayPath: resolve(opts?.cwd ?? workspace, p) }
    },
    processPath(t: { targetKey: string }) {
      return t.targetKey
    },
    async readText(t: { targetKey: string }) {
      return readFile(t.targetKey, 'utf8')
    },
    async writeText(t: { targetKey: string }, content: string) {
      await writeFile(t.targetKey, content, 'utf8')
    },
  }
  return { get: (k: string) => (k === 'fs' ? fs : undefined) }
}

describe('relOf', () => {
  it('相对路径归一化', () => {
    expect(relOf('D:/ws', 'src/client/a.ts')).toBe('src/client/a.ts')
    expect(relOf('D:/ws', './src\\client\\a.ts')).toBe('src/client/a.ts')
    expect(relOf('D:/ws', 'a/../b')).toBeNull()
  })
  it('绝对路径按 cwd 前缀裁剪（大小写不敏感）', () => {
    expect(relOf('D:/Work/ws', 'd:/work/ws/Assets/x.lua')).toBe('Assets/x.lua')
    expect(relOf('D:/ws', 'C:/other/x')).toBeNull()
  })
  it('空/越界/工作区本身 → null', () => {
    expect(relOf('D:/ws', '')).toBeNull()
    expect(relOf('D:/ws', '  ')).toBeNull()
    expect(relOf('D:/ws', 'D:/ws')).toBeNull()
  })
})

describe('ancestorsOf', () => {
  it('深路径 → 父目录+全部祖先+根', () => {
    expect(ancestorsOf('a/b/c')).toEqual(['a/b', 'a', ''])
    expect(ancestorsOf('a')).toEqual([''])
    expect(ancestorsOf('')).toEqual([''])
  })
})

describe('entryOf', () => {
  it('合法/非法条目', () => {
    expect(entryOf({ name: 'x', type: 'directory' })).toEqual({ name: 'x', type: 'directory' })
    expect(entryOf({ name: 'x', type: 'weird' })).toEqual({ name: 'x', type: 'other' })
    expect(entryOf(null)).toBeNull()
    expect(entryOf({ name: '' })).toBeNull()
  })
})

describe('indexSerialize/indexParse', () => {
  it('往返一致（path 由 rel 还原）', () => {
    const data = {
      v: 1 as const,
      root: 'D:/ws',
      dirs: {
        '': { ts: 1000, full: true, entries: [{ name: 'src', path: 'src', type: 'directory' as const }] },
        'src': { ts: 2000, full: true, entries: [{ name: 'a.ts', path: 'src/a.ts', type: 'file' as const }] },
      },
    }
    expect(indexParse(indexSerialize(data))).toEqual(data)
  })
  it('损坏/版本不符 → null', () => {
    expect(indexParse(null)).toBeNull()
    expect(indexParse('not json')).toBeNull()
    expect(indexParse('{"v":9,"dirs":{}}')).toBeNull()
    expect(indexParse('{"v":1}')).toBeNull()
  })
  it('非法条目跳过', () => {
    const text = JSON.stringify({ v: 1, root: null, dirs: { 'a': { ts: 1, full: true, entries: [{ name: 'ok', type: 'file' }, { bad: 1 }, 'x'] } } })
    const data = indexParse(text)
    expect(data!.dirs['a'].entries).toEqual([{ name: 'ok', path: 'a/ok', type: 'file' }])
  })
})

describe('trimPersist', () => {
  it('目录按 ts 裁旧、条目截断标 full=false、root 保留', () => {
    const data = {
      v: 1 as const,
      root: 'D:/ws',
      dirs: {
        'old': { ts: 1, full: true, entries: [{ name: 'x', path: 'old/x', type: 'file' as const }] },
        'new': { ts: 3, full: true, entries: [{ name: 'y', path: 'new/y', type: 'file' as const }] },
        'mid': { ts: 2, full: true, entries: [{ name: 'z', path: 'mid/z', type: 'file' as const }] },
      },
    }
    const trimmed = trimPersist(data, 2, 1)
    expect(Object.keys(trimmed.dirs)).toEqual(['new', 'mid'])
    expect(trimmed.root).toBe('D:/ws')
    const big = trimPersist({ v: 1, root: null, dirs: { 'a': { ts: 1, full: true, entries: [1, 2].map((n) => ({ name: 'f' + n, path: 'a/f' + n, type: 'file' as const })) } } }, 2, 1)
    expect(big.dirs['a'].full).toBe(false)
    expect(big.dirs['a'].entries).toHaveLength(1)
  })
})

describe('状态机（真实临时目录 + 假 ctx + 临时 DSH_HOME）', () => {
  it('命中/失效/force 重列：删除文件后 force 才见新列表', async () => {
    const ctx = makeCtx(root)
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'a.ts'), 'a')
    await writeFile(join(root, 'src', 'b.ts'), 'b')

    const first = await listDirCached(ctx, root, 'src', false)
    expect('entries' in first).toBe(true)
    const names = (first as { entries: { name: string }[] }).entries.map((e) => e.name)
    expect(names).toEqual(['a.ts', 'b.ts'])

    // 索引命中：磁盘删除文件后非 force 仍返回旧列表（索引新鲜）
    await rm(join(root, 'src', 'b.ts'))
    const hit = await listDirCached(ctx, root, 'src', false)
    expect((hit as { entries: { name: string }[] }).entries.map((e) => e.name)).toEqual(['a.ts', 'b.ts'])

    // 失效后：非 force 也走实列（stale 优先于 ts）
    invalidateIndex(ctx, root, 'src/b.ts')
    const stale = await listDirCached(ctx, root, 'src', false)
    expect((stale as { entries: { name: string }[] }).entries.map((e) => e.name)).toEqual(['a.ts'])

    // force 强制实列
    await writeFile(join(root, 'src', 'c.ts'), 'c')
    const forced = await listDirCached(ctx, root, 'src', true)
    expect((forced as { entries: { name: string }[] }).entries.map((e) => e.name)).toEqual(['a.ts', 'c.ts'])
  })

  it('后台自愈：失效 3s 后索引自动更新（删除项剔除、新目录录入）', async () => {
    vi.useFakeTimers()
    const ctx = makeCtx(root)
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'a.ts'), 'a')
    await listDirCached(ctx, root, 'src', false)

    await rm(join(root, 'src', 'a.ts'))
    await mkdir(join(root, 'src', 'newmod'))
    invalidateIndex(ctx, root, 'src/a.ts')

    // 未到 3s：stale 未愈合（命中 null，实列则立即可见——这里直接查 hitIndex 验证 stale 态）
    expect(hitIndex(root, 'src')).toBeNull()
    await vi.advanceTimersByTimeAsync(3000)
    // 自愈在真实 fs IO 上完成：轮询等待（fake 时间推进 + 真实微任务让行）
    let healed: { name: string; path: string; type: string }[] | null = null
    for (let i = 0; i < 200 && healed === null; i++) {
      await vi.advanceTimersByTimeAsync(10)
      healed = hitIndex(root, 'src')
    }
    expect(healed).not.toBeNull()
    const names = healed!.map((e) => e.name)
    expect(names).not.toContain('a.ts')
    expect(names).toContain('newmod')
  })

  it('落盘：缓存写入 ~/.dsh 插件缓存根，重启加载命中', async () => {
    const ctx = makeCtx(root)
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'a.ts'), 'a')
    await listDirCached(ctx, root, 'src', false)
    disposeIndex(root)
    await new Promise((r) => setTimeout(r, 50))

    // 缓存落在 DSH_HOME/dsh-vscode-mode/cache/，工作区无侧车
    const cachePath = treeCacheFile(root)
    expect(cachePath.startsWith(pluginCacheRoot(home))).toBe(true)
    const text = await readFile(cachePath, 'utf8')
    const parsed = indexParse(text)
    expect(parsed).not.toBeNull()
    expect(parsed!.dirs['src'].entries.map((e) => e.name)).toEqual(['a.ts'])

    // 新 ctx 重新加载：listDir 命中落盘快照（磁盘改动被快照掩盖，force 才见真）
    const ctx2 = makeCtx(root)
    await rm(join(root, 'src', 'a.ts'))
    const hit = await listDirCached(ctx2, root, 'src', false)
    expect((hit as { entries: { name: string }[] }).entries.map((e) => e.name)).toEqual(['a.ts'])
    const forced = await listDirCached(ctx2, root, 'src', true)
    expect((forced as { entries: { name: string }[] }).entries).toHaveLength(0)
    disposeIndex(root)
    await new Promise((r) => setTimeout(r, 50))
  })

  it('首次使用清理旧工作区树 sidecar（缓存可重建，删除无损）', async () => {
    const legacy = join(root, LEGACY_TREE_SIDECARS[1])
    await writeFile(legacy, '{}')
    const ctx = makeCtx(root)
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'a.ts'), 'a')
    await listDirCached(ctx, root, 'src', false)
    await new Promise((r) => setTimeout(r, 30))
    await expect(access(legacy)).rejects.toThrow()
  })

  it('错误路径不落索引，返回错误文案', async () => {
    const ctx = makeCtx(root)
    const res = await listDirCached(ctx, root, 'no-such-dir', false)
    expect('error' in res).toBe(true)
    expect((res as { error: string }).error).toMatch(/不存在|失败/)
  })
})
