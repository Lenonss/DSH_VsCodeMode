/**
 * dsh-vscode-mode host — HTML 计划模式（独立模式，结构对齐官方 `@deepseek-ai/dsh-plan-mode`）。
 *
 * 四件套：
 * 1. `sessionProjections` 注册 `html-plan` 投影：折叠 `/html-plan` 命令事件，得到 `{ active, entered }`；
 *    `entered` 粘性，用来让规则段落「首次进入后常驻」（与官方 plan:policy 一致）。
 * 2. 两条系统提示 section：`html-plan:policy`（常驻规则，首句限定只在活跃时适用）与
 *    `html-plan:status`（每个请求按 active 输出一句话）。
 * 3. `/html-plan [off|任务]` 命令：只切换模式并把任务作为普通用户消息送进会话。
 * 4. `exit_html_plan_mode` 工具：从首次进入起常驻准入（对齐官方渐进式披露），执行时再校验活跃；
 *    审批走官方 `userQuestions` 的 `plan-review` intent，批准后执行 `/html-plan off` 收尾。
 *
 * 官方 `plan/mode` 状态、`/plan`、`exit_plan_mode` 一律不碰；本模式与官方计划模式互斥：
 * 任意一次成功的 `/plan` 命令都会把本模式折回 inactive。
 * @author ddj 2026年11月25号
 */
import { z } from 'zod'
import { log } from './log.js'
import { loadHostModule } from './hostImport.js'
import { htmlPlanCommandDefinition, type AttachmentPrep, type HtmlPlanInvocation } from './htmlPlanCommand.js'
import { htmlPlanPolicyText, htmlPlanStatusText } from './htmlPlanGuidance.js'
import { HTML_PLAN_EXIT_TOOL, HTML_PLAN_MODE_KEY, HTML_PLAN_OFF_LINE } from './shared/htmlPlanMode.js'
import type { Ctx } from './store.js'

//region 结构面

/** 投影状态（只描述模式本身；官方计划状态仍由官方 plan 投影负责）。 */
export interface HtmlPlanModeState {
  /** 模式当前是否活跃。 */
  active: boolean
  /** 是否进入过模式（粘性；规则段落据此常驻）。 */
  entered: boolean
  /** 尚未结算的命令事件（run 与 done 配对用）。 */
  running: { commandId: string; off: boolean } | null
}

/** 投影初始状态。 */
export const HTML_PLAN_MODE_INITIAL: HtmlPlanModeState = { active: false, entered: false, running: null }

/** 投影定义里运行时的最小结构面（stateOf 一次折叠到当前游标）。 */
interface ProjectionHandleLike {
  stateOf: (session: unknown) => unknown
}

/** 会话投影服务最小结构面。 */
interface ProjectionsLike {
  register?: (definition: unknown) => Promise<ProjectionHandleLike>
}

/** 系统提示服务最小结构面。 */
interface SystemPromptLike {
  section?: (spec: unknown) => unknown
  getSectionOrder?: (name: string) => number
}

/** 工具服务最小结构面。 */
interface ToolsLike {
  register?: (definition: unknown, options?: { when?: (context: { agent: { session: unknown } }) => boolean }) => unknown
}

/** 命令服务最小结构面。 */
interface CommandsLike {
  register?: (definition: unknown) => unknown
  execute?: (agent: unknown, line: string, attachments: readonly unknown[], signal?: AbortSignal) => Promise<{ result?: { kind?: string; text?: string } } | undefined>
}

/** 用户问答服务最小结构面。 */
interface UserQuestionsLike {
  ask?: (request: unknown) => Promise<{ answers?: Array<{ id?: string; selected?: string[]; custom?: string }> }>
}

/** 退出工具的调用上下文最小结构面。 */
interface ExitToolExec {
  agent?: { session?: unknown } | undefined
  signal?: AbortSignal
  callId?: unknown
  concludeTurn?: () => void
}

/** 安装选项（测试可替换宿主模块加载与消息构造）。 */
export interface HtmlPlanModeOptions {
  /** 把纯文本包成宿主用户消息；缺省从 `@deepseek-ai/dsh-llm` 取 createUserMessage。 */
  buildUserMessage?: (text: string) => unknown
  /** 附件准备（默认落盘到 plans/<slug>/assets/）；测试可替换。 */
  prepareAttachments?: (invocation: HtmlPlanInvocation, task: string) => Promise<AttachmentPrep>
  /** 宿主模块加载（测试可注入假的）。 */
  loadModule?: (specifier: string) => Promise<unknown>
}

//endregion

//region 投影折叠（纯）

