/**
 * host treeRead 快速列取测试：真实临时目录（文件/目录/junction/坏链）判型 + 错误映射。
 * 作者 ddj 2026-08-31
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirListError, listDirCheap } from '../src/treeRead.js'

const dirs: string[] = []

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'edrv-tree-read-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('listDirCheap 判型', () => {
  it('文件/目录/其他正确区分，junction 按目录', async () => {
    const dir = await makeDir()
    const sub = join(dir, 'sub')
    await mkdir(sub)
    await writeFile(join(dir, 'a.txt'), 'hi')
    await symlink(sub, join(dir, 'linkdir'), 'junction')

    const entries = await listDirCheap(dir)
    const byName = new Map(entries.map((e) => [e.name, e.type]))
    expect(byName.get('sub')).toBe('directory')
    expect(byName.get('a.txt')).toBe('file')
    expect(byName.get('linkdir')).toBe('directory')
  })

  it('坏链按 other（stat 失败不抛错）', async () => {
    const dir = await makeDir()
    await symlink(join(dir, 'ghost'), join(dir, 'broken'), 'junction')

    const entries = await listDirCheap(dir)
    const broken = entries.find((e) => e.name === 'broken')
    expect(broken).toBeDefined()
    expect(broken!.type).toBe('other')
  })

  it('空目录返回空数组', async () => {
    const dir = await makeDir()
    expect(await listDirCheap(dir)).toEqual([])
  })
})

describe('listDirCheap 错误映射', () => {
  it('不存在的目录 → not-found', async () => {
    await expect(listDirCheap(join(tmpdir(), 'edrv-no-such-dir-xyz'))).rejects.toMatchObject({ code: 'not-found' })
  })

  it('文件路径 → not-dir', async () => {
    const dir = await makeDir()
    const file = join(dir, 'x.txt')
    await writeFile(file, 'x')
    await expect(listDirCheap(file)).rejects.toMatchObject({ code: 'not-dir' })
  })

  it('错误带用户可读 message', async () => {
    try {
      await listDirCheap(join(tmpdir(), 'edrv-no-such-dir-xyz'))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(DirListError)
      expect(String((error as DirListError).message)).toMatch(/不存在/)
    }
  })
})
