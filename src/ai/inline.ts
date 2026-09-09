/**
 * dsh-vscode-mode host — AI 内联补全服务。
 * 一次性非会话调用：配置解析（开关→provider/model 路由→思考档位）→ ctx.llm.stream
 * 流式汇聚（只收 text-delta，reasoning-delta 天然不进补全）→ 早停 → 输出清理。
 * llm 服务经 ctx.get('llm') 惰性获取（不用 inject：缺失时插件仍加载，AI 补全降级）。
 * 模型目录（edrv.ai.models）：listProviders/listModels/resolveModelInfo 逐模型取档位，
 * 进程级缓存 5 分钟，单模型 resolve 失败降级为无档位条目。
 * 作者 ddj
 */
import type { Ctx } from '../store.js'
import { log } from '../log.js'
import type { LlmRuntimeLike, StreamChunk } from './llmTypes.js'
import {
  AI_EARLY_STOP_CHARS, AI_INLINE_SYSTEM, AI_MAX_LINES, AI_MAX_TOKENS, AI_TIMEOUT_MS,
  buildInlinePrompt, cleanInlineText,
  type AiConfigView, type AiDirectoryView, type AiInlineRequest, type AiInlineResult,
} from '../shared/ai.js'

/** AI 补全配置来源（settings section，fileOpenSettings.ts 提供 getter）。 */
export interface AiConfigSource {
  get(): AiConfigView
}

/** host 补全服务依赖（装配时一次性注入）。 */
export interface AiInlineDeps {
  ctx: Ctx
  config: AiConfigSource
}

/** 模型目录缓存（进程级：5 分钟 TTL，避免每次打开设置页都逐模型 resolve）。 */
const DIR_TTL_MS = 5 * 60 * 1000
let dirCache: { view: AiDirectoryView; at: number } | null = null

/** 复位目录缓存（测试隔离用）。 */
export function resetAiDirCache(): void {
  dirCache = null
}

/**
 * 取 llm 运行时（惰性；缺失/未装配返回 null 并给诊断）。
 * @author ddj
 * @param ctx DSH 上下文
 * @returns llm 运行时或 null
 */
function llmOf(ctx: Ctx): LlmRuntimeLike | null {
  try {
    const llm = ctx.get('llm') as LlmRuntimeLike | undefined
    return llm && typeof llm.stream === 'function' ? llm : null
  } catch {
    return null
  }
}

/**
 * 解析请求路由：用户配置优先（provider/model 均非空），否则取目录首个 provider+model。
 * @author ddj
 * @param llm llm 运行时
 * @param cfg AI 配置
 * @returns 路由（provider/model）；不可路由返回 null
 */
