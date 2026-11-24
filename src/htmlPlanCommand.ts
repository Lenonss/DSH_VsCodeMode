/**
 * dsh-vscode-mode host — /html-plan 命令：一键进入计划模式，并用 HTML 计划页交付。
 *
 * 机制（不复制官方逻辑）：
 * - 宿主命令声明 input，rawInput 就是用户的「任务」；
 * - 处理器调用官方 /plan 命令并带上本插件的技能指令，官方 plan 处理器会
 *   进入计划模式并用 agent.steer 把这段指令作为用户消息送出；
 * - 因此这里不自行构造 UserMessage、不碰 plan 模式内部状态，官方不可用时直接报错（fail closed）。
 *
 * 附件：命令声明 input.attachments，官方执行器把 composer 的图片/文件入库后再交给本处理器。
 * 处理器把字节复制到 plans/<slug>/assets/（agent 与打包脚本都读得到的工作区内路径），
 * 并把路径写进指令；失败只降级为说明文字，绝不阻断进入计划模式。
 * @author ddj 2026年11月21号
 */
import { mkdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { log } from './log.js'
import { cwdOfSession, type Ctx } from './store.js'
import {
  attachmentLines,
  slugFromTask,
  stageAttachments,
  type AttachmentStage,
} from './htmlPlanAttachments.js'

/** 命令名（官方语法：小写字母开头，允许数字/_/-）。 */
export const HTML_PLAN_COMMAND = 'html-plan'

/** 命令描述（出现在 / 菜单与命令目录）。 */
export const HTML_PLAN_DESCRIPTION = '用 HTML 计划页进入计划模式：/html-plan <任务>（可附图片或文件）'

/** 计划指令模板版本（改文案时便于测试断言）。 */
export const HTML_PLAN_INSTRUCTION_HEAD = '请使用技能 dsh-vscodemode-html-plan 规划下面的任务，并按 DSH 计划模式提交：'

/** 裸 /html-plan 的指令：先问清任务，再产出 HTML 计划页。 */
export const HTML_PLAN_BARE_INSTRUCTION = '请使用技能 dsh-vscodemode-html-plan 规划接下来的任务：先用一句话询问我要规划什么，再按技能规则产出 HTML 计划页，并在 exit_plan_mode 正文写一行「HTML 计划页：<path>」。'

/** 委派开关：写在任务前，用户显式输入即视为本任务已授权委派。 */
export const HTML_PLAN_DELEGATE_FLAG = '--delegate'

/** 关闭委派：即使达到阈值也不委派。 */
export const HTML_PLAN_NO_DELEGATE_FLAG = '--no-delegate'

/** 委派写页的指令段（用户在 --delegate 下已授权）。 */
export const HTML_PLAN_DELEGATE_INSTRUCTION = '写页方式：本次已获用户授权，写页阶段用一个 subagent_fork 专门写 plans/<slug>/plan.html 并打包。调研与主张树由你定稿后，给子级一份摘要（目标、主张列表、图示要点、决策、页路径与 plan.mjs 命令），要求它只写页与打包、返回 packed 路径与 lint 结果；父级只验 lint、计数与三处抽查，不读全文。子级失败则自己写。'

/** 明确不委派的指令段（--no-delegate）。 */
export const HTML_PLAN_SINGLE_AGENT_INSTRUCTION = '写页方式：本次不要委派子 agent，由你自己写计划页并用 plan.mjs 打包。'

/** 官方命令运行时最小结构面（宿主服务，鸭子类型）。 */
interface CommandsLike {
  register?: (definition: unknown) => unknown
  execute?: (agent: unknown, line: string, attachments: readonly unknown[], signal: AbortSignal) => Promise<{ result?: { kind?: string; text?: string } } | undefined>
}

/** 注入回调上下文最小结构面。 */
interface CommandCtxLike {
  commands?: CommandsLike
  effect?: (run: () => unknown, label?: string) => unknown
  get?: (name: string) => unknown
}

/** 官方命令调用（只声明本命令用到的字段）。 */
export interface HtmlPlanInvocation {
  /** 接收命令的 agent。 */
  agent?: unknown
  /** 命令名之后的原始输入。 */
  rawInput?: unknown
  /** 取消信号。 */
  signal?: AbortSignal
  /** 已入库的图片/文件块（未声明 attachments 时为空）。 */
  attachments?: readonly unknown[]
}

/** 附件准备结果（默认实现是落盘；测试可注入假的）。 */
export interface AttachmentPrep {
  /** 固定 slug；没附件时 null（沿用 agent 自选）。 */
  slug: string | null
  /** 落盘成功的附件数量。 */
  count: number
  /** 追加到指令里的附件段。 */
  lines: string[]
  /** /plan 失败时回滚本次写入的附件。 */
  rollback: () => Promise<void>
}

/** 指令模板附加信息（固定 slug 与附件段）。 */
export interface HtmlPlanInstructionExtras {
  /** 固定 slug（有附件时由命令决定）。 */
  slug?: string | null
  /** 附件说明行。 */
  attachmentLines?: readonly string[]
}

/** 附件存储服务最小结构面。 */
interface AttachmentStoreLike {
  readImage?: (ref: unknown, signal?: AbortSignal) => Promise<{ data?: unknown }>
  readFileStream?: (ref: unknown, signal?: AbortSignal) => AsyncIterable<Uint8Array>
}

/** 安装选项（测试可替换指令模板与附件准备）。 */
export interface HtmlPlanCommandOptions {
  /** 自定义指令模板（入参为任务文本、委派开关与附加信息）。 */
  instructionOf?: (task: string, delegate?: boolean | null, extras?: HtmlPlanInstructionExtras) => string
  /** 附件准备（默认落盘到 plans/<slug>/assets/）；测试可替换。 */
  prepareAttachments?: (invocation: HtmlPlanInvocation, task: string) => Promise<AttachmentPrep>
  /** 宿主上下文：取 attachments 服务与会话工作区。 */
  hostCtx?: unknown
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
 * 有附件时用命令固定下来的 slug，并把附件段插在步骤之后。
 * @author ddj 2026年11月21号
 * @param task 用户任务文本
 * @param delegate 委派开关（null = 未指定）
 * @param extras 固定 slug 与附件说明
 * @returns 完整用户消息正文
 */
export function buildHtmlPlanInstruction(
  task: string,
  delegate: boolean | null = null,
  extras: HtmlPlanInstructionExtras = {},
): string {
  const objective = String(task ?? '').trim()
  const slug = typeof extras.slug === 'string' && /^[a-z0-9][a-z0-9-]*$/i.test(extras.slug) ? extras.slug : ''
  const pagePath = slug ? 'plans/' + slug + '/plan.html' : 'plans/<slug>/plan.html'
  const packedPath = slug ? 'plans/' + slug + '/plan.packed.html' : 'plans/<slug>/plan.packed.html'
  const command = slug
    ? 'node <技能目录>/runtime/plan.mjs ' + slug + ' --root <工作区>'
    : 'node <技能目录>/runtime/plan.mjs <slug> --root <工作区>'
  const check = slug ? 'plan.mjs ' + slug + ' --check' : 'plan.mjs <slug> --check'
  const steps = [
    '1. 先读相关代码与文件，按技能规则写 ' + pagePath + (slug ? '（slug 已固定，不要另起目录）。' : '（slug 用 kebab-case）。'),
    '2. 用一条命令打包：' + command + '，它会复制运行时、pack、清理；再跑 ' + check + ' 确认 plan.packed.html 在位。',
    '3. 计划模式允许写 plans/ 下的计划文件：不要因为「在计划模式」跳过写页面，更不要让我退出计划模式来生成。',
    '4. 页面确认生成后，才调用 exit_plan_mode：正文第一行必须是「# 计划：<标题>」，并单独一行「HTML 计划页：' + packedPath + '」；没生成成功就别写这一行，改交 Markdown 计划并说明原因。',
    '5. 计划正文同时给出 3~6 行摘要与待决策清单；不要绕过计划模式直接开工。',
  ]
  const attachment = (extras.attachmentLines ?? []).filter((line) => typeof line === 'string' && line.trim() !== '')
  const extra = delegate === null ? '' : (delegate ? HTML_PLAN_DELEGATE_INSTRUCTION : HTML_PLAN_SINGLE_AGENT_INSTRUCTION)
  const lines = [
    HTML_PLAN_INSTRUCTION_HEAD,
    ...steps,
    ...(attachment.length ? ['', ...attachment] : []),
    ...(extra ? [String(steps.length + 1) + '. ' + extra] : []),
    '',
    '任务：' + objective,
  ]
  return lines.join('\n')
}

/**
 * 取异常的展示文案。
 * @author ddj 2026年11月21号
 * @param error 捕获值
 * @returns 可读文案
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error ?? '未知错误')
}

/**
 * 把流式字节拼成一个 Uint8Array（附件可能是任意长度，不假设单块）。
 * @author ddj 2026年11月24号
 * @param source 按顺序产出的字节块
 * @returns 拼接后的字节
 */
async function readChunks(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let total = 0
  for await (const part of source) {
    parts.push(part)
    total += part.byteLength
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.byteLength
  }
  return merged
}

/**
 * 归一化附件存储返回的字节。
 * @author ddj 2026年11月24号
 * @param value 服务返回值
 * @returns 字节视图
 * @throws 无法识别时抛错（由上层记入 skipped）
 */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new Error('附件存储返回了无法识别的字节')
}

/**
 * 回滚本次写入的附件：逐个删除文件，再尝试移除空目录。
 * @author ddj 2026年11月24号
 * @param workspace 工作区绝对路径
 * @param stage 落盘结果
 * @returns 完成后的 Promise（单步失败只忽略）
 */
async function rollbackStage(workspace: string, stage: AttachmentStage): Promise<void> {
  for (const file of stage.files) {
    try {
      await unlink(join(workspace, file.relativePath))
    } catch {
      /* 文件可能已被删除 */
    }
  }
  try {
    await rmdir(join(workspace, stage.dir))
  } catch {
    /* 目录非空或已不存在 */
  }
}

/**
 * 默认附件准备：把 composer 的图片/文件复制到 plans/<slug>/assets/。
 *
 * 任何失败（服务缺失、读字节失败、写盘失败）都降级成说明行，不阻断进入计划模式；
 * 只有 /plan 调用失败时才会回滚本次写入。
 * @author ddj 2026年11月24号
 * @param hostCtx 宿主上下文
 * @param invocation 官方命令调用
 * @param task 任务文本（派生 slug）
 * @returns 附件准备结果
 */
export async function stagePlanFiles(
  hostCtx: unknown,
  invocation: HtmlPlanInvocation,
  task: string,
): Promise<AttachmentPrep> {
  const empty: AttachmentPrep = { slug: null, count: 0, lines: [], rollback: async () => {} }
  const blocks = Array.isArray(invocation?.attachments) ? invocation.attachments.filter(Boolean) : []
  if (!blocks.length) return empty

  const ctx = hostCtx as { get?: (name: string) => unknown } | undefined
  const session = (invocation?.agent as { session?: unknown } | undefined)?.session
  const workspace = typeof ctx?.get === 'function' ? cwdOfSession(ctx, session) : null
  const store = typeof ctx?.get === 'function' ? ctx.get('attachments') as AttachmentStoreLike | undefined : undefined
  const readImage = store?.readImage
  const readFileStream = store?.readFileStream
  if (!workspace || typeof readImage !== 'function' || typeof readFileStream !== 'function') {
    return {
      slug: null,
      count: 0,
      lines: ['附件读取失败：当前会话没有可用工作区或附件存储；本次按无附件规划。'],
      rollback: async () => {},
    }
  }

  const slug = slugFromTask(task)
  try {
    const stage = await stageAttachments({
      blocks,
      slug,
      signal: invocation.signal,
      readImage: async (ref, signal) => toBytes((await readImage(ref, signal)).data),
      readFile: async (ref, signal) => readChunks(readFileStream(ref, signal)),
      write: async (relativePath, bytes) => {
        const absolute = join(workspace, relativePath)
        await mkdir(dirname(absolute), { recursive: true })
        await writeFile(absolute, bytes)
      },
    })
    return {
      slug,
      count: stage.files.length,
      lines: attachmentLines(stage),
      rollback: () => rollbackStage(workspace, stage),
    }
  } catch (error) {
    return { slug: null, count: 0, lines: ['附件读取失败：' + messageOf(error) + '；本次按无附件规划。'], rollback: async () => {} }
  }
}

/**
 * 回滚但不覆盖原始错误。
 * @author ddj 2026年11月24号
 * @param prep 附件准备结果（可能为空）
 * @returns 完成后的 Promise
 */
async function rollbackOf(prep: AttachmentPrep | null): Promise<void> {
  if (!prep) return
  try {
    await prep.rollback()
  } catch {
    /* 收尾失败不影响错误上报 */
  }
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
  const prepareAttachments = typeof options.prepareAttachments === 'function'
    ? options.prepareAttachments
    : (invocation: HtmlPlanInvocation, task: string) => stagePlanFiles(options.hostCtx, invocation, task)
  return {
    name: HTML_PLAN_COMMAND,
    description: HTML_PLAN_DESCRIPTION,
    input: { hint: '<任务描述>（可附图片或文件）', attachments: true },
    /** @private @author ddj 2026年11月21号 @param invocation 官方命令调用。 @returns 成功/错误结算。 */
    handler: async (invocation: HtmlPlanInvocation) => {
      const parsed = parseHtmlPlanInput(invocation?.rawInput)
      const task = parsed.task
      if (typeof commands.execute !== 'function') return { kind: 'error', text: '无法进入计划模式：官方 /plan 命令不可用' }
      const signal = invocation?.signal instanceof AbortSignal ? invocation.signal : new AbortController().signal

      let prep: AttachmentPrep | null = null
      try {
        prep = await prepareAttachments(invocation, task)
      } catch (error) {
        prep = { slug: null, count: 0, lines: ['附件读取失败：' + messageOf(error)], rollback: async () => {} }
      }

      try {
        const delegateNote = parsed.delegate === null ? '' : '\n' + (parsed.delegate ? HTML_PLAN_DELEGATE_INSTRUCTION : HTML_PLAN_SINGLE_AGENT_INSTRUCTION)
        const extras: HtmlPlanInstructionExtras = { slug: prep?.slug ?? null, attachmentLines: prep?.lines ?? [] }
        const message = task
          ? instructionOf(task, parsed.delegate, extras)
          : HTML_PLAN_BARE_INSTRUCTION + delegateNote + (prep?.lines.length ? '\n\n' + prep.lines.join('\n') : '')
        const execution = await commands.execute(invocation?.agent, '/plan ' + message, [], signal)
        if (!execution) {
          await rollbackOf(prep)
          return { kind: 'error', text: '无法进入计划模式：官方 /plan 命令不可用' }
        }
        if (execution.result?.kind !== 'success') {
          await rollbackOf(prep)
          return { kind: 'error', text: '无法进入计划模式：' + String(execution.result?.text ?? '未知原因') }
        }
        const saved = prep && prep.count > 0 && prep.slug ? '（' + String(prep.count) + ' 个附件在 plans/' + prep.slug + '/assets/）' : ''
        return { kind: 'success', text: (task ? 'HTML 计划模式已开启：正在生成 HTML 计划页…' : 'HTML 计划模式已开启：请描述要规划的任务') + saved }
      } catch (error) {
        await rollbackOf(prep)
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
      const mount = (): unknown => commands.register!(htmlPlanCommandDefinition(commands, { ...options, hostCtx: sctx }))
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