/**
 * 折叠一条会话事件到模式状态。
 *
 * 只认两件事：`command/run`（`html-plan` 与官方 `plan`）与配对的 `command/done`。
 * 成功才提交：`off` → inactive；`html-plan` → active 且 entered 置真；官方 `plan` → 关闭本模式（互斥）。
 * @author ddj 2026年11月25号
 * @param state 上一状态
 * @param event 会话事件（只读 type/data）
 * @returns 新状态；不关心的事件返回原引用
 */
export function foldHtmlPlanMode(state: HtmlPlanModeState, event: unknown): HtmlPlanModeState {
  const row = event !== null && typeof event === 'object' ? event as { type?: unknown; data?: unknown } : {}
  const type = typeof row.type === 'string' ? row.type : ''
  const data = row.data !== null && typeof row.data === 'object' ? row.data as Record<string, unknown> : {}

  if (type === 'command/run') {
    const name = typeof data.name === 'string' ? data.name : ''
    if (name !== 'html-plan' && name !== 'plan') return state
    const args = typeof data.args === 'string' ? data.args : ''
    const commandId = typeof data.commandId === 'string' ? data.commandId : ''
    // 官方 /plan 的任意成功动作都关闭本模式；html-plan 只有 off 才关。
    const off = name === 'plan' ? true : args.trim().toLowerCase() === 'off'
    return { ...state, running: { commandId, off } }
  }

  if (type === 'command/done') {
    const running = state.running
    if (!running) return state
    if (String(data.commandId ?? '') !== running.commandId) return state
    if (data.kind !== 'success') return { ...state, running: null }
    const active = !running.off
    return { active, entered: state.entered || active, running: null }
  }

  return state
}

/** 投影定义（key/版本/校验/折叠/wire 视图）。 */
export const htmlPlanProjectionDefinition = {
  key: HTML_PLAN_MODE_KEY,
  stateVersion: 1,
  stateSchema: z.object({
    active: z.boolean(),
    entered: z.boolean(),
    running: z.object({ commandId: z.string(), off: z.boolean() }).strict().nullable(),
  }).strict(),
  init: (): HtmlPlanModeState => HTML_PLAN_MODE_INITIAL,
  apply: (state: HtmlPlanModeState, event: unknown): HtmlPlanModeState => foldHtmlPlanMode(state, event),
  wire: {
    viewSchema: z.object({ active: z.boolean() }).strict(),
    view: (state: HtmlPlanModeState) => ({ active: state.active }),
  },
}

//endregion

//region 退出工具

/** 官方计划审批问题的 id（客户端按它识别 plan-review）。 */
const REVIEW_ID = 'plan-review'

/** 批准标签（与官方 plan-review 一致）。 */
const APPROVE_LABEL = 'Approve'

/** 继续规划标签（与官方 plan-review 一致）。 */
const KEEP_PLANNING_LABEL = 'Keep planning'

/**
 * 取计划正文第一个标题，用作工具卡标题。
 * @author ddj 2026年11月25号
 * @param plan 计划 markdown
 * @returns 标题文本；没有标题时 undefined
 */
function firstHeading(plan: unknown): string | undefined {
  for (const line of String(plan ?? '').split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match) return match[1]
  }
  return undefined
}

/**
 * 取异常的文案。
 * @author ddj 2026年11月25号
 * @param error 捕获值
 * @returns 可读文本
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error ?? '未知错误')
}

/** 退出工具依赖。 */
export interface ExitHtmlPlanToolDeps {
  /** 模式是否活跃。 */
  activeOf: (session: unknown) => boolean
  /** 取出用户问答服务（每次调用时探测）。 */
  questions: () => UserQuestionsLike | undefined
  /** 执行 `/html-plan off` 并返回成败。 */
  exitMode: (agent: unknown, signal?: AbortSignal) => Promise<{ ok: boolean; error?: string }>
}

/**
 * 构造退出工具定义（`defineTool` 的入参）。
 * @author ddj 2026年11月25号
 * @param deps 状态读取、问答通道与退出动作
 * @returns 工具定义参数
 */
