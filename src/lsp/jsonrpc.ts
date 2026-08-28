/**
 * dsh-vscode-mode host — LSP JSON-RPC 帧编解码（纯函数，node 可测）。
 * LSP over stdio 用 Content-Length 帧：
 *   Content-Length: <n>\r\n\r\n<恰好 n 字节 JSON>
 * 导出：encodeMessage（对象→帧 Buffer）、createFrameParser（流式粘包/拆包）、parseFrame（单帧）。
 * 作者 ddj 2026-08-27
 */

const HEADER_END = '\r\n\r\n'

/** 消息头正则（仅取 Content-Length；其它头忽略）。 */
const HEADER_RE = /^Content-Length:\s*(\d+)\s*$/im

/** 将对象编码为带 Content-Length 头的帧。 */
export function encodeMessage(message: unknown): Buffer {
  const body = JSON.stringify(message)
  const head = 'Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\r\n\r\n'
  return Buffer.from(head + body, 'utf8')
}

/**
 * 尝试从 buffer 解析单个帧；成功返回 { body, rest }，数据不足返回 null。
 * @author ddj 2026年08月27号
 * @param buffer 已累积的字节
 * @returns 解析结果（rest 为剩余未消费字节）
 */
export function parseFrame(buffer: Buffer): { body: string; rest: Buffer } | null {
  const headEnd = buffer.indexOf(HEADER_END)
  if (headEnd < 0) return null
  const header = buffer.subarray(0, headEnd).toString('utf8')
  const m = HEADER_RE.exec(header)
  if (!m) {
    // 非法头：丢弃直到下一个帧头，避免死循环
    const next = buffer.indexOf('Content-Length:')
    return next >= 0 ? parseFrame(buffer.subarray(next)) : null
  }
  const length = Number(m[1])
  const bodyStart = headEnd + HEADER_END.length
  if (buffer.length < bodyStart + length) return null
  const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
  return { body, rest: buffer.subarray(bodyStart + length) }
}

/** 帧解析器：push 数据块，吐出完整消息（可能拆包后重组、也可能一包多帧）。 */
export function createFrameParser(): {
  push(chunk: Buffer): unknown[]
  clear(): void
} {
  let buffer: Buffer = Buffer.alloc(0)
  return {
    push(chunk: Buffer): unknown[] {
      if (chunk.length) buffer = Buffer.concat([buffer, chunk]) as Buffer
      const out: unknown[] = []
      for (;;) {
        const parsed = parseFrame(buffer)
        if (!parsed) break
        buffer = parsed.rest
        try {
          out.push(JSON.parse(parsed.body))
        } catch (error) {
          out.push({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: ' + String(error) }, id: null })
        }
      }
      return out
    },
    clear(): void {
      buffer = Buffer.alloc(0)
    },
  }
}

/** 构造标准 JSON-RPC 请求消息。 */
export function requestMessage(id: number, method: string, params: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, params }
}

/** 构造标准 JSON-RPC 通知消息（无 id，fire-and-forget）。 */
export function notifyMessage(method: string, params: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', method, params }
}

/** 构造标准 JSON-RPC 响应消息。 */
export function responseMessage(id: number | string | null, result: unknown, error?: unknown): Record<string, unknown> {
  if (error !== undefined) return { jsonrpc: '2.0', id, error }
  return { jsonrpc: '2.0', id, result }
}
