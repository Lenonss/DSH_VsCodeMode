/**
 * dsh-vscode-mode host — /html-plan 命令：一键进入计划模式，并用 HTML 计划页交付。
 *
 * 机制（不复制官方逻辑）：
 * - 宿主命令声明 input，rawInput 就是用户的「任务」；
 * - 处理器调用官方 /plan 命令并带上本插件的技能指令，官方 plan 处理器会
 *   进入计划模式并用 agent.steer 把这段指令作为用户消息送出；
 * - 因此这里不自行构造 UserMessage、不碰 plan 模式内部状态，官方不可用时直接报错（fail closed）。
 * @author ddj 2026年11月21号
 */
import { log } from './log.js'
import type { Ctx } from './store.js'

/** 命令名（官方语法：小写字母开头，允许数字/_/-）。 */
export const HTML_PLAN_COMMAND = 'html-plan'

/** 命令描述（出现在 / 菜单与命令目录）。 */
export const HTML_PLAN_DESCRIPTION = '用 HTML 计划页进入计划模式：/html-plan <任务>'

/** 计划指令模板版本（改文案时便于测试断言）。 */
export const HTML_PLAN_INSTRUCTION_HEAD = '请使用技能 dsh-vscodemode-html-plan 规划下面的任务，并按 DSH 计划模式提交：'

/** 裸 /html-plan 的指令：先问清任务，再产出 HTML 计划页。 */
export const HTML_PLAN_BARE_INSTRUCTION = '请使用技能 dsh-vscodemode-html-plan 规划接下来的任务：先用一句话询问我要规划什么，再按技能规则产出 HTML 计划页，并在 exit_plan_mode 正文写一行「HTML 计划页：<path>」。'

/** 委派开关：写在任务前，用户显式输入即视为本任务已授权委派。 */
export const HTML_PLAN_DELEGATE_FLAG = '--delegate'

/** 关闭委派：即使达到阈值也不委派。 */
export const HTML_PLAN_NO_DELEGATE_FLAG = '--no-delegate'

/** 委派写页的指令段（用户在 --delegate 下已授权）。 */
export const HTML_PLAN_DELEGATE_INSTRUCTION = '5. 写页方式：本次已获用户授权，写页阶段用一个 subagent_fork 专门写 plans/<slug>/plan.html 并打包。调研与主张树由你定稿后，给子级一份摘要（目标、主张列表、图示要点、决策、页路径与 pack 命令），要求它只写页与 pack，返回 packed 路径、lint 结果与主张/决策计数；父级只验 lint、计数与三处抽查，不读全文。子级失败则自己写。'

/** 明确不委派的指令段（--no-delegate）。 */
export const HTML_PLAN_SINGLE_AGENT_INSTRUCTION = '5. 写页方式：本次不要委派子 agent，由你自己写计划页并打包。'
/** 官方命令运行时最小结构面（宿主服务，鸭子类型）。 */interface CommandsLike {
  register?: (definition: unknown) => unknown
  execute?: (agent: unknown, line: string, attachments: readonly unknown[], signal: AbortSignal) => Promise<{ result?: { kind?: string; text?: string } } | undefined>
}

/** 注入回调上下文最小结构面。 */
interface CommandCtxLike {
  commands?: CommandsLike
  effect?: (run: () => unknown, label?: string) => unknown
}

/** 安装选项（测试可替换指令模板）。 */
export interface HtmlPlanCommandOptions {
  /** 自定义指令模板（入参为任务文本与委派开关）。 */
  instructionOf?: (task: string, delegate?: boolean | null) => string
}

/** 命令输入解析结果。 */
export interface HtmlPlanInput {
  /** true = --delegate，false = --no-delegate，null = 未指定。 */
  delegate: boolean | null
  /** 剥离开关后的任务文本。 */
  task: string
}

/**
 * 解析 /html-plan 的输入：前导 --delegate / --no-delegate 开关（大小写不敏感，最后一个生效），
 * 其余文本作为任务。开关之外的文本原样保留（含内部空格与换行）。
 * @author ddj 2026年11月21号
 * @param rawInput 官方命令的 rawInput
 * @returns 委派开关与任务文本
 */
export function parseHtmlPlanInput(rawInput: unknown): HtmlPlanInput {
  let rest = String(rawInput ?? '').trim()
  let delegate: boolean | null = null
  for (;;) {
    const match = /^(--delegate|--no-delegate)(?=\s|$)\s*/i.exec(rest)
    if (!match) break
    delegate = match[1].toLowerCase() === HTML_PLAN_DELEGATE_FLAG
    rest = rest.slice(match[0].length)
  }
  return { delegate, task: rest.trim() }
}
/**
 * 构造交给 agent 的计划指令：点名技能、产出路径、打包、标记行与审批方式。
 * @author ddj 2026年11月21号
 * @param task 用户任务文本
 * @returns 完整用户消息正文
 */