async function routeOf(llm: LlmRuntimeLike, cfg: AiConfigView): Promise<{ provider: string; model: string } | null> {
  if (cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
  const providers = llm.listProviders()
  if (!providers.length) return null
  const provider = cfg.provider || providers[0].id
  const models = await llm.listModels(provider).catch(() => [])
  if (!models.length) return null
  return { provider, model: models[0].id }
}

/**
 * 单次 AI 内联补全。
 * @author ddj
 * @param deps 服务依赖
 * @param req 补全请求（client 已裁剪窗口）
 * @returns 补全结果（text 空 = 无建议）
 */
export async function aiInlineComplete(deps: AiInlineDeps, req: AiInlineRequest): Promise<AiInlineResult> {
  const cfg = deps.config.get()
  if (!cfg.enabled) return { text: '' }
  if (!req || typeof req.prefix !== 'string' || !req.prefix) return { text: '' }
  const llm = llmOf(deps.ctx)
  if (!llm) return { text: '', note: 'llm 服务不可用' }
  const route = await routeOf(llm, cfg)
  if (!route) return { text: '', note: '未找到可用模型（请检查 DSH 模型配置）' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), AI_TIMEOUT_MS)
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      ...(cfg.effort ? { reasoningEffort: cfg.effort } : {}),
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: buildInlinePrompt(req) }],
          source: { kind: 'user' },
        } as never,
      ],
      system: AI_INLINE_SYSTEM,
      temperature: 0.2,
      maxTokens: AI_MAX_TOKENS,
      // 不传 stop：llm-pi-ai 等适配器不支持该选项（UNSUPPORTED_OPTION 直接 error finish）；
      // 截断由行数/字符早停兜底
      signal: controller.signal,
    })
    let text = ''
    let aborted = false
    let failNote = ''
    let reasoningChars = 0
    for await (const chunk of stream) {
      const c = chunk as StreamChunk
      if (c.type === 'text-delta') {
        text += c.text
        // 早停：满 3 行或 300 字符即掐断流，省尾部 token 延迟
        if (text.split('\n').length > AI_MAX_LINES || text.length >= AI_EARLY_STOP_CHARS) {
          controller.abort(new Error('early-stop'))
          aborted = true
        }
      } else if (c.type === 'reasoning-delta') {
        reasoningChars += c.text.length
      } else if (c.type === 'finish') {
        // 适配器失败走 finish(error/aborted) 而非抛异常：检查 reason.kind 带回诊断
        const kind = (c.reason as { kind?: string })?.kind
        if (kind === 'error' || kind === 'aborted') {
          const failure = (c.reason as { failure?: { code?: string; message?: string } }).failure
          failNote = (failure?.code ?? kind) + ': ' + (failure?.message ?? '模型调用失败')
          log.debug('[ai-inline] 流失败：' + failNote)
        }
        break
      } else if (c.type === 'usage' || c.type === 'block-start' || c.type === 'block-end') {
        // 汇聚无关块：跳过
      } else if (c.type === 'tool-call-delta') {
        // 工具块不进补全
      }
      if (aborted) break
    }
    if (failNote) return { text: '', note: 'AI 补全失败：' + failNote }
    const clean = cleanInlineText(text, req.prefix)
    if (!clean) {
      // 思考型模型常见症状：正文空但思考有内容 → 明确提示换非思考模型（debug 实证 isd/deepseek-v4-flash）
      if (text.length === 0 && reasoningChars > 0) {
        log.debug('[ai-inline] 仅思考无正文（reasoning ' + reasoningChars + ' 字符）')
        return { text: '', note: '该模型只返回了思考没有正文，请在设置页换非思考模型' }
      }
      log.debug('[ai-inline] 空输出（原始 ' + text.length + ' 字符）')
      return { text: '' }
    }
    return { text: clean }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log.debug('[ai-inline] 失败：' + msg)
    return { text: '', note: 'AI 补全失败：' + msg }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 模型目录视图（edrv.ai.models）：DSH 已配置 provider 全量 + 逐模型思考档位。
 * @author ddj
 * @param ctx DSH 上下文
 * @param force 跳过缓存强制刷新
 * @returns 目录视图（llm 缺失时 note 说明 + 空目录）
 */
export async function aiModels(ctx: Ctx, force = false): Promise<AiDirectoryView> {
  if (!force && dirCache && Date.now() - dirCache.at < DIR_TTL_MS) return dirCache.view
  const llm = llmOf(ctx)
  if (!llm) {
    return { providers: [], note: 'llm 服务不可用（无法枚举模型）' }
  }
  const out: AiDirectoryView = { providers: [] }
  for (const p of llm.listProviders()) {
    const models = await llm.listModels(p.id).catch(() => [])
    const entries = []
    for (const m of models) {
      let efforts: Array<{ id: string; name: string }> = []
      let def = ''
      try {
        const info = await llm.resolveModelInfo(p.id, m.id)
        efforts = (info.reasoning?.efforts ?? []).map((e: { id: string; name: string }) => ({ id: e.id, name: e.name }))
        def = info.reasoning?.defaultEffort ?? ''
      } catch {
        // 单模型元数据失败：降级为无档位条目（不影响目录其余部分）
      }
      entries.push({ provider: p.id, model: m.id, name: m.name || m.id, efforts, defaultEffort: def })
    }
    out.providers.push({ id: p.id, name: p.name || p.id, models: entries })
  }
  dirCache = { view: out, at: Date.now() }
  return out
}