export function exitHtmlPlanToolOptions(deps: ExitHtmlPlanToolDeps) {
  /**
   * 提交计划并等待审批；批准则退出模式。
   * @author ddj 2026年11月25号
   * @param args 工具参数
   * @param exec 调用上下文
   * @returns `{ approved }`
   */
  async function execute(args: { plan?: unknown }, exec: ExitToolExec): Promise<{ approved: boolean }> {
    const agent = exec?.agent
    const session = agent?.session
    if (!agent || !session) throw new Error('exit_html_plan_mode 需要调用方 agent')
    if (!deps.activeOf(session)) throw new Error('HTML 计划模式未激活：请先 /html-plan 进入模式')

    const plan = String(args?.plan ?? '').trim()
    if (!/^#\s+\S/.test(plan)) throw new Error('exit_html_plan_mode 需要以 # 标题开头的完整 markdown 计划')

    const questions = deps.questions()
    if (!questions || typeof questions.ask !== 'function') {
      throw new Error('当前宿主没有用户问答通道；请用 /html-plan off 离开模式')
    }

    let answer: { answers?: Array<{ id?: string; selected?: string[]; custom?: string }> }
    try {
      answer = await questions.ask({
        questions: [{
          id: REVIEW_ID,
          header: 'Plan review',
          question: 'Approve this plan and leave HTML plan mode?',
          detail: plan,
          options: [
            { label: APPROVE_LABEL, description: 'Leave HTML plan mode; the plan is carried out from the next step.' },
            { label: KEEP_PLANNING_LABEL, description: 'Stay in HTML plan mode; feedback goes back to the model.' },
          ],
          intent: { kind: 'plan-review', approve: APPROVE_LABEL, callId: exec.callId },
        }],
        agent,
        signal: exec.signal,
      })
    } catch (cause) {
      // 用户关闭审批改为发言：结束本轮，不算失败（与官方一致）。
      if ((cause as { code?: unknown } | null)?.code === 'ASK_CANCELLED') {
        if (typeof exec.concludeTurn === 'function') exec.concludeTurn()
        return { approved: false }
      }
      throw cause
    }

    const items = (answer?.answers ?? []).filter((item) => item?.id === REVIEW_ID)
    const item = items.length === 1 ? items[0] : undefined
    if (!item || item.selected?.length !== 1 || item.selected[0] !== APPROVE_LABEL || item.custom) {
      const feedback = item?.custom ?? ''
      throw new Error(feedback
        ? '用户选择继续规划；反馈：' + feedback
        : '用户选择继续规划；请修订计划后重新提交')
    }

    const exited = await deps.exitMode(agent, exec.signal)
    if (!exited.ok) throw new Error('批准后无法退出 HTML 计划模式：' + String(exited.error ?? '未知原因') + '；请手动执行 /html-plan off')
    return { approved: true }
  }

  return {
    name: HTML_PLAN_EXIT_TOOL,
    description: 'Use only in HTML plan mode. Present the complete plan for the user\'s review and leave the mode on approval.',
    parameters: {
      plan: { type: 'string', required: true, description: 'The complete plan, as markdown, starting with a # heading that names it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { approved: { type: 'boolean', required: true } },
      },
      /** @author ddj 2026年11月25号 @param _args 参数 @param result 执行结果 @returns 模型可见文本 */
      render: (_args: unknown, result: { approved?: boolean }) => [{
        type: 'text',
        text: result?.approved === true
          ? 'Plan approved — HTML plan mode exited; carry out the plan starting with your next step.'
          : 'The user dismissed the plan review to reply in their own words; HTML plan mode remains active.',
      }],
    },
    /** @author ddj 2026年11月25号 @param args 参数 @returns 工具调用卡片 */
    presentCall: (args: { plan?: unknown }) => ({
      card: 'generic',
      title: firstHeading(args?.plan) ?? 'Plan',
      kind: 'other',
      content: [{ type: 'text', text: String(args?.plan ?? '') }],
    }),
    /** @author ddj 2026年11月25号 @param _args 参数 @param result 结果 @returns 结果卡片 */
    presentResult: (_args: unknown, result: { content?: unknown }) => ({
      card: 'generic',
      title: 'Plan review',
      content: result?.content ?? [],
    }),
    isConcurrencySafe: false,
    execute,
  }
}

//endregion

//region 装配

/**
 * 装配 HTML 计划模式：用 `ctx.inject` 等齐四项宿主服务后再注册。
 *
 * 服务齐了才装配（缺任何一项都不做半截模式）；旧宿主没有 `sessionProjections` 时
 * 调用会一直等待、不报错——`/html-plan` 命令自然不可用，普通 `/plan` 不受影响。
 * @author ddj 2026年11月25号
 * @param ctx 宿主上下文
 * @param options 安装选项
 * @returns 是否已调度装配
 */
export function installHtmlPlanMode(ctx: Ctx, options: HtmlPlanModeOptions = {}): boolean {
  if (typeof ctx?.inject !== 'function') {
    log.warn('/html-plan 未装配：DSH 未提供 ctx.inject')
    return false
  }
  try {
    ctx.inject(
      ['sessionProjections', 'systemPrompt', 'tools', 'commands'],
      (sctx: unknown) => {
        void setupHtmlPlanMode(sctx, options).catch((error: unknown) => {
          log.warn('/html-plan 装配失败：' + messageOf(error))
        })
      },
    )
    return true
  } catch (error) {
    log.warn('/html-plan 装配调度失败：' + messageOf(error))
    return false
  }
}

//region 服务读取

/**
 * 从（注入作用域的）宿主上下文取服务：优先 `ctx.get`，退回同名属性。
 * @author ddj 2026年11月25号
 * @param ctx 宿主上下文
 * @param name 服务名
 * @returns 服务实例或 undefined
 */
function serviceOf(ctx: unknown, name: string): unknown {
  const scope = ctx as { get?: (key: string) => unknown } | undefined
  if (scope && typeof scope.get === 'function') {
    try {
      const value = scope.get(name)
      if (value !== undefined) return value
    } catch {
      /* 未注入的服务在旧宿主上可能抛错：退回属性读取 */
    }
  }
  return (ctx as Record<string, unknown> | undefined)?.[name]
}

/**
 * 在宿主生命期里执行一次注册：有 `effect` 就交给它托管卸载，没有就直接跑。
 * @author ddj 2026年11月25号
 * @param ctx 宿主上下文
 * @param run 注册动作
 * @param label 诊断标签
 * @returns 无
 */
function effectOf(ctx: unknown, run: () => unknown, label: string): void {
  const scope = ctx as { effect?: (action: () => unknown, label?: string) => unknown } | undefined
  if (scope && typeof scope.effect === 'function') {
    scope.effect(run, label)
    return
  }
  run()
}

//endregion

/**
 * 真正把投影、两条 section、退出工具与命令挂到宿主上。
 * @author ddj 2026年11月25号
 * @param ctx 已注入服务的宿主上下文
 * @param options 安装选项
 * @returns 是否装配成功
 */
export async function setupHtmlPlanMode(ctx: unknown, options: HtmlPlanModeOptions = {}): Promise<boolean> {
  const loadModule = typeof options.loadModule === 'function' ? options.loadModule : loadHostModule
  const projections = serviceOf(ctx, 'sessionProjections') as ProjectionsLike | undefined
  if (!projections || typeof projections.register !== 'function') {
    log.warn('/html-plan 未装配：宿主没有 sessionProjections 服务（HTML 计划模式不可用）')
    return false
  }

  let handle: ProjectionHandleLike
  try {
    handle = await projections.register(htmlPlanProjectionDefinition as unknown)
  } catch (error) {
    log.warn('/html-plan 未装配：会话投影注册失败：' + messageOf(error))
    return false
  }

  /** @author ddj 2026年11月25号 @param session 会话 @returns 投影状态（异常按未进入处理） */
  function stateOf(session: unknown): HtmlPlanModeState {
    if (!session) return HTML_PLAN_MODE_INITIAL
    try {
      const raw = handle.stateOf(session) as Partial<HtmlPlanModeState> | undefined
      return { active: raw?.active === true, entered: raw?.entered === true, running: raw?.running ?? null }
    } catch {
      return HTML_PLAN_MODE_INITIAL
    }
  }
  /** @author ddj 2026年11月25号 @param session 会话 @returns 是否活跃 */
  function activeOf(session: unknown): boolean {
    return stateOf(session).active === true
  }
  /** @author ddj 2026年11月25号 @param session 会话 @returns 是否进入过模式 */
  function enteredOf(session: unknown): boolean {
    return stateOf(session).entered === true
  }

  // 两条系统提示 section（对齐官方 plan:policy / plan:status）。
  const systemPrompt = serviceOf(ctx, 'systemPrompt') as SystemPromptLike | undefined
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    let baseOrder = 550
    try {
      if (typeof systemPrompt.getSectionOrder === 'function') {
        const order = systemPrompt.getSectionOrder('PLAN_POLICY')
        if (typeof order === 'number' && Number.isFinite(order)) baseOrder = order
      }
    } catch {
      /* 旧宿主没有该常量表：用回退顺序 */
    }
    const policy = {
      name: 'vscode-mode:html-plan-policy',
      retirement: 'HTML plan mode is no longer available. Its instructions no longer apply.',
      order: baseOrder + 0.5,
      /** @author ddj 2026年11月25号 @param asm 装配上下文 @returns 规则文本或空串 */
      text: (asm: { agent?: { session?: unknown } }) => enteredOf(asm?.agent?.session) ? htmlPlanPolicyText() : '',
    }
    const status = {
      name: 'vscode-mode:html-plan-status',
      replacement: '',
      order: baseOrder + 1.5,
      /** @author ddj 2026年11月25号 @param asm 装配上下文 @returns 一行状态或空串 */
      text: (asm: { agent?: { session?: unknown } }) => {
        const session = asm?.agent?.session
        if (!session) return ''
        const state = stateOf(session)
        return htmlPlanStatusText(state.entered, state.active)
      },
    }
    effectOf(ctx, () => systemPrompt.section!(policy), 'vscode-mode: html plan policy section')
    effectOf(ctx, () => systemPrompt.section!(status), 'vscode-mode: html plan status section')
  } else {
    log.warn('/html-plan 规则未注入：宿主没有 systemPrompt.section 服务')
  }

  // 退出工具：从首次进入起常驻准入（对齐官方渐进式披露）。
  try {
    const toolsModule = await loadModule('@deepseek-ai/dsh-tools') as { defineTool?: (options: unknown) => unknown }
    if (typeof toolsModule?.defineTool === 'function') {
      const definition = toolsModule.defineTool(exitHtmlPlanToolOptions({
        activeOf,
        questions: () => serviceOf(ctx, 'userQuestions') as UserQuestionsLike | undefined,
        exitMode: (agent, signal) => runExitLine(ctx, agent, signal),
      }))
      effectOf(ctx, () => {
        const tools = serviceOf(ctx, 'tools') as ToolsLike | undefined
        if (!tools || typeof tools.register !== 'function') {
          log.warn('exit_html_plan_mode 未注册：宿主没有 tools 服务')
          return undefined
        }
        return tools.register(definition, { when: (context) => enteredOf(context?.agent?.session) })
      }, 'vscode-mode: html plan exit tool')
    } else {
      log.warn('exit_html_plan_mode 未注册：无法从宿主加载 defineTool')
    }
  } catch (error) {
    log.warn('exit_html_plan_mode 未注册：' + messageOf(error))
  }

  // 命令：`/html-plan [off|任务]`（commands 已在注入列表里，不会缺席）。
  const llm = await safeLoad(loadModule, '@deepseek-ai/dsh-llm') as { createUserMessage?: (input: unknown) => unknown } | undefined
  const buildUserMessage = typeof options.buildUserMessage === 'function'
    ? options.buildUserMessage
    : (typeof llm?.createUserMessage === 'function'
        ? (text: string) => llm!.createUserMessage!({ content: [{ type: 'text', text }], source: { kind: 'user' } })
        : undefined)

  const commands = serviceOf(ctx, 'commands') as CommandsLike | undefined
  if (!commands || typeof commands.register !== 'function') {
    log.warn('/html-plan 命令未注册：commands 服务不支持 register')
    return false
  }
  try {
    const definition = htmlPlanCommandDefinition(commands, {
      buildUserMessage,
      prepareAttachments: options.prepareAttachments,
      hostCtx: ctx,
    })
    effectOf(ctx, () => commands.register!(definition), 'vscode-mode: html-plan command')
    log.info('/html-plan 已注册：HTML 计划模式（投影 + 规则 + 退出工具）')
  } catch (error) {
    log.warn('/html-plan 注册失败：' + messageOf(error))
    return false
  }
  return true
}

