/**
 * dsh-vscode-mode host — DAP（Debug Adapter Protocol）消息纯类型与守卫。
 * 帧格式与 LSP 相同（Content-Length 头），编解码直接复用 lsp/jsonrpc.ts。
 * 消息形状只覆盖本插件消费的子集（DAP 3.x 常用面 + emmylua 适配器扩展）。
 * 作者 ddj 2026年09月29号 / 2026年09月21号
 */
/** DAP 消息基型（请求/响应/事件的公共头）。 */
export interface DapMessage {
  seq?: number
  type: 'request' | 'response' | 'event'
}

/** DAP 响应（按 request_seq 关联）。 */
export interface DapResponse extends DapMessage {
  type: 'response'
  request_seq: number
  success: boolean
  command: string
  message?: string
  body?: unknown
}

/** DAP 事件。 */
export interface DapEvent extends DapMessage {
  type: 'event'
  event: string
  body?: unknown
}

/** DAP 请求（客户端 → 适配器）。 */
export interface DapRequest extends DapMessage {
  type: 'request'
  command: string
  arguments?: unknown
}

/** 客户端 → 适配器请求帧构造。 */
export function dapRequest(seq: number, command: string, args?: unknown): DapRequest {
  return args === undefined
    ? { seq, type: 'request', command }
    : { seq, type: 'request', command, arguments: args }
}

/** 响应守卫。 */
export function isDapResponse(msg: DapMessage): msg is DapResponse {
  return msg.type === 'response' && typeof (msg as Partial<DapResponse>).request_seq === 'number'
}

/** 事件守卫。 */
export function isDapEvent(msg: DapMessage): msg is DapEvent {
  return msg.type === 'event' && typeof (msg as Partial<DapEvent>).event === 'string'
}

/** 事件体安全取值。 */
export function eventBody(event: DapEvent): Record<string, unknown> {
  return event.body && typeof event.body === 'object' ? event.body as Record<string, unknown> : {}
}

/** 响应体安全取值。 */
export function responseBody(response: DapResponse): Record<string, unknown> {
  return response.body && typeof response.body === 'object' ? response.body as Record<string, unknown> : {}
}

/**
 * initialize 请求参数（适配器协商口径：path 格式、行列 1 基）。
 * @author ddj 2026年09月29号
 * @param adapterId 适配器 id
 */
export function initializeArgs(adapterId: string): Record<string, unknown> {
  return {
    adapterID: adapterId,
    locale: 'zh-cn',
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: 'path',
    supportsVariableType: true,
    supportsVariablePaging: false,
    supportsRunInTerminalRequest: false,
  }
}
