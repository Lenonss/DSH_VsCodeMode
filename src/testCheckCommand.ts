/**
 * dsh-vscode-mode host — `/test-check [off|任务]` 命令：进入/离开测试验收模式。
 *
 * 命令只负责三件事：切模式（投影折叠命令事件）、建好单子目录、把任务与上报说明送进会话；
 * 规则由 `test-check:policy` 系统提示段落每请求提供（见 `testCheckGuidance.ts`）。
 *
 * 附件与 `/html-plan` 同一套落盘方式，只是目标目录换成 `.dsh/test-check/<id>/assets/`：
 * 验收单里引用截图/日志时，路径是相对项目根写的，所以 AI 能直接把证据挂到条目上。
 * @author ddj 2026年11月25号
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { cwdOfSession, type Ctx } from './store.js'
import { ensureSheet } from './testCheckStore.js'
import { stageAttachments, type AttachmentStage } from './htmlPlanAttachments.js'
import { readChunks, rollbackFiles, toBytes } from './attachmentBytes.js'
import {
  TEST_CHECK_BASE_DIR,
  TEST_CHECK_COMMAND,
  TEST_CHECK_EVENTS,
  TEST_CHECK_ITEMS,
  parseCheckInput,
  testCheckIdOf,
} from './shared/testCheck.js'

//region 结构面

/** 命令描述（出现在 / 菜单与命令目录）。 */
export const TEST_CHECK_DESCRIPTION = '进入或离开测试验收模式：/test-check [off|任务]（可附图片或文件）'

/** 官方命令调用（只声明本命令用到的字段）。 */
export interface CheckInvocation {
  /** 接收命令的 agent。 */
  agent?: { steer?: (message: unknown) => unknown; session?: unknown }
  /** 命令名之后的原始输入。 */
  rawInput?: unknown
  /** 取消信号。 */
  signal?: AbortSignal
  /** 已入库的图片/文件块（未声明 attachments 时为空）。 */
  attachments?: readonly unknown[]
}

/** 附件准备结果。 */
export interface CheckStage {
  /** 追加到任务消息里的说明段。 */
  lines: string[]
  /** 命令失败时回滚本次写入的附件。 */
  rollback: () => Promise<void>
}

/** 安装选项（测试可替换消息构造与附件准备）。 */
export interface CheckCommandOptions {
  /** 把纯文本包成宿主用户消息（由模式装配层注入 createUserMessage）。 */
  buildUserMessage?: (text: string) => unknown
  /** 附件准备（默认落盘到 `.dsh/test-check/<id>/assets/`）；测试可替换。 */
  prepareAttachments?: (invocation: CheckInvocation, id: string) => Promise<CheckStage>
  /** 宿主上下文：取 attachments 服务与会话工作区。 */
  hostCtx?: unknown
}

/** 附件存储服务最小结构面。 */
interface AttachmentStoreLike {
  readImage?: (ref: unknown, signal?: AbortSignal) => Promise<{ data?: unknown }>
  readFileStream?: (ref: unknown, signal?: AbortSignal) => AsyncIterable<Uint8Array>
}

//endregion

//region 工具

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
 * 取会话工作区（宿主未注入会话时返回 null）。
 * @author ddj 2026年11月25号
 * @param hostCtx 宿主上下文
 * @param session 会话
 * @returns 工作区绝对路径或 null
 */
function cwdOf(hostCtx: unknown, session: unknown): string | null {
  const ctx = hostCtx as { get?: (name: string) => unknown } | undefined
  if (!ctx || typeof ctx.get !== 'function' || !session) return null
  try {
    return cwdOfSession(ctx as Ctx, session as never)
  } catch {
    return null
  }
}

/**
 * 生成附件说明段（验收单是数据驱动的，附件只作为证据路径引用）。
 * @author ddj 2026年11月25号
 * @param stage 落盘结果
 * @param id 单子 id
 * @returns 逐行文本
 */
