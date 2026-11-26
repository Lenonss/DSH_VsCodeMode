/**
 * 测试验收模式：全部验收单列表与移除（真实临时工作区，真实读写盘）。
 *
 * 这两个函数的风险都在「删错东西」与「列表口径和页签不一致」，
 * 所以用例围绕路径边界与计数同源来写。
 * @author ddj 2026年11月26号
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeTestCheck, listSheets, readView, removeSheet, sheetPathsOf } from '../src/testCheckStore.js'

//region 夹具

/** 临时目录（每个用例一份）。 */
const dirs: string[] = []

/** 造一个临时项目根。 */
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'edrv-tc-sheets-'))
  dirs.push(dir)
  return dir
}

/** 造一张验收单：定义 + 一条通过事件；withSnapshot 时同时写快照。 */
async function makeSheet(root: string, id: string, title: string, options: { withSnapshot?: boolean; pass?: number } = {}): Promise<void> {
  const paths = sheetPathsOf(root, id)
  await mkdir(paths.eventsDir, { recursive: true })
  await writeFile(paths.itemsPath, JSON.stringify({
    id,
    title,
    version: 1,
    items: [
      { id: id + '.ui.001', title: '第一条' },
      { id: id + '.ui.002', title: '第二条' },
    ],
  }), 'utf8')
  await writeFile(join(paths.eventsDir, '20261126T010203-aaaa.json'), JSON.stringify({
    item: id + '.ui.001',
    status: 'pass',
    at: '2026-11-26T01:02:03.000Z',
    evidence: { kind: 'test', summary: 'vitest 1/1' },
  }), 'utf8')
  if (options.withSnapshot !== false) {
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'acceptance-' + id + '.html'), '<html></html>', 'utf8')
  }
}

afterEach(async () => {
  disposeTestCheck()
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

//endregion

describe('全部验收单列表', () => {
  it('列出每张单，计数与页签同源', async () => {
    const root = await tempRoot()
    await makeSheet(root, 'settings-ui', '设置页')
    await makeSheet(root, 'svn-box', 'SVN 提交框')

    const listed = await listSheets({ cwd: root })
    expect(listed.root).toBe(root.replace(/\\/g, '/'))
    expect(listed.sheets.map((row) => row.id).sort()).toEqual(['settings-ui', 'svn-box'])

    const row = listed.sheets.find((item) => item.id === 'settings-ui')
    expect(row?.title).toBe('设置页')
    const view = await readView({ cwd: root, id: 'settings-ui' })
    expect(row?.counts).toEqual(view.counts)
    expect(row?.counts.pass).toBe(1)
    expect(row?.counts.total).toBe(2)
    expect(row?.hasSnapshot).toBe(true)
  })

  it('没有快照的单标 hasSnapshot=false', async () => {
    const root = await tempRoot()
    await makeSheet(root, 'no-html', '没导出的单', { withSnapshot: false })

    const listed = await listSheets({ cwd: root })
    expect(listed.sheets).toHaveLength(1)
    expect(listed.sheets[0].hasSnapshot).toBe(false)
    expect(listed.sheets[0].snapshotPath.endsWith('/docs/acceptance-no-html.html')).toBe(true)
  })

  it('目录名不是合法 id 时跳过，空项目返回空列表', async () => {
    const root = await tempRoot()
    await mkdir(join(root, '.dsh', 'test-check', 'Bad_Name'), { recursive: true })
    await mkdir(join(root, '.dsh', 'test-check', 'UPPER'), { recursive: true })
    expect((await listSheets({ cwd: root })).sheets).toHaveLength(0)

    await makeSheet(root, 'ok-sheet', '合法单')
    expect((await listSheets({ cwd: root, force: true })).sheets.map((row) => row.id)).toEqual(['ok-sheet'])
  })

  it('30 秒内复用缓存，force 才重扫', async () => {
    const root = await tempRoot()
    await makeSheet(root, 'first-sheet', '第一张')
    expect((await listSheets({ cwd: root })).sheets).toHaveLength(1)

    // 直接写盘（不经过插件写路径），缓存没被清：不 force 时仍是旧结果
    await makeSheet(root, 'second-sheet', '第二张')
    expect((await listSheets({ cwd: root })).sheets).toHaveLength(1)
    expect((await listSheets({ cwd: root, force: true })).sheets).toHaveLength(2)
  })

  it('items.json 读不出来时仍出一行（计数为空）', async () => {
    const root = await tempRoot()
    const brokenDir = join(root, '.dsh', 'test-check', 'broken-sheet')
    await mkdir(join(brokenDir, 'items.json'), { recursive: true })

    const listed = await listSheets({ cwd: root, force: true })
    const row = listed.sheets.find((item) => item.id === 'broken-sheet')
    expect(row).toBeDefined()
    expect(row?.counts.total).toBe(0)
    expect(row?.hasSnapshot).toBe(false)
  })
})

describe('移除验收单', () => {
  it('删掉单目录与快照，其它单不受影响', async () => {
    const root = await tempRoot()
    await makeSheet(root, 'keep-me', '保留')
    await makeSheet(root, 'drop-me', '删掉')

    const result = await removeSheet({ cwd: root, id: 'drop-me' })
    expect(result.removed).toHaveLength(2)
    expect(existsSync(sheetPathsOf(root, 'drop-me').dir)).toBe(false)
    expect(existsSync(join(root, 'docs', 'acceptance-drop-me.html'))).toBe(false)

    expect(existsSync(sheetPathsOf(root, 'keep-me').dir)).toBe(true)
    expect(existsSync(join(root, 'docs', 'acceptance-keep-me.html'))).toBe(true)
    expect((await listSheets({ cwd: root })).sheets.map((row) => row.id)).toEqual(['keep-me'])
  })

  it('删后同一进程里再读是 missing（缓存已丢弃）', async () => {
    const root = await tempRoot()
    await makeSheet(root, 'drop-me', '删掉')
    expect((await readView({ cwd: root, id: 'drop-me' })).state).toBe('ready')

    await removeSheet({ cwd: root, id: 'drop-me' })
    expect((await readView({ cwd: root, id: 'drop-me' })).state).toBe('missing')
  })

  it('没有快照时只删目录', async () => {
    const root = await tempRoot()
    await makeSheet(root, 'no-html', '没导出的单', { withSnapshot: false })
    const result = await removeSheet({ cwd: root, id: 'no-html' })
    expect(result.removed).toHaveLength(1)
    expect(result.removed[0].endsWith('/.dsh/test-check/no-html')).toBe(true)
  })

  it('不存在的单不算错，返回空清单', async () => {
    const root = await tempRoot()
    const result = await removeSheet({ cwd: root, id: 'ghost' })
    expect(result.removed).toEqual([])
  })

  it('非法 id（路径穿越）被拒绝，且不删任何东西', async () => {
    const root = await tempRoot()
    await makeSheet(root, 'keep-me', '保留')
    await expect(removeSheet({ cwd: root, id: '../keep-me' })).rejects.toThrow()
    expect(existsSync(sheetPathsOf(root, 'keep-me').dir)).toBe(true)
  })
})
