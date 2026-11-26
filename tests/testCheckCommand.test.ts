/**
 * 测试验收模式：`/test-check` 命令（进入/离开、建单目录、任务投递、失败回滚）。
 * @author ddj 2026年11月25号
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkCommand, checkMessage, type CheckInvocation } from '../src/testCheckCommand.js'
import { testCheckIdOf } from '../src/shared/testCheck.js'

//region 夹具

/** 临时工作区（每个用例一份）。 */
const workspaces: string[] = []

/** 造一个临时工作区。 */
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'edrv-tc-cmd-'))
  workspaces.push(dir)
  return dir
}

/** 最小宿主上下文：只有会话工作区，没有附件服务。 */
function hostCtx(dir: string): unknown {
  return {
    get(name: string) {
      if (name === 'sessions') return undefined
      return undefined
    },
    session: { header: { cwd: dir } },
  }
}

/** 造一次命令调用，并记录 steer 的消息文本。 */
function invocation(dir: string, rawInput: string, extra: Partial<CheckInvocation> = {}): { call: CheckInvocation; steered: string[] } {
  const steered: string[] = []
  const call: CheckInvocation = {
    rawInput,
    agent: {
      session: { header: { cwd: dir } },
      steer: (message: unknown) => { steered.push(String((message as { text?: string }).text ?? message)) },
    },
    ...extra,
  }
  return { call, steered }
}

/** 取出 handler（命令定义是官方 CommandDefinition 形状）。 */
function handlerOf(definition: unknown): (invocation: CheckInvocation) => Promise<{ kind: string; text?: string }> {
  return (definition as { handler: (invocation: CheckInvocation) => Promise<{ kind: string; text?: string }> }).handler
}

afterEach(async () => {
  for (const dir of workspaces.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

//endregion

describe('/test-check 命令', () => {
  it('off 直接返回成功，不投递任何消息', async () => {
    const dir = await workspace()
    const { call, steered } = invocation(dir, 'off')
    const result = await handlerOf(checkCommand({ hostCtx: hostCtx(dir), buildUserMessage: (text) => ({ text }) }))(call)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已关闭')
    expect(steered).toEqual([])
  })

  it('离开模式时带附件直接报错', async () => {
    const dir = await workspace()
    const { call } = invocation(dir, 'off', { attachments: [{ type: 'image' }] })
    const result = await handlerOf(checkCommand({ hostCtx: hostCtx(dir), buildUserMessage: (text) => ({ text }) }))(call)
    expect(result.kind).toBe('error')
    expect(String(result.text)).toContain('不能附带')
  })

  it('进入模式：建单目录与 .gitignore，并把任务与上报约定送进会话', async () => {
    const dir = await workspace()
    const task = 'verify settings toggles'
    const id = testCheckIdOf(task)
    const { call, steered } = invocation(dir, task)
    const result = await handlerOf(checkCommand({ hostCtx: hostCtx(dir), buildUserMessage: (text) => ({ text }) }))(call)

    expect(result.kind).toBe('success')
    expect(result.text).toContain('测试验收模式已开启')
    expect(existsSync(join(dir, '.dsh', 'test-check', id, 'events'))).toBe(true)
    const ignore = await readFile(join(dir, '.dsh', 'test-check', '.gitignore'), 'utf8')
    expect(ignore.trim()).toBe('*')
    const snippets = await readFile(join(dir, '.dsh', 'test-check', id, 'snippets.md'), 'utf8')
    expect(snippets).toContain('验收上报片段')
    expect(steered).toHaveLength(1)
    expect(steered[0]).toContain(task)
    expect(steered[0]).toContain('.dsh/test-check/' + id + '/items.json')
    expect(steered[0]).toContain('test_check_report')
  })

  it('没有任务文本也能进入（用默认单子）', async () => {
    const dir = await workspace()
    const { call, steered } = invocation(dir, '   ')
    const result = await handlerOf(checkCommand({ hostCtx: hostCtx(dir), buildUserMessage: (text) => ({ text }) }))(call)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('check')
    expect(steered[0]).toContain('/test-check off')
  })

  it('没有工作区时明确报错，不建任何目录', async () => {
    const { call } = invocation('/nonexistent-placeholder', '任务')
    call.agent = { steer: () => {} }
    const result = await handlerOf(checkCommand({ hostCtx: { get: () => undefined }, buildUserMessage: (text) => ({ text }) }))(call)
    expect(result.kind).toBe('error')
    expect(String(result.text)).toContain('工作区')
  })

  it('宿主缺消息构造能力时报错（不会静默进入模式）', async () => {
    const dir = await workspace()
    const { call } = invocation(dir, 'verify settings toggles')
    const result = await handlerOf(checkCommand({ hostCtx: hostCtx(dir) }))(call)
    expect(result.kind).toBe('error')
    expect(String(result.text)).toContain('消息构造')
  })

  it('附件准备抛错时降级为说明行，仍能进入模式', async () => {
    const dir = await workspace()
    const { call, steered } = invocation(dir, 'verify settings toggles', { attachments: [{ type: 'file' }] })
    const definition = checkCommand({
      hostCtx: hostCtx(dir),
      buildUserMessage: (text) => ({ text }),
      prepareAttachments: async () => { throw new Error('附件服务不可用') },
    })
    const result = await handlerOf(definition)(call)
    expect(result.kind).toBe('success')
    expect(steered[0]).toContain('附件读取失败')
  })
})

describe('checkMessage', () => {
  it('任务原文在前，路径与上报约定在后，附件说明空时不占行', () => {
    const text = checkMessage('原任务', 'settings-ui', null)
    expect(text.startsWith('原任务')).toBe(true)
    expect(text).toContain('验收单 id：settings-ui')
    expect(text).toContain('test_check_finish')
    expect(text).not.toContain('附件')
  })

  it('没有任务时不留空行开头', () => {
    const text = checkMessage('', 'check', { lines: [], rollback: async () => {} })
    expect(text.startsWith('验收单 id：')).toBe(true)
  })
})