function attachLines(stage: AttachmentStage, id: string): string[] {
  const lines: string[] = []
  if (stage.files.length) {
    lines.push('附件已保存到 ' + TEST_CHECK_BASE_DIR + '/' + id + '/assets/（验收时可直接引用路径当证据）：')
    for (const file of stage.files) lines.push('- ' + file.relativePath + '（' + (file.kind === 'image' ? '图片' : '文件') + '）')
  }
  if (stage.skipped.length) {
    lines.push('以下附件没能落盘，本次不要引用：')
    for (const item of stage.skipped) lines.push('- ' + item.name + '：' + item.reason)
  }
  return lines
}

//endregion

//region 附件落盘

/**
 * 默认附件准备：把 composer 的图片/文件复制到 `.dsh/test-check/<id>/assets/`。
 *
 * 任何失败都降级成说明行，不阻断进入模式；只有命令最终失败时才回滚本次写入。
 * @author ddj 2026年11月25号
 * @param hostCtx 宿主上下文
 * @param invocation 官方命令调用
 * @param id 单子 id
 * @returns 附件准备结果
 */
export async function stageCheckFiles(hostCtx: unknown, invocation: CheckInvocation, id: string): Promise<CheckStage> {
  const empty: CheckStage = { lines: [], rollback: async () => {} }
  const blocks = Array.isArray(invocation?.attachments) ? invocation.attachments.filter(Boolean) : []
  if (!blocks.length) return empty

  const ctx = hostCtx as { get?: (name: string) => unknown } | undefined
  const workspace = cwdOf(hostCtx, invocation?.agent?.session)
  const store = ctx && typeof ctx.get === 'function' ? ctx.get('attachments') as AttachmentStoreLike | undefined : undefined
  const readImage = store?.readImage
  const readFileStream = store?.readFileStream
  if (!workspace || typeof readImage !== 'function' || typeof readFileStream !== 'function') {
    return {
      lines: ['附件读取失败：当前会话没有可用工作区或附件存储；本次按无附件验收。'],
      rollback: async () => {},
    }
  }

  try {
    const stage = await stageAttachments({
      blocks,
      slug: id,
      root: TEST_CHECK_BASE_DIR + '/' + id,
      signal: invocation.signal,
      readImage: async (ref, signal) => toBytes((await readImage(ref, signal)).data),
      readFile: async (ref, signal) => readChunks(readFileStream(ref, signal)),
      write: async (relativePath, bytes) => {
        const absolute = join(workspace, relativePath)
        await mkdir(dirname(absolute), { recursive: true })
        await writeFile(absolute, bytes)
      },
    })
    return { lines: attachLines(stage, id), rollback: () => rollbackFiles(workspace, stage) }
  } catch (error) {
    return { lines: ['附件读取失败：' + messageOf(error) + '；本次按无附件验收。'], rollback: async () => {} }
  }
}

/**
 * 回滚但不覆盖原始错误。
 * @author ddj 2026年11月25号
 * @param stage 附件准备结果（可能为空）
 * @returns 完成后的 Promise
 */
async function rollbackOf(stage: CheckStage | null): Promise<void> {
  if (!stage) return
  try {
    await stage.rollback()
  } catch {
    /* 收尾失败不影响错误上报 */
  }
}

//endregion

//region 消息

/**
 * 拼送给模型的任务消息：任务原文 + 单子路径 + 上报约定 + 附件说明。
 * @author ddj 2026年11月25号
 * @param task 任务文本
 * @param id 单子 id
 * @param stage 附件准备结果
 * @returns 用户消息文本
 */
