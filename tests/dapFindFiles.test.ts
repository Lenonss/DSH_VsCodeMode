/**
 * DAP findFile 定向查找测试（chunkname → rg → 绝对路径）。
 *
 * 回归背景：原先用工作区全量文件索引 + SCAN_CAP 截断反查，22 万文件的 Unity 工程里
 * 前 6000 条按到达序被 GameData/Entitas 等目录占满，Assets/Scripts/Lua/** 一个都不在
 * 索引内，导致断点命中后打不开源文件（「文件加载失败」）。此处改为让 rg 遍历时过滤。
 * 作者 ddj 2026年09月21号
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chunkFilesArgv, findFilesByChunk, normalizeChunk, ripgrepPath } from '../src/search/ripgrep.js'

/**
 * 用真实 rg 支撑的假 subprocess：按 argv/cwd 同步执行并把 stdout 交给 handle.collected。
 * 与 search.test.ts 同口径（那里直接 execFileSync 调 rg），保证测的是真实 rg 行为。
 * @author ddj 2026年09月21号
 * @param holder 收集本次 spawn 的 spec（断言入参用）
 * @returns 符合 SearchSubprocess 契约的对象
 */
function realRgSubprocess(holder: { spec?: Record<string, unknown> }): any {
  return {
    spawn: (spec: any) => {
      holder.spec = spec
      const binary = String(spec.argv[0])
      let text = ''
      let code = 0
      try {
        text = execFileSync(binary, spec.argv.slice(1), { encoding: 'utf8', cwd: spec.cwd })
      } catch (error) {
        const err = error as { status?: number | null; stdout?: string }
        text = String(err?.stdout ?? '')
        code = typeof err?.status === 'number' ? err.status : 2
      }
      return {
        done: Promise.resolve({ exitCode: code }),
        collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }
    },
  }
}

function ctxWith(subprocess: unknown): any {
  return { get: (name: string) => name === 'subprocess' ? subprocess : undefined }
}

describe('DAP chunkname normalize', () => {
  it('剥 chunk 前缀、取 basename、去扩展名', () => {
    expect(normalizeChunk('@Assets/Scripts/Lua/Module/GuideSystem/GuideSystemMgr.lua')).toBe('GuideSystemMgr')
    expect(normalizeChunk('GuideSystemMgr')).toBe('GuideSystemMgr')
    expect(normalizeChunk('a\\b\\Logic.lua')).toBe('Logic')
    expect(normalizeChunk('')).toBe('')
    expect(normalizeChunk(undefined as unknown as string)).toBe('')
  })
})

describe('DAP chunkname argv contract', () => {
  it('沿用大小写字符类 glob，不用会破坏排除项的开关', () => {
    const argv = chunkFilesArgv('rg', 'root', 'GuideSystemMgr')
    expect(argv).not.toBeNull()
    const idx = argv!.indexOf('--glob')
    expect(argv![idx + 1]).toBe('**/*[gG][uU][iI][dD][eE][sS][yY][sS][tT][eE][mM][mM][gG][rR]*')
    expect(argv).not.toContain('--glob-case-insensitive')
    expect(argv).not.toContain('--iglob')
    // 排除项必须保留且为大小写敏感的 --glob（否则 Module/Build 会被误排除）
    const ex = argv!.indexOf('!**/build/**')
    expect(ex).toBeGreaterThan(-1)
    expect(argv![ex - 1]).toBe('--glob')
    // 末位是搜索根
    expect(argv![argv!.length - 1]).toBe('root')
  })

  it('空 chunk 不产出 argv', () => {
    expect(chunkFilesArgv('rg', 'root', '')).toBeNull()
  })
})

describe('DAP findFilesByChunk', () => {
  it('在大量无关文件存在时仍定向命中深层 Lua 源文件（本 bug 正题）', async () => {
    const binary = ripgrepPath()
    if (!binary) return
    const root = mkdtempSync(join(tmpdir(), 'edrv-dapfind-'))
    try {
      // 复刻真实工程形态：大量排序在前的无关文件 + 深层目录里的目标源文件
      mkdirSync(join(root, 'Assets', 'GameData'), { recursive: true })
      for (let i = 0; i < 300; i += 1) {
        writeFileSync(join(root, 'Assets', 'GameData', 'aaa' + String(i).padStart(4, '0') + '.json'), '{}')
      }
      mkdirSync(join(root, 'Assets', 'Scripts', 'Lua', 'Module', 'GuideSystem'), { recursive: true })
      writeFileSync(join(root, 'Assets', 'Scripts', 'Lua', 'Module', 'GuideSystem', 'GuideSystemMgr.lua'), 'return {}')
      // 同名干扰项：必须仍能按路径相关度区分（排序职责在 rankSourceCandidates，这里只验命中集合）
      mkdirSync(join(root, 'Assets', 'Other'), { recursive: true })
      writeFileSync(join(root, 'Assets', 'Other', 'GuideSystemMgr.lua'), 'return {}')

      const holder: { spec?: Record<string, unknown> } = {}
      const sub = realRgSubprocess(holder)
      const files = await findFilesByChunk(ctxWith(sub), root, 'GuideSystemMgr')

      const hit = files.find((f) => f.endsWith('Module/GuideSystem/GuideSystemMgr.lua') || f.endsWith('Module\\GuideSystem\\GuideSystemMgr.lua'))
      expect(hit, '应命中深层目标文件；实际=' + JSON.stringify(files)).toBeTruthy()
      // 无关的 300 个 json 一个都不该进结果
      expect(files.some((f) => f.includes('GameData'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('无命中返回空数组而非抛错', async () => {
    const root = mkdtempSync(join(tmpdir(), 'edrv-dapfind-'))
    try {
      writeFileSync(join(root, 'Only.lua'), 'return {}')
      const files = await findFilesByChunk(ctxWith(realRgSubprocess({})), root, 'NotExistAtAll')
      expect(files).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('subprocess 缺失、rg 不存在、硬失败均降级为空数组（调试链路不抛错）', async () => {
    expect(await findFilesByChunk(ctxWith(undefined), 'root', 'X')).toEqual([])
    const hardFail = { spawn: () => ({ done: Promise.resolve({ exitCode: 3 }), collected: { stdout: { readFrom: () => ({ text: '' }) } } }) }
    expect(await findFilesByChunk(ctxWith(hardFail), 'root', 'X')).toEqual([])
    const spawnThrows = { spawn: () => { throw new Error('缺少 cwd') } }
    expect(await findFilesByChunk(ctxWith(spawnThrows), 'root', 'X')).toEqual([])
    const doneRejects = { spawn: () => ({ done: Promise.reject(new Error('boom')), collected: { stdout: { readFrom: () => ({ text: '' }) } } }) }
    expect(await findFilesByChunk(ctxWith(doneRejects), 'root', 'X')).toEqual([])
  })

  it('把 cwd 传给 subprocess（此前缺失该字段导致扫描恒失败）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'edrv-dapfind-'))
    try {
      writeFileSync(join(root, 'A.lua'), 'return {}')
      const holder: { spec?: Record<string, unknown> } = {}
      await findFilesByChunk(ctxWith(realRgSubprocess(holder)), root, 'A')
      expect(holder.spec?.cwd).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
