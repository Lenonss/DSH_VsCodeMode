/**
 * HTML 计划模式 host 装配与行为测试：投影折叠、两条 section、退出工具、命令装配。
 * @author ddj 2026年11月25号
 */
import { describe, expect, it } from 'vitest'
import {
  HTML_PLAN_MODE_INITIAL,
  exitHtmlPlanToolOptions,
  foldHtmlPlanMode,
  htmlPlanProjectionDefinition,
  installHtmlPlanMode,
  setupHtmlPlanMode,
  type HtmlPlanModeState,
} from '../src/htmlPlanMode.js'
import { HTML_PLAN_COMMAND, HTML_PLAN_EXIT_TOOL } from '../src/shared/htmlPlanMode.js'

//region 夹具

/** 造一条会话事件。 */
function event(type: string, data: Record<string, unknown>): { type: string; data: Record<string, unknown> } {
  return { type, data }
}

/** 造一条命令 run + done。 */
function commandPair(name: string, args: string, kind: 'success' | 'error' = 'success'): Array<{ type: string; data: Record<string, unknown> }> {
  return [
    event('command/run', { commandId: name + '-1', name, args }),
    event('command/done', { commandId: name + '-1', kind }),
  ]
}

/** 依次折叠。 */
function foldAll(events: Array<{ type: string; data: Record<string, unknown> }>, initial: HtmlPlanModeState = HTML_PLAN_MODE_INITIAL): HtmlPlanModeState {
  return events.reduce((state, item) => foldHtmlPlanMode(state, item), initial)
}

/** 造一个最小宿主上下文（可注入模块加载与投影状态）。 */
function fakeCtx(overrides: {
  state?: HtmlPlanModeState
  registerThrows?: boolean
  sections?: unknown[]
  tools?: Array<{ definition: unknown; options?: unknown }>
  commands?: Array<{ definition: unknown }>
} = {}) {
  const sections = overrides.sections ?? []
  const tools = overrides.tools ?? []
  const commands = overrides.commands ?? []
  let registered: unknown
  const state = overrides.state ?? HTML_PLAN_MODE_INITIAL
  const ctx = {
    get(name: string) {
      if (name === 'sessionProjections') {
        return {
          register: async (definition: unknown) => {
            if (overrides.registerThrows) throw new Error('boom')
            registered = definition
            return { stateOf: () => state }
          },
        }
      }
      if (name === 'systemPrompt') {
        return {
          section: (spec: unknown) => { sections.push(spec); return () => {} },
          getSectionOrder: () => 500,
        }
      }
      if (name === 'tools') {
        return {
          register: (definition: unknown, options?: unknown) => { tools.push({ definition, options }); return () => {} },
        }
      }
      if (name === 'commands') {
        return {
          register: (definition: unknown) => { commands.push({ definition }); return () => {} },
          execute: async () => ({ result: { kind: 'success' } }),
        }
      }
      if (name === 'userQuestions') return { ask: async () => ({ answers: [] }) }
      return undefined
    },
    effect: (run: () => unknown) => { run(); return () => {} },
    inject: (_services: string[], callback: (sctx: unknown) => void) => {
      callback({
        commands: { register: (definition: unknown) => { commands.push({ definition }); return () => {} }, execute: async () => ({ result: { kind: 'success' } }) },
        effect: (run: () => unknown) => run(),
      })
    },
  }
  const loadModule = async (specifier: string): Promise<unknown> => {
    if (specifier === '@deepseek-ai/dsh-tools') {
      return { defineTool: (options: unknown) => ({ __defineTool: options }) }
    }
    if (specifier === '@deepseek-ai/dsh-llm') {
      return { createUserMessage: (input: unknown) => ({ kind: 'user-message', input }) }
    }
    throw new Error('unexpected module ' + specifier)
  }
  return { ctx, sections, tools, commands, registered: () => registered, loadModule }
}

//endregion

