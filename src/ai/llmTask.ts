/**
 * dsh-vscode-mode host — 统一 AI JSON 任务层（22-agent-tools-and-commit）。
 *
 * 为什么单独成模块：AI 整理、AI 提交信息、后续 AI 复核都是「系统指令 + 数据 prompt →
 * 严格 JSON」同一形状。之前这套流式汇聚/超时/失败分类内联在 svnTriage 里，
 * 第二个任务只能复制一遍；抽出来后失败文案与超时口径只有一份。
 *
 * 口径：一次性非会话流式调用（llm.of → taskRouteOf），只收 text-delta；
 * 适配器失败走 finish(error/aborted) 而非抛异常；任何失败都归一成 code + 可读文案。
 * @author ddj 2026年11月15号
 */
import type { Ctx } from '../store.js'
import type { AiConfigView } from '../shared/ai.js'
import type { LlmRuntimeLike, StreamChunk } from './llmTypes.js'
import { llmOf, taskRouteOf } from './inline.js'

/** AI 任务失败分类（client 据此给不同可操作提示）。 */
export type LlmTaskCode = 'UNAVAILABLE' | 'NO_MODEL' | 'TIMEOUT' | 'STREAM' | 'PARSE' | 'EMPTY'

/** 一次 JSON 任务请求。 */
export interface LlmTaskRequest {
  /** 系统指令（输出契约 + 硬约束）。 */
  system: string
  /** 用户段（数据；不含任何可执行指令）。 */
  prompt: string
  /** 超时（毫秒）。 */
  timeoutMs: number
  /** 输出 token 上限。 */
  maxTokens: number
  /** 温度（缺省 0.2）。 */
  temperature?: number
  /** 会话身份（provider 路由用；如 opencode-go 的 x-opencode-session）。 */
  sessionId?: string
}

/** 任务结果（成功带解析后的对象与模型标识）。 */
export type LlmTaskOutcome =
  | { ok: true; raw: unknown; text: string; model: string; elapsedMs: number }
  | { ok: false; code: LlmTaskCode; error: string; model?: string }

/**
 * 模型流失败 → 可操作文案（未注册 provider 单独指引，不要把底层错误码直接甩给用户）。
 * @author ddj 2026年11月15号
 * @param label provider/model @param kind finish 原因 @param failure 适配器失败细节
 * @returns 分类与文案
 */
function streamFailureOf(
  label: string,
  kind: string,
  failure?: { code?: string; message?: string },
): { code: LlmTaskCode; error: string } {
  const detail = failure?.code ?? kind
  const message = failure?.message ?? '模型调用失败'
  const text = detail + ' ' + message
  if (/MissingSessionID|x-opencode-session/i.test(text)) {
    return {
      code: 'NO_MODEL',
      error: '任务模型 ' + label + ' 要求会话身份（' + detail + '）：插件已带当前会话仍被拒时，请在「设置 → AI」换一个支持一次性调用的模型',
    }
  }
  if (/NO_ADAPTER|no adapter registered|未注册|not registered/i.test(text)) {
    return {
      code: 'NO_MODEL',
      error: '任务模型 ' + label + ' 在宿主未注册（' + detail + '）：请在「设置 → AI」里换一个可用模型，或把任务模型留空以跟随补全配置',
    }
  }
  if (kind === 'aborted') return { code: 'STREAM', error: '任务模型 ' + label + ' 调用被中断：' + message }
  return { code: 'STREAM', error: '任务模型 ' + label + ' 调用失败（' + detail + '）：' + message }
}

/**
 * 从模型输出里取 JSON 对象（剥围栏 → 首个 { 至末个 } → parse）。
 * @author ddj 2026年11月15号
 * @param text 模型输出原文
 * @returns 解析出的对象
 */
export function parseJsonObject(text: string): unknown {
  const raw = String(text ?? '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('AI 输出不含 JSON 对象：' + raw.slice(0, 200))
  const body = raw.slice(start, end + 1)
  try {
    return JSON.parse(body)
  } catch (error) {
    throw new Error('AI 输出无法解析为 JSON：' + String(error) + '（原文摘要：' + body.slice(0, 200) + '）')
  }
}

/**
 * 执行一次 JSON 任务（不抛错：所有失败都归一成 §{ ok:false, code }§）。
 * @author ddj 2026年11月15号
 * @param ctx DSH 上下文
 * @param cfg AI 配置（任务模型优先，回落补全配置）
 * @param request 任务请求
 * @returns 任务结果
 */
export async function runJsonTask(ctx: Ctx, cfg: AiConfigView, request: LlmTaskRequest): Promise<LlmTaskOutcome> {
  const llm: LlmRuntimeLike | null = llmOf(ctx)
  if (!llm) return { ok: false, code: 'UNAVAILABLE', error: 'llm 服务不可用（请检查 DSH 模型配置）' }
  const route = await taskRouteOf(llm, cfg)
  if (!route) return { ok: false, code: 'NO_MODEL', error: '未找到可用模型（请检查 DSH 模型配置）' }
  const label = route.provider + '/' + route.model

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('timeout'))
  }, request.timeoutMs)

  const startedAt = Date.now()
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      ...(route.effort ? { reasoningEffort: route.effort } : {}),
      messages: [
        { role: 'user', content: [{ type: 'text', text: request.prompt }], source: { kind: 'user' } } as never,
      ],
      system: request.system,
      temperature: request.temperature ?? 0.2,
      maxTokens: request.maxTokens,
      // 会话身份：部分 provider（如 opencode-go）据此生成路由头，缺省会 400 MissingSessionID
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      // 不传 stop：llm-pi-ai 等适配器不支持该选项（UNSUPPORTED_OPTION 直接 error finish）
      signal: controller.signal,
    })

    let text = ''
    let failNote: { code: LlmTaskCode; error: string } | null = null
    for await (const chunk of stream) {
      const item = chunk as StreamChunk
      if (item.type === 'text-delta') {
        text += item.text
      } else if (item.type === 'finish') {
        const kind = (item.reason as { kind?: string })?.kind
        if (kind === 'error' || kind === 'aborted') {
          const failure = (item.reason as { failure?: { code?: string; message?: string } }).failure
          failNote = streamFailureOf(label, kind, failure)
        }
        break
      }
    }
    if (failNote) return { ok: false, code: failNote.code, error: failNote.error, model: label }
    if (!text.trim()) return { ok: false, code: 'EMPTY', error: '任务模型 ' + label + ' 没有返回任何内容', model: label }
    let raw: unknown
    try {
      raw = parseJsonObject(text)
    } catch (error) {
      return {
        ok: false,
        code: 'PARSE',
        error: '任务模型 ' + label + ' 输出不是合法 JSON：' + String(error instanceof Error ? error.message : error),
        model: label,
      }
    }
    return {
      ok: true,
      raw,
      text,
      model: route.provider + '/' + route.model,
      elapsedMs: Date.now() - startedAt,
    }
  } catch (error) {
    if (timedOut) {
      return {
        ok: false,
        code: 'TIMEOUT',
        error: '任务模型 ' + label + ' 超时（' + Math.round(request.timeoutMs / 1000) + 's）：可在设置页调低任务模型思考强度或换更快模型',
        model: label,
      }
    }
    return { ok: false, code: 'STREAM', error: '任务模型 ' + label + ' 调用失败：' + String(error instanceof Error ? error.message : error), model: label }
  } finally {
    clearTimeout(timer)
  }
}
