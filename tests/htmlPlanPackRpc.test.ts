/**
 * 作者页自动打包测试：真实跑技能 pack.mjs、结果进内存、只读工作区与路径围栏。
 * @author ddj 2026年11月25号
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearPlanPagePackCache, packPlanPage } from '../src/planPagePack.js'

const roots: string[] = []

/** 建一个临时工作区。 */
function workspaceOf(): string {
  const dir = mkdtempSync(join(tmpdir(), 'htmlplan-packrpc-'))
  roots.push(dir)
  return dir
}

/** 写一页最小但可打包的作者页。 */
function writePage(root: string, relative = 'plans/x/plan.html', extra = ''): string {
  const absolute = join(root, relative)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<meta charset="utf-8">',
    '<title>作者页测试</title>',
    '<link rel="stylesheet" href="runtime/htmlplan.css">',
    '<script src="runtime/htmlplan.js" defer></script>',
    '<body>',
    '<header><h1>作者页测试</h1></header>',
    '<main><p>正文。</p></main>',
    extra,
    '</body>',
    '</html>',
  ].join('\n'))
  return absolute
}

afterEach(() => {
  clearPlanPagePackCache()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('packPlanPage', () => {
  it('打包成单文件：内联运行时、不删作者页与 assets', async () => {
    const root = workspaceOf()
    const page = writePage(root)
    mkdirSync(join(root, 'plans', 'x', 'assets'), { recursive: true })
    writeFileSync(join(root, 'plans', 'x', 'assets', 'note.txt'), 'hello')

    const html = await packPlanPage(root, 'plans/x/plan.html')
    expect(html).toContain('data-htmlplan-packed')
    expect(html).toContain('<style data-htmlplan>')
    expect(html).toContain('<script data-htmlplan>')
    expect(html).not.toMatch(/href="[^"]*htmlplan\.css"/)
    expect(html).not.toMatch(/src="[^"]*htmlplan\.js"/)
    // 作者页与附件原样保留（自动打包只写系统临时文件）。
    expect(existsSync(page)).toBe(true)
    expect(readFileSync(join(root, 'plans', 'x', 'assets', 'note.txt'), 'utf8')).toBe('hello')
  })

  it('同一页重复调用命中缓存，结果一致', async () => {
    const root = workspaceOf()
    writePage(root)
    const first = await packPlanPage(root, 'plans/x/plan.html')
    const second = await packPlanPage(root, 'plans/x/plan.html')
    expect(second).toBe(first)
  })

  it('越界路径、非 HTML 与不存在的文件都被拒绝', async () => {
    const root = workspaceOf()
    writePage(root)
    await expect(packPlanPage(root, '../escape.html')).rejects.toThrow(/工作区内/)
    await expect(packPlanPage(root, 'plans/x/plan.txt')).rejects.toThrow(/只打包/)
    await expect(packPlanPage(root, 'plans/x/missing.html')).rejects.toThrow(/不存在/)
  })

  it('打包失败（lint error）时抛出带报告文本的错误', async () => {
    const root = workspaceOf()
    writePage(root, 'plans/x/plan.html', '<doc-unknown>x</doc-unknown>')
    await expect(packPlanPage(root, 'plans/x/plan.html')).rejects.toThrow(/打包计划页失败/)
  })
})