export function checkMessage(task: string, id: string, stage: CheckStage | null): string {
  const lines: string[] = []
  if (task) lines.push(task)
  if (lines.length) lines.push('')
  lines.push('验收单 id：' + id)
  lines.push('定义：' + TEST_CHECK_BASE_DIR + '/' + id + '/' + TEST_CHECK_ITEMS + '（不存在就先建单；ID 形如 settings.claude-style.004）')
  lines.push('上报：test_check_report（item / status / summary 必填，summary 就是证据；status 用 pass / fail / blocked / skip）')
  lines.push('项目规则：' + TEST_CHECK_BASE_DIR + '/policy.md（可选，用户可自己写；写进规则段，改完当次请求生效）')
  lines.push('结果目录：' + TEST_CHECK_BASE_DIR + '/' + id + '/' + TEST_CHECK_EVENTS + '/（每条一个 JSON 文件）')
  lines.push('收尾：test_check_finish，把验收单导出到 docs/acceptance-' + id + '.html')
  lines.push('离开模式：/test-check off')
  if (stage?.lines.length) {
    lines.push('')
    lines.push(...stage.lines)
  }
  return lines.join('\n')
}

//endregion

//region 命令定义

/**
 * 构造 `/test-check` 命令定义（导出便于单测直接调用 handler）。
 * @author ddj 2026年11月25号
 * @param options 安装选项
 * @returns 官方 CommandDefinition 形状对象
 */
export function checkCommand(options: CheckCommandOptions = {}): unknown {
  const prepare = typeof options.prepareAttachments === 'function'
    ? options.prepareAttachments
    : (invocation: CheckInvocation, id: string) => stageCheckFiles(options.hostCtx, invocation, id)
  return {
    name: TEST_CHECK_COMMAND,
    description: TEST_CHECK_DESCRIPTION,
    input: { hint: '[off|任务]（可附图片或文件）', attachments: true },
    /** @private @author ddj 2026年11月25号 @param invocation 官方命令调用。 @returns 成功/错误结算。 */
    handler: async (invocation: CheckInvocation) => {
      const parsed = parseCheckInput(invocation?.rawInput)
      const blocks = Array.isArray(invocation?.attachments) ? invocation.attachments.filter(Boolean) : []

      if (parsed.action === 'off') {
        if (blocks.length) return { kind: 'error', text: '离开测试验收模式不能附带图片或文件' }
        return { kind: 'success', text: '测试验收模式已关闭。' }
      }

      const workspace = cwdOf(options.hostCtx, invocation?.agent?.session)
      if (!workspace) return { kind: 'error', text: '无法进入测试验收模式：当前会话没有可用工作区' }

      const id = testCheckIdOf(parsed.task)
      let created: boolean
      try {
        const ensured = await ensureSheet({ cwd: workspace, id })
        created = ensured.created
      } catch (error) {
        return { kind: 'error', text: '无法创建验收单目录：' + messageOf(error) }
      }

      let stage: CheckStage | null = null
      try {
        stage = await prepare(invocation, id)
      } catch (error) {
        stage = { lines: ['附件读取失败：' + messageOf(error)], rollback: async () => {} }
      }

      const text = checkMessage(parsed.task, id, stage)
      const steer = invocation?.agent?.steer
      const build = options.buildUserMessage
      if (typeof steer !== 'function' || typeof build !== 'function') {
        await rollbackOf(stage)
        return { kind: 'error', text: '无法把任务送进会话：宿主缺少消息构造或 steer 能力' }
      }
      try {
        steer.call(invocation.agent, build(text))
      } catch (error) {
        await rollbackOf(stage)
        return { kind: 'error', text: '无法把任务送进会话：' + messageOf(error) }
      }

      const hasItems = existsSync(join(workspace, TEST_CHECK_BASE_DIR, id, TEST_CHECK_ITEMS))
      const saved = stage && stage.lines.length && stage.lines[0].startsWith('附件已保存') ? '（附件已落盘）' : ''
      const head = created || !hasItems
        ? '测试验收模式已开启：验收单 ' + id + ' 还没建单，按提示先写 items.json。'
        : '测试验收模式已开启：验收单 ' + id + '。'
      return { kind: 'success', text: head + saved + ' 离开用 /test-check off。' }
    },
  }
}

//endregion
