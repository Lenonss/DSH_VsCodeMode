/**
 * dsh-vscode-mode host — `/html-plan` 命令：进入/离开 HTML 计划模式。
 *
 * 与旧实现的区别：不再把一段长指令塞给官方 `/plan`，也不再要求模型写页面或跑 node；
 * 命令只负责「选模式 + 把任务作为普通用户消息送进会话」，规则由 `html-plan:policy`
 * 系统提示段落每请求提供（见 `htmlPlanMode.ts` / `htmlPlanGuidance.ts`）。
 *
 * 附件：命令声明 `input.attachments`，官方执行器把 composer 的图片/文件入库后再交给本处理器；
 * 处理器把字节复制到 `plans/<slug>/assets/`（作者页可引用），并把路径写进送给模型的任务消息。
 * @author ddj 2026年11月25号
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { cwdOfSession, type Ctx } from './store.js'
import { attachmentLines, slugFromTask, stageAttachments } from './htmlPlanAttachments.js'
import { readChunks, rollbackFiles, toBytes } from './attachmentBytes.js'
import { HTML_PLAN_COMMAND } from './shared/htmlPlanMode.js'

//region 命令元信息

/** 命令名（官方语法：小写字母开头，允许数字/_/-）。 */
export { HTML_PLAN_COMMAND }

/** 命令描述（出现在 / 菜单与命令目录）。 */
export const HTML_PLAN_DESCRIPTION = '进入或离开 HTML 计划模式：/html-plan [off|任务]（可附图片或文件）'

//endregion

//region 结构面

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
  agent?: { steer?: (message: unknown) => unknown }
  /** 命令名之后的原始输入。 */
  rawInput?: unknown
  /** 取消信号。 */
  signal?: AbortSignal
  /** 已入库的图片/文件块（未声明 attachments 时为空）。 */
  attachments?: readonly unknown[]
}

/** 附件准备结果（默认实现是落盘；测试可注入假的）。 */
export interface AttachmentPrep {
  /** 固定 slug；没附件时 null。 */
  slug: string | null
  /** 落盘成功的附件数量。 */
  count: number
  /** 追加到任务消息里的附件段。 */
  lines: string[]
  /** 命令失败时回滚本次写入的附件。 */
  rollback: () => Promise<void>
}

/** 命令输入解析结果。 */
export interface HtmlPlanInput {
  /** off = 离开模式；enter = 进入模式（可带任务）。 */
  action: 'off' | 'enter'
  /** 剥离开关后的任务文本。 */
  task: string
}

/** 附件存储服务最小结构面。 */
interface AttachmentStoreLike {
  readImage?: (ref: unknown, signal?: AbortSignal) => Promise<{ data?: unknown }>
  readFileStream?: (ref: unknown, signal?: AbortSignal) => AsyncIterable<Uint8Array>
}

/** 安装选项（测试可替换消息构造与附件准备）。 */
export interface HtmlPlanCommandOptions {
  /** 把纯文本包成宿主用户消息（由模式装配层注入 createUserMessage）。 */
  buildUserMessage?: (text: string) => unknown
  /** 附件准备（默认落盘到 plans/<slug>/assets/）；测试可替换。 */
  prepareAttachments?: (invocation: HtmlPlanInvocation, task: string) => Promise<AttachmentPrep>
  /** 宿主上下文：取 attachments 服务与会话工作区。 */
  hostCtx?: unknown
}

//endregion

//region 输入解析

/**
 * 解析 `/html-plan` 的输入：`off` 表示离开模式；其余文本作为任务（原样保留内部换行）。
 * @author ddj 2026年11月25号
 * @param rawInput 官方命令的 rawInput
 * @returns 动作与任务文本
 */
export function parseHtmlPlanInput(rawInput: unknown): HtmlPlanInput {
  const text = String(rawInput ?? '').trim()
  if (/^off$/i.test(text)) return { action: 'off', task: '' }
  return { action: 'enter', task: text }
}

//endregion

//region 附件落盘

/**
 * 取异常的展示文案。
 * @author ddj 2026年11月25号
 * @param error 捕获值
 * @returns 可读文案
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error ?? '未知错误')
}


/**
 * 默认附件准备：把 composer 的图片/文件复制到 plans/<slug>/assets/。
 *
 * 任何失败（服务缺失、读字节失败、写盘失败）都降级成说明行，不阻断进入模式；
 * 只有命令最终失败时才会回滚本次写入。
 * @author ddj 2026年11月25号
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
      rollback: () => rollbackFiles(workspace, stage),
    }
  } catch (error) {
    return { slug: null, count: 0, lines: ['附件读取失败：' + messageOf(error) + '；本次按无附件规划。'], rollback: async () => {} }
  }
}

/**
 * 回滚但不覆盖原始错误。
 * @author ddj 2026年11月25号
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

//endregion

//region 命令定义

/**
 * 构造 `/html-plan` 命令定义（导出便于单测直接调用 handler）。
 * @author ddj 2026年11月25号
 * @param commands 官方命令运行时
 * @param options 安装选项
 * @returns 官方 CommandDefinition 形状对象
 */
export function htmlPlanCommandDefinition(commands: CommandsLike, options: HtmlPlanCommandOptions = {}): unknown {
  const prepareAttachments = typeof options.prepareAttachments === 'function'
    ? options.prepareAttachments
    : (invocation: HtmlPlanInvocation, task: string) => stagePlanFiles(options.hostCtx, invocation, task)
  return {
    name: HTML_PLAN_COMMAND,
    description: HTML_PLAN_DESCRIPTION,
    input: { hint: '[off|任务]（可附图片或文件）', attachments: true },
    /** @private @author ddj 2026年11月25号 @param invocation 官方命令调用。 @returns 成功/错误结算。 */
    handler: async (invocation: HtmlPlanInvocation) => {
      const parsed = parseHtmlPlanInput(invocation?.rawInput)
      const blocks = Array.isArray(invocation?.attachments) ? invocation.attachments.filter(Boolean) : []

      if (parsed.action === 'off') {
        if (blocks.length) return { kind: 'error', text: '离开 HTML 计划模式不能附带图片或文件' }
        return { kind: 'success', text: 'HTML 计划模式已关闭。' }
      }

      let prep: AttachmentPrep | null = null
      try {
        prep = await prepareAttachments(invocation, parsed.task)
      } catch (error) {
        prep = { slug: null, count: 0, lines: ['附件读取失败：' + messageOf(error)], rollback: async () => {} }
      }

      const lines: string[] = []
      if (parsed.task) lines.push(parsed.task)
      if (prep?.lines.length) {
        if (lines.length) lines.push('')
        lines.push(...prep.lines)
      }

      const text = lines.join('\n')
      if (text) {
        const steer = invocation?.agent?.steer
        const build = options.buildUserMessage
        if (typeof steer !== 'function' || typeof build !== 'function') {
          await rollbackOf(prep)
          return { kind: 'error', text: '无法把任务送进会话：宿主缺少消息构造或 steer 能力' }
        }
        try {
          steer.call(invocation.agent, build(text))
        } catch (error) {
          await rollbackOf(prep)
          return { kind: 'error', text: '无法把任务送进会话：' + messageOf(error) }
        }
      }

      const saved = prep && prep.count > 0 && prep.slug ? '（' + String(prep.count) + ' 个附件在 plans/' + prep.slug + '/assets/）' : ''
      const opened = parsed.task
        ? 'HTML 计划模式已开启（离开用 /html-plan off）。'
        : 'HTML 计划模式已开启：请描述要规划的任务（离开用 /html-plan off）。'
      return { kind: 'success', text: opened + saved }
    },
  }
}

//endregion
