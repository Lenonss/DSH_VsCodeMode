/**
 * dsh-vscode-mode shared — AI 内联补全契约与纯函数（双面，禁 node/react）。
 * 只放"过 RPC 的载荷形状"与无副作用变换：窗口裁剪、prompt 拼装、输出清理。
 * host 与语言模型之间的流式交互在 host 侧 src/ai/inline.ts。
 * 作者 ddj
 */

/** 上下文窗口：前缀字符上限（含未保存编辑的当前文档）。 */
export const AI_PREFIX_MAX = 2000
/** 上下文窗口：后缀字符上限（光标之后不参与补全语义的部分）。 */
export const AI_SUFFIX_MAX = 500
/** 触发门槛：前缀至少 4 个字符才请求（省掉空转调用）。 */
export const AI_MIN_PREFIX = 4
/** 单次补全输出上限（token 预算 + 行数双约束，早停兜底）。 */
export const AI_MAX_TOKENS = 120
/** 输出行数上限：超过即截断（ghost text 太长不可用）。 */
export const AI_MAX_LINES = 3
/** 流式早停：已收字符数达到该值即 abort（省尾部延迟）。 */
export const AI_EARLY_STOP_CHARS = 300
/** 补全请求超时（毫秒）：codebuddy CLI 网关实测 TTFT 3.5~8.4s 抖动（debug 实证），
 *  12s 内无任何 token 即放弃；token 一到仍按行数/字符早停。 */
export const AI_TIMEOUT_MS = 12000

/** client → host 的补全请求载荷。 */
export interface AiInlineRequest {
  /** 当前文档工作区相对路径（语言提示用）。 */
  path: string
  /** 光标前文本（client 已裁剪到 AI_PREFIX_MAX）。 */
  prefix: string
  /** 光标后文本（client 已裁剪到 AI_SUFFIX_MAX）。 */
  suffix: string
}

/** host → client 的补全结果（text 为空 = 无建议）。 */
export interface AiInlineResult {
  /** 建议插入文本（已清理：剥围栏/截行数/去重复）。 */
  text: string
  /** 失败原因（ok:false 或 text 为空时的诊断文案，供状态栏展示）。 */
  note?: string
}

/** 模型目录条目（含该模型的思考档位元数据）。 */
export interface AiModelEntry {
  provider: string
  model: string
  name: string
  /** 无 reasoning 元数据 = 空数组（UI 隐藏档位选择器）。 */
  efforts: Array<{ id: string; name: string }>
  /** 模型默认档位 id（无则空）。 */
  defaultEffort: string
}

/** 模型目录视图（edrv.ai.models 载荷）。 */
export interface AiDirectoryView {
  providers: Array<{ id: string; name: string; models: AiModelEntry[] }>
  /** 目录不可用原因（llm 服务缺失等；ok:false 时亦有 error，此为软降级说明）。 */
  note?: string
}

/** AI 补全配置视图（edrv.ai.configGet 载荷）。 */
export interface AiConfigView {
  enabled: boolean
  /** 空 = 自动选首个 provider/model。 */
  provider: string
  /** 空 = 自动选该 provider 首个模型。 */
  model: string
  /** 空 = 跟随模型默认（请求不携带 reasoningEffort）。 */
  effort: string
}

/** AI 补全配置更新载荷（edrv.ai.configUpdate）。 */
export interface AiConfigPatch {
  enabled?: boolean
  provider?: string
  model?: string
  /** 空 = 清除（跟随默认）。 */
  effort?: string
}

/**
 * 按 AI_PREFIX_MAX/AI_SUFFIX_MAX 裁剪前后缀（client 侧发请求前调用）。
 * @author ddj
 * @param prefix 光标前全文
 * @param suffix 光标后全文
 * @returns 裁剪后的窗口
 */
export function trimInlineWindow(prefix: string, suffix: string): { prefix: string; suffix: string } {
  const pre = typeof prefix === 'string' ? prefix : ''
  const suf = typeof suffix === 'string' ? suffix : ''
  return {
    prefix: pre.length > AI_PREFIX_MAX ? pre.slice(pre.length - AI_PREFIX_MAX) : pre,
    suffix: suf.length > AI_SUFFIX_MAX ? suf.slice(0, AI_SUFFIX_MAX) : suf,
  }
}

/**
 * 是否值得发起补全请求：前缀达标且非纯空白（空行/行首不请求）。
 * @author ddj
 * @param prefix 光标前文本
 * @returns 是否可请求
 */
export function inlineWorth(prefix: string): boolean {
  const pre = typeof prefix === 'string' ? prefix : ''
  if (pre.length < AI_MIN_PREFIX) return false
  // 只拦"整体无内容"（纯空白）；结尾空白（如 `local a = `）是最自然的补全触发
  // 形态，必须放行——原尾字符守卫把这类场景全数拦截（debug 实证 H4）
  return pre.trim().length > 0
}

/**
 * 拼装补全 user 消息文本：语言/文件名 + 前缀 + 补全点标记 + 后缀。
 * host 侧与单测共用，保证请求形状一致。
 * @author ddj
 * @param req 补全请求（已裁剪）
 * @returns 用户消息文本
 */
export function buildInlinePrompt(req: AiInlineRequest): string {
  const name = String(req.path || '').split(/[\\/]/).pop() || 'untitled'
  return [
    '文件：' + name,
    '现有代码（光标位于 <CURSOR> 标记处）：',
    req.prefix + '<CURSOR>' + req.suffix,
  ].join('\n')
}

/** 补全 system 提示词：硬约束输出形态（只给插入文本）。 */
export const AI_INLINE_SYSTEM =
  '你是代码自动补全引擎。只输出应插入 <CURSOR> 处的代码文本：' +
  '禁止任何解释、注释性语句、markdown 代码围栏或对原文的复述；' +
  '最多 ' + AI_MAX_LINES + ' 行，从光标处自然衔接前文，不要重复前缀已有内容；' +
  '无法给出高置信度补全时输出空文本。'

/**
 * 清理模型输出：剥 markdown 围栏、剥对 <CURSOR> 标记的复述、按行数截断、去首尾空行。
 * 产出空文本的判定也在这里（纯函数，单测覆盖）。
 * @author ddj
 * @param raw 模型原始输出
 * @param prefix 请求时的前缀（复述检测）
 * @returns 清理后的插入文本（可能为空串）
 */
export function cleanInlineText(raw: string, prefix: string): string {
  let text = typeof raw === 'string' ? raw : ''
  if (!text) return ''
  // markdown 围栏剥离（```lang … ``` 或 ```…```）
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text.trim())
  if (fenced) text = fenced[1] ?? ''
  // 模型复述了标记本身：取标记之后的部分
  const cursorAt = text.indexOf('<CURSOR>')
  if (cursorAt >= 0) text = text.slice(cursorAt + '<CURSOR>'.length)
  // 整体就是前缀结尾片段的复述：剥掉（防"从行首重抄一遍"类退化输出）
  const tailPrefix = prefix.length > 0 ? prefix.slice(-40) : ''
  if (tailPrefix && text.startsWith(tailPrefix)) text = text.slice(tailPrefix.length)
  // 行数截断 + 行尾空白清理
  const lines = text.split('\n').slice(0, AI_MAX_LINES).map((l) => l.replace(/\s+$/, ''))
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}
