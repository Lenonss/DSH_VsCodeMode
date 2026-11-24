/**
 * host /html-plan 命令测试：指令模板、空任务拒绝、官方 /plan 委托与失败降级。
 * @author ddj 2026年11月21号
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HTML_PLAN_COMMAND,
  buildHtmlPlanInstruction,
  htmlPlanCommandDefinition,
  installHtmlPlanCommand,
  parseHtmlPlanInput,
  stagePlanFiles,
} from '../src/htmlPlanCommand.js'

type Handler = (invocation: { agent?: unknown; rawInput?: unknown; signal?: AbortSignal; attachments?: readonly unknown[] }) => Promise<{ kind: string; text?: string }>

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


describe('附件接线', () => {
  /** 造一个图片/文件内容块。 */
  function blockOf(kind: 'image' | 'file', id: string, name: string) {
    return { type: kind, attachment: { attachmentId: id, name, mediaType: kind === 'image' ? 'image/png' : 'application/pdf' } }
  }

  it('定义声明 attachments，composer 才肯把附件送进来', () => {
    const definition = htmlPlanCommandDefinition({}) as { input?: { hint?: string; attachments?: boolean } }
    expect(definition.input?.attachments).toBe(true)
    expect(String(definition.input?.hint ?? '')).toContain('文件')
  })

  it('有附件时用命令固定的 slug，并把附件段写进 /plan 消息', async () => {
    const lines: string[] = []
    const definition = htmlPlanCommandDefinition({
      execute: async (_agent: unknown, line: string) => { lines.push(line); return { result: { kind: 'success', text: 'ok' } } },
    }, {
      prepareAttachments: async () => ({
        slug: 'attach-x',
        count: 1,
        lines: ['附件已保存（页面里必须引用，不要复制到别处）：', '- plans/attach-x/assets/shot.png（图片，1 KB）'],
        rollback: async () => {},
      }),
    })
    const handler = (definition as { handler: Handler }).handler
    const result = await handler({ rawInput: '给编辑器加图片预览', agent: {}, attachments: [blockOf('image', 'i1', 'shot.png')] })
    expect(result.kind).toBe('success')
    expect(String(result.text)).toContain('1 个附件在 plans/attach-x/assets/')
    expect(lines[0]).toContain('plans/attach-x/plan.html')
    expect(lines[0]).toContain('plan.mjs attach-x')
    expect(lines[0]).toContain('plans/attach-x/assets/shot.png')
    expect(lines[0]).not.toContain('plans/<slug>/plan.html')
  })

  it('附件准备抛错时仍进入计划模式，并在指令里说明原因', async () => {
    const lines: string[] = []
    const definition = htmlPlanCommandDefinition({
      execute: async (_agent: unknown, line: string) => { lines.push(line); return { result: { kind: 'success', text: 'ok' } } },
    }, { prepareAttachments: async () => { throw new Error('存储不可用') } })
    const result = await (definition as { handler: Handler }).handler({ rawInput: '加预览', agent: {}, attachments: [blockOf('file', 'f1', 'a.pdf')] })
    expect(result.kind).toBe('success')
    expect(lines[0]).toContain('附件读取失败：存储不可用')
  })

  it('/plan 失败时回滚已落盘的附件', async () => {
    let rolled = 0
    const definition = htmlPlanCommandDefinition({
      execute: async () => ({ result: { kind: 'error', text: 'denied' } }),
    }, {
      prepareAttachments: async () => ({ slug: 'attach-x', count: 1, lines: ['- plans/attach-x/assets/a.png'], rollback: async () => { rolled += 1 } }),
    })
    const result = await (definition as { handler: Handler }).handler({ rawInput: '加预览', agent: {}, attachments: [blockOf('image', 'i1', 'a.png')] })
    expect(result.kind).toBe('error')
    expect(rolled).toBe(1)
  })

  it('只给附件、不写任务时，让 agent 先看附件再确认要规划什么', async () => {
    const lines: string[] = []
    const definition = htmlPlanCommandDefinition({
      execute: async (_agent: unknown, line: string) => { lines.push(line); return { result: { kind: 'success', text: 'ok' } } },
    }, {
      prepareAttachments: async () => ({ slug: 'attach-x', count: 1, lines: ['- plans/attach-x/assets/a.png（图片，1 KB）'], rollback: async () => {} }),
    })
    const result = await (definition as { handler: Handler }).handler({ rawInput: '', agent: {}, attachments: [blockOf('image', 'i1', 'a.png')] })
    expect(result.kind).toBe('success')
    expect(String(result.text)).toContain('请描述')
    expect(lines[0]).toContain('询问')
    expect(lines[0]).toContain('plans/attach-x/assets/a.png')
  })

  it('无附件时保持原行为：slug 留给 agent 自选，指令里没有附件段', () => {
    const text = buildHtmlPlanInstruction('加预览')
    expect(text).toContain('plans/<slug>/plan.html')
    expect(text).not.toContain('附件已保存')
  })
})

describe('stagePlanFiles', () => {
  const workspaces: string[] = []

  /** 建一个临时工作区。 */
  function workspaceOf(): string {
    const dir = mkdtempSync(join(tmpdir(), 'htmlplan-attach-'))
    workspaces.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('把图片与文件写进 plans/<slug>/assets/，并给出指令行', async () => {
    const workspace = workspaceOf()
    const store = {
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]) }),
      readFileStream: () => (async function* () { yield new Uint8Array([4, 5]) })(),
    }
    const ctx = { get: (name: string) => (name === 'attachments' ? store : undefined) }

    const prep = await stagePlanFiles(ctx, {
      agent: { session: { header: { cwd: workspace } } },
      attachments: [
        { type: 'image', attachment: { attachmentId: 'i1', name: 'shot.png', mediaType: 'image/png' } },
        { type: 'file', attachment: { attachmentId: 'f1', name: 'notes.txt' } },
      ],
    }, 'add html preview')

    expect(prep.slug).toBe('html-preview')
    expect(prep.count).toBe(2)
    expect(readFileSync(join(workspace, 'plans', 'html-preview', 'assets', 'shot.png'))).toEqual(Buffer.from([1, 2, 3]))
    expect(readFileSync(join(workspace, 'plans', 'html-preview', 'assets', 'notes.txt'))).toEqual(Buffer.from([4, 5]))
    expect(prep.lines.join('\n')).toContain('plans/html-preview/assets/shot.png')

    await prep.rollback()
    expect(existsSync(join(workspace, 'plans', 'html-preview', 'assets'))).toBe(false)
  })

  it('没有工作区或附件存储时降级说明，不抛错', async () => {
    const prep = await stagePlanFiles({ get: () => undefined }, {
      agent: { session: { header: {} } },
      attachments: [{ type: 'image', attachment: { attachmentId: 'i1' } }],
    }, 'x')
    expect(prep).toMatchObject({ slug: null, count: 0 })
    expect(prep.lines.join('\n')).toContain('附件读取失败')
  })

  it('没有附件时不落盘', async () => {
    const prep = await stagePlanFiles({ get: () => ({}) }, { agent: {} }, 'x')
    expect(prep).toMatchObject({ slug: null, count: 0, lines: [] })
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
