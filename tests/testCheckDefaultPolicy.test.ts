/**
 * 测试验收模式：默认项目测试规范与规则段来源标注。
 *
 * 两条来源必须能分辨：文件来的写路径，默认来的写「面板可改」——
 * 模型据此知道自己看到的是项目要求还是插件兜底。
 * @author ddj 2026年11月26号
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_TEST_POLICY, POLICY_MAX_BYTES } from '../src/shared/testCheckPolicyDefault.js'
import { testCheckPolicyText } from '../src/testCheckGuidance.js'
import { policyPathOf, policyTextOf, resetPolicyCache } from '../src/testCheckPolicy.js'

//region 夹具

/** 临时目录（每个用例一份）。 */
const dirs: string[] = []

/** 造一个临时工作区。 */
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'edrv-tc-compose-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  resetPolicyCache()
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

//endregion

describe('默认规则正文', () => {
  it('8 条通用条款，不带本仓库路径', () => {
    const lines = DEFAULT_TEST_POLICY.split('\n').filter((line) => /^\d+\./.test(line))
    expect(lines).toHaveLength(8)
    expect(DEFAULT_TEST_POLICY).not.toContain('dsh-edit-review')
    expect(DEFAULT_TEST_POLICY).not.toContain('.dsh/test-check')
    expect(DEFAULT_TEST_POLICY).toContain('真机')
  })

  it('上限是 8 KB，与宿主截断口径一致', () => {
    expect(POLICY_MAX_BYTES).toBe(8 * 1024)
  })
})

describe('规则段来源标注', () => {
  it('默认规则说「面板可改」，不说来自文件', () => {
    const text = testCheckPolicyText('1. 跑受影响的用例', false)
    expect(text).toContain('默认规则')
    expect(text).toContain('面板可改')
    expect(text).not.toContain('项目自己的验收规则')
  })

  it('文件规则仍标注 policy.md 来源', () => {
    const text = testCheckPolicyText('1. 跑受影响的用例', true)
    expect(text).toContain('项目自己的验收规则')
    expect(text).toContain('.dsh/test-check/policy.md')
  })

  it('没有项目规则时只有内建规则', () => {
    const text = testCheckPolicyText('', false)
    expect(text).toContain('不许口头通过')
    expect(text).not.toContain('默认规则；左侧')
  })
})

describe('数据链（模式里真正调用的两步）', () => {
  it('文件内容出现在规则段末尾，来源标为 policy.md', async () => {
    const root = await tempRoot()
    await mkdir(join(root, '.dsh', 'test-check'), { recursive: true })
    await writeFile(policyPathOf(root), '必须跑 tests/a.test.ts', 'utf8')

    const policy = policyTextOf(root)
    const text = testCheckPolicyText(policy.text, !policy.isDefault)
    expect(policy.isDefault).toBe(false)
    expect(text).toContain('项目自己的验收规则')
    expect(text.trimEnd().endsWith('必须跑 tests/a.test.ts')).toBe(true)
  })

  it('没有文件时规则段末尾是默认规则，来源标为面板可改', async () => {
    const root = await tempRoot()
    const policy = policyTextOf(root)
    const text = testCheckPolicyText(policy.text, !policy.isDefault)
    const tail = DEFAULT_TEST_POLICY.split('\n').filter(Boolean).pop() ?? ''
    expect(policy.isDefault).toBe(true)
    expect(text).toContain('默认规则')
    expect(text.trimEnd().endsWith(tail)).toBe(true)
  })
})
