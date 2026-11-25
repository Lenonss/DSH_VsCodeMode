/**
 * host /html-plan 命令测试：解析（进入/离开）、任务投递、附件落盘与失败降级。
 * 模式装配（投影/规则/退出工具）见 tests/htmlPlanMode.test.ts。
 * @author ddj 2026年11月25号
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HTML_PLAN_COMMAND,
  htmlPlanCommandDefinition,
  parseHtmlPlanInput,
  stagePlanFiles,
} from '../src/htmlPlanCommand.js'

type Steer = (message: unknown) => unknown
type Handler = (invocation: {
  agent?: { steer?: Steer }
  rawInput?: unknown
  signal?: AbortSignal
  attachments?: readonly unknown[]
}) => Promise<{ kind: string; text?: string }>

/** 取定义里的 handler（仅测试使用）。 */
function handlerOf(definition: unknown): Handler {
  expect((definition as { name?: string }).name).toBe(HTML_PLAN_COMMAND)
  return (definition as { handler: Handler }).handler
}

/** 造一个图片/文件内容块。 */
function blockOf(kind: 'image' | 'file', id: string, name: string) {
  return { type: kind, attachment: { attachmentId: id, name, mediaType: kind === 'image' ? 'image/png' : 'application/pdf' } }
}

/** 记录 steer 调用与命令消息的假 agent。 */
function agentOf(messages: unknown[]): { steer: Steer } {
  return { steer: (message: unknown) => { messages.push(message) } }
}

describe('parseHtmlPlanInput', () => {
  it('off 大小写不敏感，其余文本原样当任务', () => {
    expect(parseHtmlPlanInput('off')).toEqual({ action: 'off', task: '' })
    expect(parseHtmlPlanInput('  OFF  ')).toEqual({ action: 'off', task: '' })
    expect(parseHtmlPlanInput('加个预览')).toEqual({ action: 'enter', task: '加个预览' })
    expect(parseHtmlPlanInput('  第一行\n第二行  ')).toEqual({ action: 'enter', task: '第一行\n第二行' })
    expect(parseHtmlPlanInput(undefined)).toEqual({ action: 'enter', task: '' })
  })

  it('只有独立成词的 off 才是离开；带内容的 off 仍是任务', () => {
    expect(parseHtmlPlanInput('off 加预览')).toEqual({ action: 'enter', task: 'off 加预览' })
    expect(parseHtmlPlanInput('turn off the light')).toEqual({ action: 'enter', task: 'turn off the light' })
  })
})

describe('htmlPlanCommandDefinition', () => {
  it('命令元信息：名字、描述与附件声明', () => {
    const definition = htmlPlanCommandDefinition({}) as { name: string; description: string; input?: { hint?: string; attachments?: boolean } }
    expect(definition.name).toBe(HTML_PLAN_COMMAND)
    expect(definition.description).toContain('HTML 计划模式')
    expect(definition.input?.attachments).toBe(true)
    expect(String(definition.input?.hint ?? '')).toContain('off')
  })

  it('off 只切换模式，不投递消息；带附件时拒绝', async () => {
    const messages: unknown[] = []
    const definition = htmlPlanCommandDefinition({})
    const handler = handlerOf(definition)

    const off = await handler({ rawInput: 'off', agent: agentOf(messages) })
    expect(off.kind).toBe('success')
    expect(String(off.text)).toContain('已关闭')
    expect(messages).toHaveLength(0)

    const rejected = await handler({ rawInput: 'off', agent: agentOf(messages), attachments: [blockOf('image', 'i1', 'a.png')] })
    expect(rejected.kind).toBe('error')
    expect(String(rejected.text)).toContain('不能附带')
  })

  it('带任务时把任务与附件说明一起送进会话，并返回附件数', async () => {
    const messages: unknown[] = []
    const seen: string[] = []
    const definition = htmlPlanCommandDefinition({}, {
      buildUserMessage: (text: string) => { seen.push(text); return { kind: 'user-message', text } },
      prepareAttachments: async () => ({
        slug: 'attach-x',
        count: 1,
        lines: ['附件已保存：', '- plans/attach-x/assets/shot.png（图片，1 KB）'],
        rollback: async () => {},
      }),
    })
    const result = await handlerOf(definition)({ rawInput: '给编辑器加图片预览', agent: agentOf(messages), attachments: [blockOf('image', 'i1', 'shot.png')] })
    expect(result.kind).toBe('success')
    expect(String(result.text)).toContain('1 个附件在 plans/attach-x/assets/')
    expect(messages).toHaveLength(1)
    expect(seen[0]).toContain('给编辑器加图片预览')
    expect(seen[0]).toContain('plans/attach-x/assets/shot.png')
  })

  it('裸进入只开模式，不投递空消息', async () => {
    const messages: unknown[] = []
    const result = await handlerOf(htmlPlanCommandDefinition({}, {
      buildUserMessage: (text: string) => ({ text }),
    }))({ rawInput: '   ', agent: agentOf(messages) })
    expect(result.kind).toBe('success')
    expect(messages).toHaveLength(0)
  })

  it('有任务但宿主不能构造消息或不能 steer 时失败并回滚附件', async () => {
    let rolled = 0
    const prep = {
      slug: 'attach-x',
      count: 1,
      lines: ['- plans/attach-x/assets/a.png'],
      rollback: async () => { rolled += 1 },
    }
    const noBuilder = await handlerOf(htmlPlanCommandDefinition({}, { prepareAttachments: async () => prep }))({
      rawInput: '加预览', agent: agentOf([]), attachments: [blockOf('image', 'i1', 'a.png')],
    })
    expect(noBuilder.kind).toBe('error')
    expect(rolled).toBe(1)

    const noSteer = await handlerOf(htmlPlanCommandDefinition({}, {
      buildUserMessage: (text: string) => ({ text }),
      prepareAttachments: async () => ({ ...prep, rollback: async () => { rolled += 1 } }),
    }))({ rawInput: '加预览', agent: {}, attachments: [blockOf('image', 'i1', 'a.png')] })
    expect(noSteer.kind).toBe('error')
    expect(rolled).toBe(2)
  })

  it('steer 抛错时失败并回滚附件', async () => {
    let rolled = 0
    const result = await handlerOf(htmlPlanCommandDefinition({}, {
      buildUserMessage: (text: string) => ({ text }),
      prepareAttachments: async () => ({ slug: 'attach-x', count: 1, lines: ['- x'], rollback: async () => { rolled += 1 } }),
    }))({ rawInput: '加预览', agent: { steer: () => { throw new Error('session closed') } }, attachments: [blockOf('image', 'i1', 'a.png')] })
    expect(result.kind).toBe('error')
    expect(String(result.text)).toContain('session closed')
    expect(rolled).toBe(1)
  })

  it('附件准备抛错时仍进入模式，并把原因写进任务消息', async () => {
    const seen: string[] = []
    const result = await handlerOf(htmlPlanCommandDefinition({}, {
      buildUserMessage: (text: string) => { seen.push(text); return { text } },
      prepareAttachments: async () => { throw new Error('存储不可用') },
    }))({ rawInput: '加预览', agent: agentOf([]), attachments: [blockOf('file', 'f1', 'a.pdf')] })
    expect(result.kind).toBe('success')
    expect(seen[0]).toContain('附件读取失败：存储不可用')
    expect(seen[0]).toContain('加预览')
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
