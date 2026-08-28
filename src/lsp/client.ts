/**
 * dsh-vscode-mode host — LSP 客户端（JSON-RPC over stdio）。
 * 职责：请求/通知/握手/超时/服务器端请求处理/生命周期。transport 无关性：
 * 只依赖 write/onMessage 契约，便于单测时注入假传输。
 * 作者 ddj 2026-08-27
 */
import { createFrameParser, encodeMessage, requestMessage, notifyMessage } from './jsonrpc.js'
import type { LspServerCapabilities } from '../shared/lsp.js'

export interface LspClientEvents {
  onReady?: (capabilities: LspServerCapabilities) => void
  onExit?: (code: number | null, signal: string | null) => void
  onLog?: (line: string) => void
}

const DEFAULT_TIMEOUT_MS = 20_000

export class LspError extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

export interface LspClientTransport {
  write(chunk: Buffer): boolean
  dispose(): void
  readonly alive: boolean
  onMessage: ((message: unknown) => void) | null
  onExit: ((code: number | null, signal: string | null) => void) | null
}

export interface LspClient {
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>
  notify(method: string, params: unknown): void
  initialize(rootUri: string, workspaceFolders: string[]): Promise<LspServerCapabilities>
  shutdown(): Promise<void>
  readonly alive: boolean
}

/**
 * 创建 LSP 客户端。
 * @author ddj 2026年08月27号
 * @param transport 传输句柄（write/onMessage/alive/dispose）
 * @param events 事件回调
 * @returns LSP 客户端
 */
export function createLspClient(
  transport: LspClientTransport,
  events: LspClientEvents = {},
): LspClient {
  let nextId = 1
  let alive = transport.alive
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let serverCapabilities: LspServerCapabilities = { definition: false, references: false, documentSymbol: false, workspaceSymbol: false, hover: false }

  const log = (line: string): void => events.onLog?.(line)
  const parser = createFrameParser()

  transport.onMessage = (message: unknown): void => {
    const msg = message as { id?: unknown; method?: unknown; result?: unknown; error?: unknown }
    // 服务器端请求/通知带 method（请求还带 id）；响应带 id + result/error、无 method。先判 method 再判 id。
    if (typeof msg.method === 'string') {
      void handleServerRequest(msg as { method: string; params?: unknown; id?: unknown })
      return
    }
    if (typeof msg.id === 'number' || typeof msg.id === 'string') {
      const entry = pending.get(Number(msg.id))
      if (!entry) return
      pending.delete(Number(msg.id))
      clearTimeout(entry.timer)
      if (msg.error) {
        const err = msg.error as { code?: number; message?: string }
        entry.reject(new LspError(err.code ?? -32000, err.message ?? 'LSP error'))
      } else {
        entry.resolve(msg.result)
      }
    }
  }

  /** 服务器端请求：消息/日志类打日志，配置/能力类回 result:null，其余回 method not found。 */
  const handleServerRequest = async (msg: { method: string; params?: unknown; id?: unknown }): Promise<void> => {
    const { method, params, id } = msg
    const respond = (payload: Record<string, unknown>): void => {
      transport.write(encodeMessage(payload))
    }
    try {
      if (method === 'window/logMessage' || method === 'window/showMessage' || method === 'window/showMessageRequest') {
        const p = params as { type?: number; message?: string }
        log('[server ' + (p?.type ?? '') + '] ' + String(p?.message ?? ''))
        if (id !== undefined) respond({ jsonrpc: '2.0', id, result: null })
        return
      }
      if (method === 'workspace/configuration') {
        const p = params as { items?: unknown[] }
        const items = Array.isArray(p?.items) ? p.items.map(() => null) : []
        if (id !== undefined) respond({ jsonrpc: '2.0', id, result: items })
        return
      }
      // 客户端能力协商类：标准行为是确认（result:null），否则部分服务器（如 LuaLS）会中断工作区初始化
      if (method === 'window/workDoneProgress/create' || method === 'client/registerCapability' || method === 'workspace/workspaceFolders') {
        if (id !== undefined) respond({ jsonrpc: '2.0', id, result: null })
        return
      }
      if (id !== undefined) {
        respond({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } })
      }
    } catch (error) {
      log('server request handler error: ' + String(error))
      if (id !== undefined) {
        respond({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error) } })
      }
    }
  }

  const transportExit = transport.onExit
  transport.onExit = (code, signal): void => {
    alive = false
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('LSP 服务器已退出（' + String(code) + '/' + String(signal) + '）'))
    }
    pending.clear()
    events.onExit?.(code, signal)
    transportExit?.(code, signal)
  }

  const client: LspClient = {
    async request<T>(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
      if (!alive) throw new Error('LSP 服务器未运行')
      const id = nextId++
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error('LSP 请求超时：' + method + '（' + timeoutMs + 'ms）'))
        }, timeoutMs)
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
        transport.write(encodeMessage(requestMessage(id, method, params)))
      })
    },
    notify(method: string, params: unknown): void {
      if (!alive) return
      transport.write(encodeMessage(notifyMessage(method, params)))
    },
    async initialize(rootUri: string, workspaceFolders: string[]): Promise<LspServerCapabilities> {
      const init = await client.request<{
        capabilities?: {
          definitionProvider?: unknown
          referencesProvider?: unknown
          documentSymbolProvider?: unknown
          workspaceSymbolProvider?: unknown
          hoverProvider?: unknown
        }
      }>('initialize', {
        processId: process.pid,
        rootUri: rootUri || null,
        rootPath: null,
        workspaceFolders: workspaceFolders.length
          ? workspaceFolders.map((uri) => ({ uri, name: uri }))
          : null,
        capabilities: {
          workspace: { configuration: true },
          textDocument: {
            synchronization: { dynamicRegistration: false, willSave: false, didSave: true },
            definition: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            documentSymbol: { dynamicRegistration: false },
            hover: { dynamicRegistration: false },
          },
        },
      })
      const caps = init?.capabilities ?? {}
      serverCapabilities = {
        definition: Boolean(caps.definitionProvider),
        references: Boolean(caps.referencesProvider),
        documentSymbol: Boolean(caps.documentSymbolProvider),
        workspaceSymbol: Boolean(caps.workspaceSymbolProvider),
        hover: Boolean(caps.hoverProvider),
      }
      client.notify('initialized', {})
      events.onReady?.(serverCapabilities)
      return serverCapabilities
    },
    async shutdown(): Promise<void> {
      try {
        await client.request<unknown>('shutdown', null, 3000)
      } catch (error) {
        log('shutdown: ' + String(error))
      }
      try {
        client.notify('exit', null)
      } catch (error) {
        log('exit: ' + String(error))
      }
    },
    get alive() {
      return alive
    },
  }
  return client
}
