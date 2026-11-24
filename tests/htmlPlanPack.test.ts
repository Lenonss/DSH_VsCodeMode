/**
 * html-plan 运行时打包测试：<doc-attach> 的附件内联、assets 保留、--check 拦截未内联附件。
 * 直接跑真实脚本（复制运行时 → pack → 清理），确保技能产物可用。
 * @author ddj 2026年11月24号
 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNTIME = resolve(dirname(fileURLToPath(import.meta.url)), '../skills/dsh-vscodemode-html-plan/runtime')
const PLAN = join(RUNTIME, 'plan.mjs')
const tempRoots: string[] = []

/**
 * 建一个临时工作区。
 * @author ddj 2026年11月24号
 * @returns 绝对路径
 */
function workspaceOf(): string {
  const dir = mkdtempSync(join(tmpdir(), 'htmlplan-pack-'))
  tempRoots.push(dir)
  return dir
}

/**
 * 同步跑一条 node 命令。
 * @author ddj 2026年11月24号
 * @param args 参数列表
 * @returns 退出码与输出
 */
function runNode(args: string[]): { status: number; out: string; err: string } {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
  return { status: result.status ?? -1, out: String(result.stdout ?? ''), err: String(result.stderr ?? '') }
}

/**
 * 写一页最小可打包的计划页（含一个附件）。
 * @author ddj 2026年11月24号
 * @param root 临时工作区
 * @param slug 计划目录
 * @param fileRef doc-file 的 src
 */
function writePage(root: string, slug: string, fileRef: string): void {
  const dir = join(root, 'plans', slug)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'note.txt'), 'hello attachment')
  writeFileSync(join(dir, 'plan.html'), [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<meta charset="utf-8">',
    '<title>附件打包测试</title>',
    '<link rel="stylesheet" href="runtime/htmlplan.css">',
    '<script src="runtime/htmlplan.js" defer></script>',
    '<body>',
    '<main>',
    '<doc-plan>',
    '<doc-claim>',
    '<p>页面能显示附件。</p>',
    '<doc-attach label="随附材料" caption="一个文本附件"><doc-file src="' + fileRef + '">说明.txt</doc-file></doc-attach>',
    '</doc-claim>',
    '<doc-claim aux="scope"><p>不改其它。</p></doc-claim>',
    '</doc-plan>',
    '</main>',
    '</body>',
    '</html>',
  ].join('\n'))
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('plan.mjs 附件打包', () => {
  it('把 doc-file 的源文件内联成 data URI，清掉中间文件与附件目录', () => {
    const root = workspaceOf()
    writePage(root, 'attach-probe', 'assets/note.txt')

    const result = runNode([PLAN, 'attach-probe', '--root', root])
    expect(result.status, result.out + result.err).toBe(0)

    const packedPath = join(root, 'plans', 'attach-probe', 'plan.packed.html')
    expect(existsSync(packedPath)).toBe(true)
    const packed = readFileSync(packedPath, 'utf8')
    expect(packed).toContain('data:text/plain;charset=utf-8;base64,')
    expect(packed).toContain('data-mime="text/plain;charset=utf-8"')
    expect(packed).toContain('data-bytes="16"')
    expect(packed).not.toContain('src="assets/note.txt"')
    expect(result.out).toContain('已删除 plans/attach-probe/assets/')

    expect(existsSync(join(root, 'plans', 'attach-probe', 'assets'))).toBe(false)
    expect(existsSync(join(root, 'plans', 'attach-probe', 'plan.html'))).toBe(false)
    expect(existsSync(join(root, 'plans', 'attach-probe', 'runtime'))).toBe(false)

    const check = runNode([PLAN, 'attach-probe', '--root', root, '--check'])
    expect(check.status, check.out + check.err).toBe(0)
  })

  it('--keep-assets 保留附件目录，便于重打包', () => {
    const root = workspaceOf()
    writePage(root, 'keep-probe', 'assets/note.txt')

    const result = runNode([PLAN, 'keep-probe', '--root', root, '--keep-assets'])
    expect(result.status, result.out + result.err).toBe(0)
    expect(existsSync(join(root, 'plans', 'keep-probe', 'assets', 'note.txt'))).toBe(true)
    expect(result.out).toContain('保留 1 个附件')
    expect(existsSync(join(root, 'plans', 'keep-probe', 'plan.packed.html'))).toBe(true)
  })

  it('附件文件缺失时打包失败，不写产物', () => {
    const root = workspaceOf()
    writePage(root, 'missing-probe', 'assets/missing.txt')

    const result = runNode([PLAN, 'missing-probe', '--root', root])
    expect(result.status).not.toBe(0)
    expect(result.out).toContain('not found')
    expect(existsSync(join(root, 'plans', 'missing-probe', 'plan.packed.html'))).toBe(false)
  })

  it('--check 拦下仍引用本地路径的附件', () => {
    const root = workspaceOf()
    const dir = join(root, 'plans', 'bad-probe')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plan.packed.html'),
      '<style data-htmlplan>a{}</style><script data-htmlplan>1</script><doc-file src="assets/a.pdf">a.pdf</doc-file>')

    const check = runNode([PLAN, 'bad-probe', '--root', root, '--check'])
    expect(check.status).not.toBe(0)
    expect(check.err).toContain('没内联的附件')
  })
})
