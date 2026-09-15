/**
 * src/fileVersions.ts 测试：文件磁盘新鲜度观察器（外部改动检测的 host 半）。
 * 用真实临时目录 + 原生 node:fs 伪造 host ctx.fs（resolve/stat），覆盖：
 * 首次观察不报变化、变更后版本变化、目录树索引被失效、缺失/异常单条降级不拖垮整批、
 * 空批/超上限收窄、dispose 清空基准。
 * 作者 ddj 2026-09-15
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_PATHS, createFileVersions } from '../src/fileVersions.js'
import { disposeIndex, hitIndex, listDirCached, putIndex } from '../src/treeIndex.js'

// --region 测试替身

/** 伪造 host ctx：fs 用原生 node fs 实现 resolve/stat（stat 可用次数可控以模拟失败）。 */
function fakeCtx(cwd: string, opts: { failPaths?: Set<string>; statCalls?: string[] } = {}) {
  return {
    get(name: string) {
      if (name === 'sessions') {
        return {
          get: (id: string) => (id === 's1' ? { id: 's1', header: { cwd } } : undefined),
          list: () => [{ id: 's1', header: { cwd } }],
        }
      }
      if (name !== 'fs') return undefined
      return {
        resolve: async (path: string, o?: { cwd?: string }) => {
          if (!o?.cwd) return path
          return path.startsWith('/') || /^[a-z]:/i.test(path) ? path : join(o.cwd, path)
        },
        stat: async (target: string) => {
          opts.statCalls?.push(target)
          if (opts.failPaths?.has(target)) throw new Error('模拟 stat 失败')
          try {
            const { stat } = await import('node:fs/promises')
            const info = await stat(target)
            if (info.isDirectory()) return { version: 'v:' + info.mtimeMs + ':' + info.size, type: 'directory', size: info.size }
            if (info.isFile()) return { version: 'v:' + info.mtimeMs + ':' + info.size, type: 'file', size: info.size }
            return { version: 'v:other', type: 'other' }
          } catch (error) {
            return undefined
          }
        },
      }
    },
  }
}

// --endregion

let dir = ''
let fileA = ''
let fileB = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'edrv-versions-'))
  fileA = join(dir, 'a.ts')
  fileB = join(dir, 'b.ts')
  await writeFile(fileA, 'export const a = 1\n', 'utf8')
  await writeFile(fileB, 'export const b = 1\n', 'utf8')
})

afterAll(async () => {
  disposeIndex(dir)
  await rm(dir, { recursive: true, force: true })
})

describe('fileVersions.versions', () => {
  it('首次观察只记基线（不报变化）；第二次同内容版本不变', async () => {
    const fv = createFileVersions(fakeCtx(dir))
    const first = await fv.versions({ sessionId: 's1', paths: ['a.ts'] })
    expect(first.ok).toBe(true)
    expect(first.items).toHaveLength(1)
    expect(first.items[0].type).toBe('file')
    expect(first.items[0].version).toBeTruthy()
    const second = await fv.versions({ sessionId: 's1', paths: ['a.ts'] })
    expect(second.items[0].version).toBe(first.items[0].version)
    fv.dispose()
  })

  it('文件被改写 → 版本令牌变化（客户端据此判定外部改动）', async () => {
    const fv = createFileVersions(fakeCtx(dir))
    const before = await fv.versions({ sessionId: 's1', paths: ['b.ts'] })
    await writeFile(fileB, 'export const b = 2 // 加长内容使体积变化可见\n', 'utf8')
    const after = await fv.versions({ sessionId: 's1', paths: ['b.ts'] })
    expect(after.items[0].version).not.toBe(before.items[0].version)
    expect(after.items[0].size).toBeGreaterThan(before.items[0].size ?? 0)
    fv.dispose()
  })

  it('检测到变化时失效目录树索引（外部改动不再只靠 TTL）', async () => {
    const ctx = fakeCtx(dir)
    const fv = createFileVersions(ctx)
    // 先播下索引（模拟文件树已列过该目录）
    await listDirCached(ctx, dir, '', false)
    putIndex(ctx, dir, '', [{ name: 'seed.ts', path: 'seed.ts', type: 'file' }])
    expect(hitIndex(dir, '')).not.toBeNull()
    await fv.versions({ sessionId: 's1', paths: ['a.ts'] })
    expect(hitIndex(dir, '')).not.toBeNull() // 首次观察不算变化
    await writeFile(fileA, 'export const a = 2\n', 'utf8')
    await fv.versions({ sessionId: 's1', paths: ['a.ts'] })
    expect(hitIndex(dir, '')).toBeNull() // 变化 → 目录入 stale，索引不再命中
    fv.dispose()
  })

  it('缺失路径返回 type=missing（不报错）；单条异常不影响整批', async () => {
    const missing = join(dir, 'nope.ts')
    const fv = createFileVersions(fakeCtx(dir, { failPaths: new Set([missing]) }))
    const res = await fv.versions({ sessionId: 's1', paths: ['a.ts', 'nope.ts', missing] })
    expect(res.ok).toBe(true)
    expect(res.items).toHaveLength(3)
    expect(res.items[0].type).toBe('file')
    expect(res.items[1].type).toBe('missing')
    expect(res.items[1].version).toBe('')
    expect(res.items[2].type).toBe('missing')
    expect(res.items[2].error).toBeTruthy()
    fv.dispose()
  })

  it('文件被外部删除 → 版本转为 missing（干净缓冲侧据此提示）', async () => {
    const victim = join(dir, 'gone.ts')
    await writeFile(victim, 'x\n', 'utf8')
    const fv = createFileVersions(fakeCtx(dir))
    const before = await fv.versions({ sessionId: 's1', paths: ['gone.ts'] })
    expect(before.items[0].type).toBe('file')
    await rm(victim, { force: true })
    const after = await fv.versions({ sessionId: 's1', paths: ['gone.ts'] })
    expect(after.items[0].type).toBe('missing')
    expect(after.items[0].version).toBe('')
    fv.dispose()
  })

  it('空批/无 fs/超上限：始终 ok 且有界', async () => {
    const fv = createFileVersions(fakeCtx(dir))
    expect((await fv.versions({ sessionId: 's1', paths: [] })).items).toEqual([])
    const many = Array.from({ length: MAX_PATHS + 5 }, (_, i) => 'f' + i + '.ts')
    const res = await fv.versions({ sessionId: 's1', paths: many })
    expect(res.ok).toBe(true)
    expect(res.items).toHaveLength(MAX_PATHS)
    fv.dispose()
    const noFs = createFileVersions({ get: () => undefined })
    expect((await noFs.versions({ sessionId: 's1', paths: ['a.ts'] })).items).toEqual([])
    noFs.dispose()
  })

  it('dispose 后再观察等同首次观察（基准已清空，不产生假变化）', async () => {
    const fv = createFileVersions(fakeCtx(dir))
    await fv.versions({ sessionId: 's1', paths: ['a.ts'] })
    fv.dispose()
    const again = await fv.versions({ sessionId: 's1', paths: ['a.ts'] })
    expect(again.ok).toBe(true)
    expect(again.items[0].version).toBeTruthy()
    fv.dispose()
  })
})