describe('foldHtmlPlanMode', () => {
  it('/html-plan 成功后进入模式，entered 粘性', () => {
    const active = foldAll(commandPair('html-plan', '任务'))
    expect(active).toMatchObject({ active: true, entered: true, running: null })

    const off = foldAll(commandPair('html-plan', 'off'), active)
    expect(off).toMatchObject({ active: false, entered: true, running: null })
  })

  it('官方 /plan 的任何成功命令都关闭本模式（互斥）', () => {
    const active = foldAll(commandPair('html-plan', ''))
    expect(active.active).toBe(true)
    expect(foldAll(commandPair('plan', ''), active).active).toBe(false)
    expect(foldAll(commandPair('plan', 'off'), active).active).toBe(false)
  })

  it('命令失败不提交状态；未配对 done 不影响状态', () => {
    const failed = foldAll(commandPair('html-plan', '', 'error'))
    expect(failed).toMatchObject({ active: false, entered: false, running: null })
    expect(foldHtmlPlanMode(HTML_PLAN_MODE_INITIAL, event('command/done', { commandId: 'x', kind: 'success' }))).toBe(HTML_PLAN_MODE_INITIAL)
  })

  it('无关事件返回同一引用，不产生多余发布', () => {
    const state = foldAll(commandPair('html-plan', ''))
    expect(foldHtmlPlanMode(state, event('tool/call', { callId: 'x' }))).toBe(state)
    expect(foldHtmlPlanMode(state, event('command/run', { commandId: 'o', name: 'other' }))).toBe(state)
  })
})

describe('htmlPlanProjectionDefinition', () => {
  it('key/版本/wire 视图与官方结构一致', () => {
    expect(htmlPlanProjectionDefinition.key).toBe('html-plan')
    expect(htmlPlanProjectionDefinition.stateVersion).toBe(1)
    expect(htmlPlanProjectionDefinition.wire.view({ active: true, entered: true, running: null })).toEqual({ active: true })
    expect(htmlPlanProjectionDefinition.init()).toEqual(HTML_PLAN_MODE_INITIAL)
  })
})

