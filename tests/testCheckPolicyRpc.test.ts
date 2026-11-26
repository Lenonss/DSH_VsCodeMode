/**
 * 测试验收模式：项目测试规范 RPC（读/存/重置/技能全文）。
 *
 * 走真实临时工作区与真实读写盘：这几个方法的要点就是「写的是哪个文件」
 * 与「写完同一进程里能不能立刻读到」，桩掉 fs 就失去意义。
 * @author ddj 2026年11月26号
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkHandlers } from '../src/testCheckRpc.js'
import { policyPathOf, resetPolicyCache } from '../src/testCheckPolicy.js'
import { DEFAULT_TEST_POLICY } from '../src/shared/testCheckPolicyDefault.js'
import type { RpcHandlerMap } from '../src/shared/rpc.js'

//region 夹具

/** 临时目录（每个用例一份）。 */
const dirs: string[] = []

/** 造一个临时工作区。 */
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'edrv-tc-policy-rpc-'))
  dirs.push(dir)
  return dir
}

/** 假宿主：只有 sessions，工作区取会话头的 cwd。 */
function fakeCtx(cwd?: string): unknown {
  const session = { id: 's1', header: cwd === undefined ? {} : { cwd } }
  return {
    get(name: string) {
      if (name !== 'sessions') return undefined
      return {
        get: (id: string) => (id === 's1' ? session : undefined),
        list: () => [session],
      }
    },
  }
}

/** 取一个 handler（总表类型是全的，测试按方法取）。 */
function handlerOf(handlers: Partial<RpcHandlerMap>, method: string): (args: unknown) => Promise<Record<string, unknown>> {
  const fn = (handlers as Record<string, unknown>)[method]
  if (typeof fn !== 'function') throw new Error('缺少 handler：' + method)
  return fn as (args: unknown) => Promise<Record<string, unknown>>
}

/** 建一套 handler。 */
function handlersOf(cwd?: string): Record<string, (args: unknown) => Promise<Record<string, unknown>>> {
  const handlers = checkHandlers(fakeCtx(cwd) as never)
  return {
    get: handlerOf(handlers, 'edrv.testCheck.policy.get'),
    save: handlerOf(handlers, 'edrv.testCheck.policy.save'),
    reset: handlerOf(handlers, 'edrv.testCheck.policy.reset'),
    skill: handlerOf(handlers, 'edrv.testCheck.skill'),
  }
}

afterEach(async () => {
  resetPolicyCache()
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

//endregion

describe('读规范', () => {
  it('没有文件时给默认规则，并标明来源', async () => {
    const root = await tempRoot()
    const result = await handlersOf(root).get({ sessionId: 's1' })
    expect(result.ok).toBe(true)
    expect(result.isDefault).toBe(true)
    expect(result.text).toBe(DEFAULT_TEST_POLICY)
    expect(result.path).toBe(policyPathOf(root).replace(/\\/g, '/'))
  })

  it('没有工作区时 ok:false 且原因是可读的', async () => {
    const result = await handlersOf(undefined).get({ sessionId: 's1' })
    expect(result.ok).toBe(false)
    expect(String(result.error ?? '')).not.toBe('')
  })
})

describe('保存与重置', () => {
  it('保存后落盘（LF）、来源变文件，读回内容一致', async () => {
    const root = await tempRoot()
    const api = handlersOf(root)
    const saved = await api.save({ sessionId: 's1', text: '必须跑 tests/a.test.ts\r\n真机要实测' })
    expect(saved.ok).toBe(true)
    expect(saved.isDefault).toBe(false)

    const file = policyPathOf(root)
    expect(existsSync(file)).toBe(true)
    const text = await readFile(file, 'utf8')
    expect(text).toContain('必须跑 tests/a.test.ts')
    expect(text.includes('\r')).toBe(false)
    expect(saved.text).toBe(text)
  })

  it('保存空白＝删文件回默认（不写空文件）', async () => {
    const root = await tempRoot()
    const api = handlersOf(root)
    await api.save({ sessionId: 's1', text: '先写一版' })
    expect(existsSync(policyPathOf(root))).toBe(true)

    const cleared = await api.save({ sessionId: 's1', text: '   \n  ' })
    expect(cleared.ok).toBe(true)
    expect(cleared.isDefault).toBe(true)
    expect(cleared.text).toBe(DEFAULT_TEST_POLICY)
    expect(existsSync(policyPathOf(root))).toBe(false)
  })

  it('重置删文件并回默认', async () => {
    const root = await tempRoot()
    const api = handlersOf(root)
    await api.save({ sessionId: 's1', text: '自定义规则' })

    const reset = await api.reset({ sessionId: 's1' })
    expect(reset.ok).toBe(true)
    expect(reset.isDefault).toBe(true)
    expect(existsSync(policyPathOf(root))).toBe(false)
  })

  it('保存后同一条消息里就能读到新规则（缓存已失效）', async () => {
    const root = await tempRoot()
    const api = handlersOf(root)
    // 先让缓存里装一份旧内容
    await mkdir(join(root, '.dsh', 'test-check'), { recursive: true })
    await writeFile(policyPathOf(root), '旧规则', 'utf8')
    expect((await api.get({ sessionId: 's1' })).text).toBe('旧规则')

    const saved = await api.save({ sessionId: 's1', text: '新规则' })
    expect(saved.text).toBe('新规则')
    expect((await api.get({ sessionId: 's1' })).text).toBe('新规则')
  })

  it('text 不是字符串时拒绝保存', async () => {
    const root = await tempRoot()
    const result = await handlersOf(root).save({ sessionId: 's1', text: 42 })
    expect(result.ok).toBe(false)
    expect(String(result.error ?? '')).toContain('text')
  })
})

describe('技能全文', () => {
  it('读到随包技能全文（含 frontmatter）', async () => {
    const result = await handlersOf(undefined).skill({})
    expect(result.ok).toBe(true)
    expect(result.name).toBe('dsh-vscodemode-test-check')
    const content = String(result.content ?? '')
    expect(content.startsWith('---')).toBe(true)
    expect(content).toContain('name: dsh-vscodemode-test-check')
    expect(content).toContain('## 3. 上报')
    expect(String(result.path ?? '').endsWith('skills/dsh-vscodemode-test-check/SKILL.md')).toBe(true)
  })
})