export function buildHtmlPlanInstruction(task: string, delegate: boolean | null = null): string {
  const objective = String(task ?? '').trim()
  const lines = [    HTML_PLAN_INSTRUCTION_HEAD,
    '1. 先读相关代码与文件，按技能规则写 plans/<slug>/plan.html（slug 用 kebab-case）。',
    '2. 把技能目录的 runtime/（htmlplan.css、htmlplan.js、pack.mjs）复制到 plans/<slug>/runtime/，运行 pack.mjs 生成 plan.packed.html，成功后删除 runtime/ 与未打包的 plan.html。',
    '3. 调用 exit_plan_mode：正文第一行必须是「# 计划：<标题>」，并包含一行「HTML 计划页：plans/<slug>/plan.packed.html」。',
    '4. 计划正文同时给出 3~6 行摘要与待决策清单；不要绕过计划模式直接开工。',
    '',
    '任务：' + objective,
  ]
  if (delegate !== null) lines.splice(5, 0, delegate ? HTML_PLAN_DELEGATE_INSTRUCTION : HTML_PLAN_SINGLE_AGENT_INSTRUCTION)
  return lines.join('\n')
}

/** 取异常的展示文案。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error ?? '未知错误')
}

/**
 * 构造 /html-plan 命令定义（导出便于单测直接调用 handler）。
 * @author ddj 2026年11月21号
 * @param commands 官方命令运行时
 * @param options 安装选项
 * @returns 官方 CommandDefinition 形状对象
 */
export function htmlPlanCommandDefinition(commands: CommandsLike, options: HtmlPlanCommandOptions = {}): unknown {
  const instructionOf = typeof options.instructionOf === 'function' ? options.instructionOf : buildHtmlPlanInstruction
  return {
    name: HTML_PLAN_COMMAND,
    description: HTML_PLAN_DESCRIPTION,
    input: { hint: '<任务描述>' },
    /** @private @author ddj 2026年11月21号 @param invocation 官方命令调用。 @returns 成功/错误结算。 */
    handler: async (invocation: { agent?: unknown; rawInput?: unknown; signal?: AbortSignal }) => {
      const parsed = parseHtmlPlanInput(invocation?.rawInput)
      const task = parsed.task
      if (typeof commands.execute !== 'function') return { kind: 'error', text: '无法进入计划模式：官方 /plan 命令不可用' }
      const signal = invocation?.signal instanceof AbortSignal ? invocation.signal : new AbortController().signal
      try {
        const delegateNote = parsed.delegate === null ? '' : '\n' + (parsed.delegate ? HTML_PLAN_DELEGATE_INSTRUCTION : HTML_PLAN_SINGLE_AGENT_INSTRUCTION)
        const message = task ? instructionOf(task, parsed.delegate) : HTML_PLAN_BARE_INSTRUCTION + delegateNote
        const execution = await commands.execute(invocation?.agent, '/plan ' + message, [], signal)
        if (!execution) return { kind: 'error', text: '无法进入计划模式：官方 /plan 命令不可用' }
        if (execution.result?.kind !== 'success') {
          return { kind: 'error', text: '无法进入计划模式：' + String(execution.result?.text ?? '未知原因') }
        }
        return { kind: 'success', text: task ? 'HTML 计划模式已开启：正在生成 HTML 计划页…' : 'HTML 计划模式已开启：请描述要规划的任务' }
      } catch (error) {
        return { kind: 'error', text: '无法进入计划模式：' + messageOf(error) }
      }
    },
  }
}

/**
 * 装配 /html-plan 宿主命令（commands 服务惰性获取；缺失时降级记日志，不抛错）。
 * @author ddj 2026年11月21号
 * @param ctx DSH host 上下文
 * @param options 安装选项
 * @returns 是否已调度注册（inject 回调异步执行）
 */
export function installHtmlPlanCommand(ctx: Ctx, options: HtmlPlanCommandOptions = {}): boolean {
  const inject = (ctx as { inject?: unknown } | undefined)?.inject
  if (typeof inject !== 'function') {
    log.warn('/html-plan 未注册：DSH 未提供 ctx.inject')
    return false
  }
  try {
    ;(inject as (services: string[], callback: (sctx: unknown) => void) => unknown).call(ctx, ['commands'], (sctx) => {
      const commandCtx = sctx as CommandCtxLike
      const commands = commandCtx?.commands
      if (!commands || typeof commands.register !== 'function') {
        log.warn('/html-plan 未注册：commands 服务不支持 register')
        return
      }
      const mount = (): unknown => commands.register!(htmlPlanCommandDefinition(commands, options))
      try {
        if (typeof commandCtx.effect === 'function') commandCtx.effect(mount, 'vscode-mode: html-plan command')
        else mount()
        log.info('/html-plan 已注册：进入计划模式并用 HTML 计划页交付')
      } catch (error) {
        log.warn('/html-plan 注册失败：' + messageOf(error))
      }
    })
  } catch (error) {
    log.warn('/html-plan 注册调度失败：' + messageOf(error))
    return false
  }
  return true
}
