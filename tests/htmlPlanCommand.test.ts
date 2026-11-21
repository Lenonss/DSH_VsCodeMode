/**
 * host /html-plan 命令测试：指令模板、空任务拒绝、官方 /plan 委托与失败降级。
 * @author ddj 2026年11月21号
 */
import { describe, expect, it } from 'vitest'
import {
  HTML_PLAN_COMMAND,
  buildHtmlPlanInstruction,
  htmlPlanCommandDefinition,
  installHtmlPlanCommand,
  parseHtmlPlanInput,
} from '../src/htmlPlanCommand.js'

type Handler = (invocation: { agent?: unknown; rawInput?: unknown; signal?: AbortSignal }) => Promise<{ kind: string; text?: string }>

/** 取定义里的 handler（仅测试使用）。 */
function handlerOf(commands: unknown): Handler {
  const definition = htmlPlanCommandDefinition(commands as never) as { name: string; handler: Handler }
  expect(definition.name).toBe(HTML_PLAN_COMMAND)
  return definition.handler
}

describe('buildHtmlPlanInstruction', () => {
  it('点名技能、产路径、打包、标记行与任务正文', () => {
    const text = buildHtmlPlanInstruction('  给编辑器加 HTML 预览  ')
    expect(text).toContain('dsh-vscodemode-html-plan')
    expect(text).toContain('plans/<slug>/plan.html')
    expect(text).toContain('plan.packed.html')
    expect(text).toContain('HTML 计划页：plans/<slug>/plan.packed.html')
    expect(text).toContain('exit_plan_mode')
    expect(text.trimEnd().endsWith('任务：给编辑器加 HTML 预览')).toBe(true)
  })
})

describe('htmlPlanCommandDefinition', () => {
  it('裸 /html-plan 也进入计划模式，并让模型先问清任务', async () => {
    const lines: string[] = []
    const handler = handlerOf({ execute: async (_agent: unknown, line: string) => { lines.push(line); return { result: { kind: 'success', text: 'Plan mode on.' } } } })
    const result = await handler({ rawInput: '   ', agent: {} })
    expect(result.kind).toBe('success')
    expect(String(result.text)).toContain('请描述')
    expect(lines[0].startsWith('/plan ')).toBe(true)
    expect(lines[0]).toContain('dsh-vscodemode-html-plan')
    expect(lines[0]).toContain('询问')
  })

  it('有任务时委托官方 /plan，并把 HTML 计划指令作为消息', async () => {
    const lines: string[] = []
    const handler = handlerOf({
      execute: async (_agent: unknown, line: string) => {
        lines.push(line)
        return { result: { kind: 'success', text: 'Plan mode on.' } }
      },
    })
    const result = await handler({ rawInput: '加 HTML 预览', agent: {} })
    expect(result.kind).toBe('success')
    expect(lines[0].startsWith('/plan ')).toBe(true)
    expect(lines[0]).toContain('dsh-vscodemode-html-plan')
    expect(lines[0]).toContain('任务：加 HTML 预览')
  })

  it('--delegate 会剥离开关并把委派要求写进指令', async () => {
    const lines: string[] = []
    const handler = handlerOf({ execute: async (_agent: unknown, line: string) => { lines.push(line); return { result: { kind: 'success', text: 'ok' } } } })
    expect((await handler({ rawInput: '--delegate 加预览', agent: {} })).kind).toBe('success')
    expect(lines[0]).toContain('subagent_fork')
    expect(lines[0]).toContain('任务：加预览')
    expect(lines[0]).not.toContain('--delegate')
  })

  it('--no-delegate 明确要求自己写页', async () => {
    const lines: string[] = []
    const handler = handlerOf({ execute: async (_agent: unknown, line: string) => { lines.push(line); return { result: { kind: 'success', text: 'ok' } } } })
    await handler({ rawInput: '--no-delegate 加预览', agent: {} })
    expect(lines[0]).toContain('不要委派')
  })

  it('官方命令缺失/拒绝/抛错时 fail closed（不偷偷开工）', async () => {
    const missing = await handlerOf({})({ rawInput: 'x' })
    expect(missing.kind).toBe('error')

    const refused = await handlerOf({ execute: async () => ({ result: { kind: 'error', text: 'denied' } }) })({ rawInput: 'x' })
    expect(refused.kind).toBe('error')
    expect(String(refused.text)).toContain('denied')

    const thrown = await handlerOf({ execute: async () => { throw new Error('boom') } })({ rawInput: 'x' })
    expect(thrown.kind).toBe('error')
    expect(String(thrown.text)).toContain('boom')
  })
})


describe('parseHtmlPlanInput', () => {
  it('剥离 --delegate / --no-delegate，大小写不敏感，最后一个生效', () => {
    expect(parseHtmlPlanInput('--delegate 加预览')).toEqual({ delegate: true, task: '加预览' })
    expect(parseHtmlPlanInput('--NO-DELEGATE 加预览')).toEqual({ delegate: false, task: '加预览' })
    expect(parseHtmlPlanInput('--delegate --no-delegate 任务')).toEqual({ delegate: false, task: '任务' })
    expect(parseHtmlPlanInput('--no-delegate --delegate 任务')).toEqual({ delegate: true, task: '任务' })
  })

  it('无开关返回 null；只写开关时任务为空；内部文本原样保留', () => {
    expect(parseHtmlPlanInput('普通任务')).toEqual({ delegate: null, task: '普通任务' })
    expect(parseHtmlPlanInput('--delegate')).toEqual({ delegate: true, task: '' })
    expect(parseHtmlPlanInput('  --delegate   带  空格 的 任务 ')).toEqual({ delegate: true, task: '带  空格 的 任务' })
    expect(parseHtmlPlanInput('任务里提到 --delegate 不算开关')).toEqual({ delegate: null, task: '任务里提到 --delegate 不算开关' })
  })
})

describe('委派指令拼接', () => {
  it('--delegate 指令含 fork 与摘要/验收要求，且不残留开关', () => {
    const text = buildHtmlPlanInstruction('加预览', true)
    expect(text).toContain('subagent_fork')
    expect(text).toContain('摘要')
    expect(text).toContain('三处抽查')
    expect(text).not.toContain('--delegate')
  })

  it('--no-delegate 明确不委派；未指定时不出现委派段', () => {
    const single = buildHtmlPlanInstruction('加预览', false)
    expect(single).toContain('不要委派')
    const plain = buildHtmlPlanInstruction('加预览')
    expect(plain).not.toContain('subagent_fork')
    expect(plain).not.toContain('不要委派')
  })
})

describe('installHtmlPlanCommand', () => {
  it('DSH 无 ctx.inject 时返回 false，不抛错', () => {
    expect(installHtmlPlanCommand({} as never)).toBe(false)
  })

  it('有 ctx.inject 时调度注册（commands 就绪后 register）', () => {
    let registered: unknown
    const registeredNames: unknown[] = []
    const ctx = {
      inject: (services: string[], callback: (sctx: unknown) => void) => {
        expect(services).toEqual(['commands'])
        callback({
          commands: {
            register: (definition: unknown) => { registered = definition; registeredNames.push((definition as { name?: string }).name); return () => {} },
            execute: async () => undefined,
          },
          effect: (run: () => unknown) => run(),
        })
      },
    }
    expect(installHtmlPlanCommand(ctx as never)).toBe(true)
    expect(registered).toBeDefined()
    expect(registeredNames).toEqual([HTML_PLAN_COMMAND])
  })
})
