/**
 * dsh-vscode-mode host — @deepseek-ai/dsh-llm 精简类型（AI 内联补全消费面）。
 * 以 profile 实装 0.1.3-alpha.2 d.ts 为准的最小子集；宿主环境经 external 解析，
 * 这里只声明本插件用到的形状（运行时值来自 ctx.get('llm')，无直接 import）。
 * 作者 ddj
 */

/** 文本块（模型可见）。 */
export interface TextBlock {
  type: 'text'
  text: string
}

/** 消息内容块（本插件只产 text）。 */
export type ContentBlock = TextBlock

/** 消息来源：手工构造一次性请求只产 user。 */
export type MessageSource = { kind: 'user' }

/** 流式模型调用的一条消息。 */
export interface LlmMessage {
  readonly id: string
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: ContentBlock[]
  readonly source: MessageSource
}

/** 生成请求（reasoningEffort 为模型元数据里的档位 id）。 */
export interface GenerateOptions {
  provider: string
  model: string
  reasoningEffort?: string
  messages: readonly LlmMessage[]
  system?: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
}

/** 流块：本插件消费 text-delta / finish（其余忽略）。 */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: unknown }
  | { type: 'usage'; usage: unknown }
  | { type: 'finish'; reason: { kind: string }; replayState?: unknown }

/** provider 展示元数据。 */
export interface LlmProviderInfo {
  id: string
  name: string
}

/** 模型条目（目录级，未解档位）。 */
export interface LlmModelInfo {
  provider: string
  id: string
  name: string
  description?: string
}

/** 可选思考档位表（模型元数据驱动）。 */
export interface LlmModelReasoningInfo {
  efforts: readonly { id: string; name: string }[]
  defaultEffort?: string
}

/** 精确模型元数据（含 reasoning）。 */
export interface LlmResolvedModelInfo extends LlmModelInfo {
  context?: { contextWindow: number }
  reasoning?: LlmModelReasoningInfo
}

/** llm 运行时（ctx.get('llm') 取得）的最小子集。 */
export interface LlmRuntimeLike {
  listProviders(): LlmProviderInfo[]
  listModels(provider: string): Promise<LlmModelInfo[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