/**
 * 执行 `/html-plan off` 并归一成败（退出工具收尾用）。
 * @author ddj 2026年11月25号
 * @param ctx 宿主上下文
 * @param agent 调用方 agent
 * @param signal 取消信号
 * @returns ok + 失败原因
 */
async function runExitLine(ctx: unknown, agent: unknown, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
  const commands = serviceOf(ctx, 'commands') as CommandsLike | undefined
  if (!commands || typeof commands.execute !== 'function') return { ok: false, error: '命令服务不可用' }
  try {
    const execution = await commands.execute(agent, HTML_PLAN_OFF_LINE, [], signal)
    if (!execution) return { ok: false, error: '命令没有返回结果' }
    const kind = execution.result?.kind
    if (kind === 'success') return { ok: true }
    return { ok: false, error: String(execution.result?.text ?? '未知原因') }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/**
 * 加载可选宿主模块；失败返回 undefined（不阻断装配）。
 * @author ddj 2026年11月25号
 * @param load 加载函数
 * @param specifier 模块名
 * @returns 模块命名空间或 undefined
 */
async function safeLoad(load: (specifier: string) => Promise<unknown>, specifier: string): Promise<unknown> {
  try {
    return await load(specifier)
  } catch (error) {
    log.warn('宿主模块加载失败（' + specifier + '）：' + messageOf(error))
    return undefined
  }
}

//endregion
