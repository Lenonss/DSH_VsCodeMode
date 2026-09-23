/**
 * dsh-vscode-mode host — AI 智能整理分析模块（11-ai-changelist-triage）。
 * 一次性非会话调用：prompt 构造（变更清单 + 可选 diff）→ ctx.llm.stream 流式汇聚
 * （只收 text-delta）→ JSON 解析。llm 复用 inline.ts 的 llmOf；模型路由走独立
 * 「AI 任务模型」配置（taskRouteOf，空则回落补全配置，与内联补全互不干扰）。
 * 产出的原始 JSON 交给 shared 的 normalizeAiPlan 以真实变更清单白名单归一。
 * 作者 ddj 2026年09月23号
 */
import type { Ctx } from '../store.js'
import type { SvnChangeEntry } from '../shared/svn.js'
import { AI_PLAN_TIMEOUT_MS } from '../shared/svn.js'
import type { AiConfigView } from '../shared/ai.js'
import type { LlmRuntimeLike, StreamChunk } from './llmTypes.js'
import { llmOf, taskRouteOf } from './inline.js'

/** 方案生成最大输出 token（三段 JSON 上限；再大是幻觉温床）。 */
export const AI_PLAN_MAX_TOKENS = 8192

/** 系统指令：输出唯一 JSON + 三段判据 + 硬约束（不虚构路径/一路径一类）。 */
export const AI_PLAN_SYSTEM = [
  '你是 SVN 变更整理助手。根据给出的工作副本变更清单（可能附 diff），产出整理方案，',
  '输出唯一 JSON 对象，除 JSON 外不得输出任何文本（不要围栏、不要解释）：',
  '{',
  '  "groups": [{ "name": "英文短名", "paths": ["路径1"], "reason": "分组理由" }],',
  '  "reverts": [{ "path": "路径", "reason": "还原理由" }],',
  '  "ignores": [{ "path": "路径", "reason": "忽略理由" }]',
  '}',
  '规则：',
  '1. 只可使用清单中出现的路径，绝不虚构或改写路径。',
  '2. 每个路径至多归入一段（groups/reverts/ignores 互斥），拿不准的路径三段都不列。',
  '3. groups：按功能主题把待提交改动分入 changelist 组；name 用简短英文（不以 - 开头），',
  '   同一主题合并为一组，组数尽量少。',
  '4. reverts：仅针对受版本控制的改动建议还原——行尾/空白噪音、误改、试验性改动等。',
  '5. ignores：仅针对未版本化的条目建议忽略——构建产物、缓存、日志、临时文件等生成物。',
  '6. reason 用简短中文一句话说明判定依据。',
].join('\n')

/**
 * 构造分析用户段：变更清单行（status | path | changelist）+ 可选 diff 上下文。
 * @author ddj 2026年09月23号
 * @param entries 变更清单（调用方已按 AI_PLAN_PATHS_CAP 截断）
 * @param diffText diff 文本（null = paths-only 降级）
 * @param truncated 清单是否已截断（prompt 注明，防 AI 误以为是全集）
 * @returns 用户消息文本
 */
export function buildAiPrompt(entries: readonly SvnChangeEntry[], diffText: string | null, truncated = false): string {
  const lines = entries.map((entry) =>
    entry.status + ' | ' + entry.path + (entry.changelist ? ' | ' + entry.changelist : ''))
  const head = truncated
    ? '变更清单（已截断，仅分析所列条目；status | path | changelist）：'
    : '变更清单（status | path | changelist）：'
  let text = head + '\n' + lines.join('\n')
  if (diffText) text += '\n\n变更 diff（unified，0 上下文行）：\n' + diffText
  else text += '\n\n（无 diff 上下文，仅按路径与状态判断）'
  return text
}

/**
 * 解析 AI 输出 JSON：剥 ``` 围栏 → 取首个 `{` 至末个 `}` → JSON.parse。
 * 失败抛带原文摘要的错误（调用方整体报错零执行，不静默降级）。
 * @author ddj 2026年09月23号
 * @param text 模型输出原文
 * @returns 解析出的对象（形状由 normalizeAiPlan 容错）
 */
export function parseAiPlanJson(text: string): unknown {
  const raw = String(text ?? '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('AI 输出不含 JSON 对象：' + raw.slice(0, 200))
  }
  const body = raw.slice(start, end + 1)
  try {
    return JSON.parse(body)
  } catch (error) {
    throw new Error('AI 输出无法解析为 JSON：' + String(error) + '（原文摘要：' + body.slice(0, 200) + '）')
  }
}

/** AI 分析结果（raw 交 normalizeAiPlan 归一；失败以抛错方式上抛）。 */
export interface SvnTriageResult {
  /** 解析出的原始方案对象。 */
  raw: unknown
  /** 实际使用的 provider/model（诊断与 UI 展示）。 */
  model: string
}

/**
 * 一次 AI 智能整理分析（一次性非会话流式调用）。
 * llm 缺失/不可路由/流失败/解析失败一律抛错，由 handler 转 `{ok:false, error}`（零执行）。
 * @author ddj 2026年09月23号
 * @param ctx DSH 上下文（取 llm）
 * @param cfg AI 配置（任务模型路由优先，回落补全配置）
 * @param prompt 用户段（buildAiPrompt 产物）
 * @returns 原始方案对象与模型标识
 */
export async function svnAiPlanOf(ctx: Ctx, cfg: AiConfigView, prompt: string): Promise<SvnTriageResult> {
  const llm: LlmRuntimeLike | null = llmOf(ctx)
  if (!llm) throw new Error('llm 服务不可用（请检查 DSH 模型配置）')
  const route = await taskRouteOf(llm, cfg)
  if (!route) throw new Error('未找到可用模型（请检查 DSH 模型配置）')
  const controller = new AbortController()
  // 超时标志：与普通流失败区分（超时给可操作提示——降档/换快模型），不与适配器报错混文案
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort(new Error('timeout')) }, AI_PLAN_TIMEOUT_MS)
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      ...(route.effort ? { reasoningEffort: route.effort } : {}),
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        } as never,
      ],
      system: AI_PLAN_SYSTEM,
      temperature: 0.2,
      maxTokens: AI_PLAN_MAX_TOKENS,
      // 不传 stop：llm-pi-ai 等适配器不支持该选项（UNSUPPORTED_OPTION 直接 error finish）
      signal: controller.signal,
    })
    let text = ''
    let failNote = ''
    for await (const chunk of stream) {
      const c = chunk as StreamChunk
      if (c.type === 'text-delta') {
        text += c.text
      } else if (c.type === 'finish') {
        // 适配器失败走 finish(error/aborted) 而非抛异常（inline 同款口径）
        const kind = (c.reason as { kind?: string })?.kind
        if (kind === 'error' || kind === 'aborted') {
          const failure = (c.reason as { failure?: { code?: string; message?: string } }).failure
          failNote = '模型流失败 ' + (failure?.code ?? kind) + ': ' + (failure?.message ?? '模型调用失败')
        }
        break
      }
    }
    if (failNote) throw new Error(failNote)
    return { raw: parseAiPlanJson(text), model: route.provider + '/' + route.model }
  } catch (error) {
    if (timedOut) {
      throw new Error('AI 分析超时（' + Math.round(AI_PLAN_TIMEOUT_MS / 1000) + 's）：可在设置页调低任务模型思考强度或换更快模型')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
