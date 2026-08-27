/**
 * host paths（PathConst）测试：home 解析、hash、缓存路径构造、sweep 清理逻辑。
 * sweep 用临时 home（参数注入）验证：保当前版本/删旧版本/删超期/删未知残留。
 * 作者 ddj 2026-09-01
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DSH_HOME_ENV,
  TREE_CACHE_SCHEMA,
  TREE_RETENTION_MS,
  dshHome,
  hashOf,
  pluginCacheRoot,
  sweepTreeCache,
  treeCacheFile,
  treeSchemaOf,
  userCacheDir,
  workspaceCacheDir,
} from '../src/paths.js'

const homes: string[] = []
let home = ''

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'edrv-paths-home-'))
  homes.push(home)
})

afterEach(async () => {
  await Promise.all(homes.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })))
})

describe('dshHome', () => {
  it('DSH_HOME 优先（去空白）', () => {
    expect(dshHome({ [DSH_HOME_ENV]: 'D:/Custom' })).toBe('D:/Custom')
    expect(dshHome({ [DSH_HOME_ENV]: '  C:/WS  ' })).toBe('  C:/WS  ')
  })
  it('空/空白视为未设置 → 默认 ~/.dsh', () => {
    const h = dshHome({ [DSH_HOME_ENV]: '' })
    expect(h.endsWith(join('.dsh'))).toBe(true)
    expect(dshHome({ [DSH_HOME_ENV]: '   ' })).toBe(h)
  })
  it('无 env → 默认 ~/.dsh', () => {
    expect(dshHome({}).endsWith(join('.dsh'))).toBe(true)
  })
})

describe('hashOf', () => {
  it('稳定且不同输入不同', () => {
    expect(hashOf('D:/a')).toBe(hashOf('D:/a'))
    expect(hashOf('D:/a')).not.toBe(hashOf('D:/b'))
    expect(hashOf('x')).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('treeCacheFile / 分级目录', () => {
  it('树缓存落在工作区级子目录下，文件名带 schema 版本', () => {
    const f = treeCacheFile('D:/ws', home)
    expect(f).toBe(join(workspaceCacheDir(hashOf('D:/ws'), home), 'tree.v' + TREE_CACHE_SCHEMA + '.json'))
    expect(f.startsWith(pluginCacheRoot(home))).toBe(true)
  })
  it('工作区级与用户级分离', () => {
    expect(workspaceCacheDir('id1', home)).toContain(join('workspace', 'id1'))
    expect(userCacheDir(home)).toBe(join(pluginCacheRoot(home), 'user'))
    expect(workspaceCacheDir('id1', home)).not.toBe(userCacheDir(home))
  })
  it('同一 cwd 稳定、不同 cwd 不同', () => {
    expect(treeCacheFile('D:/ws', home)).toBe(treeCacheFile('D:/ws', home))
    expect(treeCacheFile('D:/ws', home)).not.toBe(treeCacheFile('D:/ws2', home))
  })
})

describe('treeSchemaOf', () => {
  it('解析文件名版本；不匹配 → null', () => {
    expect(treeSchemaOf('tree.v1.abc.json')).toBe(1)
    expect(treeSchemaOf('tree.v2.abc.json')).toBe(2)
    expect(treeSchemaOf('foo.txt')).toBeNull()
    expect(treeSchemaOf('tree.abc.json')).toBeNull()
  })
})

describe('sweepTreeCache', () => {
  async function makeWsFile(wsId: string, name: string, ageMs = 0): Promise<string> {
    const dir = join(pluginCacheRoot(home), 'workspace', wsId)
    await mkdir(dir, { recursive: true })
    const file = join(dir, name)
    await writeFile(file, '{}')
    if (ageMs > 0) {
      const old = new Date(Date.now() - ageMs)
      await utimes(file, old, old)
    }
    return file
  }

  it('工作区级：保当前版本、删旧版本/超期，空目录删除', async () => {
    await makeWsFile('ws-a', 'tree.v' + TREE_CACHE_SCHEMA + '.json', 0) // 当前、新鲜 → 保留
    await makeWsFile('ws-a', 'tree.v0.json', 0) // 旧版本 → 删
    await makeWsFile('ws-b', 'tree.v' + TREE_CACHE_SCHEMA + '.json', TREE_RETENTION_MS + 1000) // 超期 → 删，目录清空

    const removed = await sweepTreeCache(home)
    expect(removed.sort()).toEqual(['tree.v0.json', 'tree.v' + TREE_CACHE_SCHEMA + '.json'])

    // ws-a 保留当前版本；ws-b 空目录被删
    const wsA = await readdir(join(pluginCacheRoot(home), 'workspace', 'ws-a'))
    expect(wsA).toEqual(['tree.v' + TREE_CACHE_SCHEMA + '.json'])
    await expect(readdir(join(pluginCacheRoot(home), 'workspace', 'ws-b'))).rejects.toThrow()
  })

  it('根级残留（迁移前扁平格式/未知文件）删除', async () => {
    const root = pluginCacheRoot(home)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'tree.v' + TREE_CACHE_SCHEMA + '.abc.json'), '{}') // 迁移前扁平格式
    await writeFile(join(root, 'junk.bin'), '{}')

    const removed = await sweepTreeCache(home)
    expect(removed.sort()).toEqual(['junk.bin', 'tree.v' + TREE_CACHE_SCHEMA + '.abc.json'])
    expect(await readdir(root)).toEqual([])
  })

  it('缓存目录不存在 → 静默返回空', async () => {
    expect(await sweepTreeCache(home)).toEqual([])
  })

  it('总预算兜底：超限按最旧先删（不受 TTL/版本限制）', async () => {
    const root = pluginCacheRoot(home)
    const wsA = join(root, 'workspace', 'ws-a')
    const wsB = join(root, 'workspace', 'ws-b')
    await mkdir(wsA, { recursive: true })
    await mkdir(wsB, { recursive: true })
    // 两个 1KB 文件，预算 1KB → 至少删一个（优先旧的）
    await writeFile(join(wsA, 'tree.v' + TREE_CACHE_SCHEMA + '.json'), 'x'.repeat(1024))
    await writeFile(join(wsB, 'tree.v' + TREE_CACHE_SCHEMA + '.json'), 'y'.repeat(1024))

    const removed = await sweepTreeCache(home, 1024)
    expect(removed.length).toBeGreaterThanOrEqual(1)
    const files: string[] = []
    for (const d of ['ws-a', 'ws-b']) {
      files.push(...(await readdir(join(root, 'workspace', d)).catch(() => [])))
    }
    expect(files.length).toBeLessThan(2)
  })
})
