/**
 * 测试验收模式：项目级规则文件与规则段拼装。
 * @author ddj 2026年11月25号
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { POLICY_FILE, policyOverlayOf, policyPathOf, resetPolicyCache } from '../src/testCheckPolicy.js'
import { testCheckPolicyText, testCheckRulesText, testCheckStatusText } from '../src/testCheckGuidance.js'

//region 夹具

/** 临时目录（每个用例一份）。 */
const dirs: string[] = []

/** 造一个带 .dsh/test-check 的项目根。 */
async function projectRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'edrv-tc-policy-'))
  dirs.push(dir)
  await mkdir(join(dir, '.dsh', 'test-check'), { recursive: true })
  return dir
}

afterEach(async () => {
  resetPolicyCache()
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

//endregion

describe('项目级规则文件', () => {
  it('没有文件时返回空串（模式按内建规则跑）', async () => {
    const root = await projectRoot()
    expect(policyOverlayOf(root)).toBe('')
    expect(policyPathOf(root)).toBe(join(root, '.dsh', 'test-check', POLICY_FILE))
  })

  it('读到内容原样返回，去 BOM', async () => {
    const root = await projectRoot()
    await writeFile(policyPathOf(root), '\uFEFF必须跑 tests/e2e.test.ts\n', 'utf8')
    expect(policyOverlayOf(root)).toBe('必须跑 tests/e2e.test.ts\n')
  })

  it('改文件后下一次读取就拿到新内容（按 mtime 失效）', async () => {
    const root = await projectRoot()
    await writeFile(policyPathOf(root), '第一版', 'utf8')
    expect(policyOverlayOf(root)).toBe('第一版')
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    await writeFile(policyPathOf(root), '第二版', 'utf8')
    expect(policyOverlayOf(root)).toBe('第二版')
  })

  it('空文件当没有规则；读不到（不是文件）也不抛', async () => {
    const root = await projectRoot()
    await writeFile(policyPathOf(root), '   ', 'utf8')
    expect(policyOverlayOf(root)).toBe('')
    expect(policyOverlayOf('')).toBe('')
    expect(policyOverlayOf(join(root, 'nope'))).toBe('')
  })

  it('超过上限时截断并说明', async () => {
    const root = await projectRoot()
    await writeFile(policyPathOf(root), 'a'.repeat(9 * 1024), 'utf8')
    const text = policyOverlayOf(root)
    expect(text.length).toBeGreaterThan(8 * 1024)
    expect(text).toContain('已截断')
  })
})

describe('规则段拼装', () => {
  it('没有项目规则时只有内建规则', () => {
    const text = testCheckPolicyText('')
    expect(text.startsWith('The following instructions apply only while test-check mode is active.')).toBe(true)
    expect(text).not.toContain('项目自己的验收规则')
  })

  it('有项目规则时拼在后面并标注来源', () => {
    const text = testCheckPolicyText('必须跑 tests/e2e.test.ts，截图放 .dsh/test-check/assets/')
    expect(text).toContain('项目自己的验收规则')
    expect(text).toContain('.dsh/test-check/policy.md')
    expect(text).toContain('必须跑 tests/e2e.test.ts')
    expect(text.indexOf('项目自己的验收规则')).toBeGreaterThan(text.indexOf('test_check_finish'))
  })

  it('内建规则仍然写清「必须带证据」与自动退出', () => {
    const rules = testCheckRulesText()
    expect(rules).toContain('不许口头通过')
    expect(rules).toContain('stay: true')
    expect(testCheckStatusText(true, true)).toContain('active')
  })
})