describe('exitHtmlPlanToolOptions', () => {
  /** 取工具的 execute。 */
  function executeOf(deps: Parameters<typeof exitHtmlPlanToolOptions>[0]) {
    return exitHtmlPlanToolOptions(deps).execute as (args: { plan?: unknown }, exec: Record<string, unknown>) => Promise<{ approved: boolean }>
  }

  it('工具名、必需参数与 output 形状', () => {
    const options = exitHtmlPlanToolOptions({ activeOf: () => true, questions: () => undefined, exitMode: async () => ({ ok: true }) })
    expect(options.name).toBe(HTML_PLAN_EXIT_TOOL)
    expect(options.parameters.plan.required).toBe(true)
    expect(options.output.schema.properties.approved.required).toBe(true)
  })

  it('模式不活跃或以非标题开头时拒绝', async () => {
    const inactive = executeOf({ activeOf: () => false, questions: () => undefined, exitMode: async () => ({ ok: true }) })
    await expect(inactive({ plan: '# x' }, { agent: { session: {} } })).rejects.toThrow(/未激活/)
    const noHeading = executeOf({ activeOf: () => true, questions: () => undefined, exitMode: async () => ({ ok: true }) })
    await expect(noHeading({ plan: '不是标题' }, { agent: { session: {} } })).rejects.toThrow(/# 标题/)
  })

  it('批准后执行退出并返回 approved', async () => {
    const exits: Array<{ agent: unknown; signal?: AbortSignal }> = []
    const execute = executeOf({
      activeOf: () => true,
      questions: () => ({ ask: async () => ({ answers: [{ id: 'plan-review', selected: ['Approve'] }] }) }),
      exitMode: async (agent, signal) => { exits.push({ agent, signal }); return { ok: true } },
    })
    const agent = { session: {} }
    await expect(execute({ plan: '# 计划：x' }, { agent })).resolves.toEqual({ approved: true })
    expect(exits).toHaveLength(1)
  })

  it('继续规划把反馈带回；退出失败给出可读错误', async () => {
    const revise = executeOf({
      activeOf: () => true,
      questions: () => ({ ask: async () => ({ answers: [{ id: 'plan-review', selected: ['Keep planning'], custom: '补一节风险' }] }) }),
      exitMode: async () => ({ ok: true }),
    })
    await expect(revise({ plan: '# 计划：x' }, { agent: { session: {} } })).rejects.toThrow(/补一节风险/)

    const failedExit = executeOf({
      activeOf: () => true,
      questions: () => ({ ask: async () => ({ answers: [{ id: 'plan-review', selected: ['Approve'] }] }) }),
      exitMode: async () => ({ ok: false, error: '命令服务不可用' }),
    })
    await expect(failedExit({ plan: '# 计划：x' }, { agent: { session: {} } })).rejects.toThrow(/命令服务不可用/)
  })

  it('用户取消审批时结束本轮，不退出模式', async () => {
    let concluded = 0
    const execute = executeOf({
      activeOf: () => true,
      questions: () => ({ ask: async () => { throw Object.assign(new Error('cancelled'), { code: 'ASK_CANCELLED' }) } }),
      exitMode: async () => ({ ok: true }),
    })
    const result = await execute({ plan: '# 计划：x' }, { agent: { session: {} }, concludeTurn: () => { concluded += 1 } })
    expect(result).toEqual({ approved: false })
    expect(concluded).toBe(1)
  })
})

describe('installHtmlPlanMode / setupHtmlPlanMode', () => {
  it('install 用 ctx.inject 等齐服务后调度装配', () => {
    let called = false
    const ctx = {
      inject: (services: string[], callback: (sctx: unknown) => void) => {
        called = true
        expect(services).toContain('sessionProjections')
        expect(services).toContain('systemPrompt')
        callback({})
      },
      get: () => undefined,
      effect: (run: () => unknown) => { run(); return () => {} },
    }
    expect(installHtmlPlanMode(ctx as never, { loadModule: async () => ({}) })).toBe(true)
    expect(called).toBe(true)
    expect(installHtmlPlanMode({} as never)).toBe(false)
  })

  it('缺 sessionProjections 或注册失败时返回 false', async () => {
    const noProjection = { get: () => undefined, effect: () => () => {}, inject: () => undefined }
    await expect(setupHtmlPlanMode(noProjection as never, { loadModule: async () => ({}) })).resolves.toBe(false)

    const fake = fakeCtx({ registerThrows: true })
    await expect(setupHtmlPlanMode(fake.ctx as never, { loadModule: fake.loadModule })).resolves.toBe(false)
  })

  it('装配投影、两条 section、退出工具与命令', async () => {
    const fake = fakeCtx()
    const ok = await setupHtmlPlanMode(fake.ctx as never, { loadModule: fake.loadModule })
    expect(ok).toBe(true)
    expect(fake.registered()).toMatchObject({ key: 'html-plan' })
    expect(fake.sections).toHaveLength(2)
    expect(fake.tools).toHaveLength(1)
    expect(fake.commands).toHaveLength(1)
    expect((fake.commands[0].definition as { name?: string }).name).toBe(HTML_PLAN_COMMAND)

    const policy = fake.sections[0] as { name: string; order: number; text: (asm: unknown) => string }
    const status = fake.sections[1] as { name: string; order: number; text: (asm: unknown) => string }
    expect(policy.name).toContain('html-plan-policy')
    expect(policy.order).toBe(500.5)
    expect(status.order).toBe(501.5)
    // 未进入过模式：两条都为空。
    expect(policy.text({ agent: { session: {} } })).toBe('')
    expect(status.text({ agent: { session: {} } })).toBe('')

    // 工具准入只看 entered。
    const when = (fake.tools[0].options as { when?: (context: { agent: { session: unknown } }) => boolean }).when
    expect(typeof when).toBe('function')
    expect(when?.({ agent: { session: {} } })).toBe(false)
  })

  it('进入过模式后规则与状态都有输出（粘性 + 活跃切换）', async () => {
    const fake = fakeCtx({ state: { active: true, entered: true, running: null } })
    await setupHtmlPlanMode(fake.ctx as never, { loadModule: fake.loadModule })
    const policy = fake.sections[0] as { text: (asm: unknown) => string }
    const status = fake.sections[1] as { text: (asm: unknown) => string }
    const asm = { agent: { session: {} } }
    expect(policy.text(asm)).toContain('exit_html_plan_mode')
    expect(status.text(asm)).toContain('is active')

    const inactive = fakeCtx({ state: { active: false, entered: true, running: null } })
    await setupHtmlPlanMode(inactive.ctx as never, { loadModule: inactive.loadModule })
    const inactivePolicy = inactive.sections[0] as { text: (asm: unknown) => string }
    const inactiveStatus = inactive.sections[1] as { text: (asm: unknown) => string }
    // 规则段落首次进入后常驻（与官方 plan:policy 一致），状态段落切换为不活跃。
    expect(inactivePolicy.text(asm)).toContain('exit_html_plan_mode')
    expect(inactiveStatus.text(asm)).toContain('is inactive')
  })
})
