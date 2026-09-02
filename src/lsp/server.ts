/**
 * dsh-vscode-mode host — 单语言服务器会话（绑定 工作区根 + 语言）。
 * 负责：启动传输 + LSP 客户端握手、文档同步（didOpen/didChange/didSave/didClose）、
 * 请求封装（definition/references/documentSymbol/workspaceSymbol/hover）、状态上报。
 * 作者 ddj 2026-08-27
 */
import { spawnServer, type Transport } from './transport.js'
import { createLspClient, type LspClient } from './client.js'
import { pathToFileUri } from './uri.js'
import type { LspProviderSpec } from './providers.js'
import { LSP_SEMANTIC_TOKEN_MODIFIERS, LSP_SEMANTIC_TOKEN_TYPES } from '../shared/lsp.js'
import type {
  LspLocation,
  LspSemanticTokens,
  LspServerCapabilities,
  LspServerPhase,
  LspServerStatus,
  LspSymbol,
} from '../shared/lsp.js'

export interface LspServer {
  readonly languageId: string
  readonly root: string
  readonly phase: LspServerPhase
  readonly capabilities: LspServerCapabilities
  onStateChange: ((status: LspServerStatus) => void) | null
  status(): LspServerStatus
  start(): Promise<boolean>
  sync(path: string, text: string, version: number): void
  close(path: string): void
  definition(path: string, line: number, character: number): Promise<LspLocation[]>
  references(path: string, line: number, character: number, includeDeclaration: boolean): Promise<LspLocation[]>
  documentSymbol(path: string): Promise<LspSymbol[]>
  workspaceSymbol(query: string): Promise<LspSymbol[]>
  hover(path: string, line: number, character: number): Promise<{ contents: string[] } | null>
  semanticTokens(path: string): Promise<LspSemanticTokens | null>
  dispose(): Promise<void>
}

/** 文档注册表：path(工作区相对) → { version, text, uri }。 */
interface OpenDoc {
  path: string
  uri: string
  version: number
  text: string
}

const RESTARTABLE = true

/**
 * 创建语言服务器会话。
 * @author ddj 2026年08月27号
 * @param spec provider 规格（argv/cwd）
 * @param root 工作区根（绝对路径）
 * @param languageId 语言 id
 * @param logger 诊断日志
 * @returns 会话句柄
 */
export function createLspServer(spec: LspProviderSpec, root: string, languageId: string, logger?: (line: string) => void): LspServer {
  const rootUri = pathToFileUri(root)
  const docs = new Map<string, OpenDoc>()
  let phase: LspServerPhase = 'idle'
  let transport: Transport | null = null
  let client: LspClient | null = null
  let capabilities: LspServerCapabilities = {
    definition: false,
    references: false,
    documentSymbol: false,
    workspaceSymbol: false,
    hover: false,
    semanticTokens: false,
    semanticTokenTypes: [...LSP_SEMANTIC_TOKEN_TYPES],
    semanticTokenModifiers: [...LSP_SEMANTIC_TOKEN_MODIFIERS],
  }
  let disposed = false
  let readyWait: Promise<boolean> = Promise.resolve(false)
  let resolveReady: ((ready: boolean) => void) | null = null
  let lastProgress: { value?: number; message?: string } = {}
  let lastStatus: LspServerStatus = {
    languageId,
    source: spec.kind,
    phase: 'idle',
    reason: spec.ready ? undefined : spec.reason,
    root,
    version: spec.version,
    providerName: spec.providerName ?? (spec.version ? '语言服务器扩展' : undefined),
  }

  const log = (line: string): void => logger?.('[' + languageId + '@' + root + '] ' + line)
  const providerInfo = {
    version: spec.version,
    providerName: spec.providerName ?? (spec.version ? 'EmmyLua' : undefined),
  }

  const setPhase = (next: LspServerPhase, reason?: string): void => {
    phase = next
    lastStatus = { languageId, source: spec.kind, phase: next, reason, root, ...providerInfo, ...progressFields() }
    server.onStateChange?.(lastStatus)
  }

  /** 返回当前进度字段，避免空进度污染状态载荷。 */
  const progressFields = (): Pick<LspServerStatus, 'progress' | 'progressMessage'> => ({
    progress: lastProgress.value,
    progressMessage: lastProgress.message,
  })

  /** 处理 LSP $/progress 通知并映射为编辑器状态。 */
  const applyProgress = (params: unknown): void => {
    const value = params as { value?: unknown }
    const report = value?.value as { kind?: unknown; percentage?: unknown; message?: unknown } | undefined
    if (report?.kind === 'begin') {
      lastProgress = { value: 0, message: typeof report.message === 'string' ? report.message : '正在解析工作区' }
      if (phase === 'ready') phase = 'indexing'
    } else if (report?.kind === 'end') {
      lastProgress = { value: 100, message: typeof report.message === 'string' ? report.message : '解析完成' }
      if (phase === 'indexing') phase = 'ready'
    } else if (typeof report?.percentage === 'number') {
      lastProgress = { value: Math.max(0, Math.min(100, report.percentage)), message: typeof report.message === 'string' ? report.message : lastProgress.message }
      if (phase === 'ready') phase = 'indexing'
    } else if (typeof report?.message === 'string') {
      lastProgress = { ...lastProgress, message: report.message }
    }
    lastStatus = { ...lastStatus, phase, ...progressFields() }
    server.onStateChange?.(lastStatus)
  }

  const ensureClient = (): LspClient => {
    if (!client) throw new Error('LSP 服务器未启动')
    return client
  }

  const server: LspServer = {
    languageId,
    root,
    get phase() {
      return phase
    },
    get capabilities() {
      return capabilities
    },
    status(): LspServerStatus {
      return lastStatus
    },
    onStateChange: null,

    async start(): Promise<boolean> {
      if (disposed) return false
      if (phase === 'starting') return readyWait
      if (phase === 'ready' || phase === 'indexing') return true
      readyWait = new Promise((resolve) => { resolveReady = resolve })
      lastProgress = {}
      setPhase('starting')
      try {
        transport = spawnServer(
          { argv: spec.argv, cwd: spec.cwd ?? root },
          (message) => { /* 由 client 接管 */ },
          (line) => log('stderr: ' + line),
        )
        client = createLspClient(transport, {
          onReady: (caps) => {
            capabilities = caps
            // 重放已打开文档（崩溃重启后恢复服务器侧状态）
            for (const doc of docs.values()) {
              client?.notify('textDocument/didOpen', {
                textDocument: { uri: doc.uri, languageId, version: doc.version, text: doc.text },
              })
            }
            setPhase('ready')
            resolveReady?.(true)
            resolveReady = null
            log('ready: definition=' + caps.definition + ' references=' + caps.references + ' symbols=' + caps.documentSymbol)
          },
          onProgress: (params) => applyProgress(params),
          onExit: (code, signal) => {
            if (disposed) return
            resolveReady?.(false)
            resolveReady = null
            log('server exited (' + String(code) + '/' + String(signal) + ')')
            client = null
            transport = null
            if (RESTARTABLE) setPhase('idle', '服务器已退出（' + String(code) + '/' + String(signal) + '），等待重启')
            else setPhase('stopped', '服务器已退出')
          },
          onLog: (line) => log('lsp: ' + line),
        })
        // 让 client 接管 stdout 消息
        const caps = await client.initialize(rootUri, [rootUri])
        capabilities = caps
        return true
      } catch (error) {
        log('start failed: ' + String(error))
        setPhase('unavailable', '启动失败：' + String(error))
        resolveReady?.(false)
        resolveReady = null
        try { await server.dispose() } catch { /* 忽略 */ }
        return false
      }
    },

    sync(path: string, text: string, version: number): void {
      const existing = docs.get(path)
      const uri = existing?.uri ?? pathToFileUri(root + '/' + path.split('/').join('/'))
      if (existing) {
        existing.version = version
        existing.text = text
        if (phase === 'ready' || phase === 'indexing') {
          client?.notify('textDocument/didChange', {
            textDocument: { uri, version },
            contentChanges: [{ text }],
          })
        }
        return
      }
      docs.set(path, { path, uri, version, text })
      if (phase === 'ready' || phase === 'indexing') {
        client?.notify('textDocument/didOpen', {
          textDocument: { uri, languageId, version, text },
        })
      }
    },

    close(path: string): void {
      const doc = docs.get(path)
      if (!doc) return
      docs.delete(path)
      if (phase === 'ready' || phase === 'indexing') {
        client?.notify('textDocument/didClose', { textDocument: { uri: doc.uri } })
      }
    },

    async definition(path: string, line: number, character: number): Promise<LspLocation[]> {
      const doc = docs.get(path)
      if (!doc || !(await readyWait)) return []
      const result = await ensureClient().request<unknown>(
        'textDocument/definition',
        { textDocument: { uri: doc.uri }, position: { line, character } },
      )
      return normalizeLocations(result)
    },

    async references(path: string, line: number, character: number, includeDeclaration: boolean): Promise<LspLocation[]> {
      const doc = docs.get(path)
      if (!doc || !(await readyWait)) return []
      const result = await ensureClient().request<unknown>(
        'textDocument/references',
        {
          textDocument: { uri: doc.uri },
          position: { line, character },
          context: { includeDeclaration },
        },
      )
      return normalizeLocations(result)
    },

    async documentSymbol(path: string): Promise<LspSymbol[]> {
      const doc = docs.get(path)
      if (!doc || !(await readyWait)) return []
      const result = await ensureClient().request<unknown>('textDocument/documentSymbol', { textDocument: { uri: doc.uri } })
      if (!Array.isArray(result)) return []
      return (result as unknown[]).map(normalizeSymbol).filter((s): s is LspSymbol => s !== null)
    },

    async workspaceSymbol(query: string): Promise<LspSymbol[]> {
      if (!(await readyWait)) return []
      const result = await ensureClient().request<unknown>('workspace/symbol', { query })
      if (!Array.isArray(result)) return []
      return (result as unknown[]).map(normalizeSymbol).filter((s): s is LspSymbol => s !== null)
    },

    async hover(path: string, line: number, character: number): Promise<{ contents: string[] } | null> {
      const doc = docs.get(path)
      if (!doc || !(await readyWait)) return null
      const result = await ensureClient().request<{ contents?: unknown; range?: unknown } | null>(
        'textDocument/hover',
        { textDocument: { uri: doc.uri }, position: { line, character } },
      )
      if (!result || !result.contents) return null
      return { contents: stringifyHoverContents(result.contents) }
    },

    /** 查询全文 semantic tokens，并将服务器 legend 归一到插件固定 legend。 */
    async semanticTokens(path: string): Promise<LspSemanticTokens | null> {
      const doc = docs.get(path)
      if (!doc || !(await readyWait) || !capabilities.semanticTokens) return null
      const result = await ensureClient().request<{ data?: unknown; resultId?: unknown } | null>(
        'textDocument/semanticTokens/full',
        { textDocument: { uri: doc.uri } },
      )
      if (!result || !Array.isArray(result.data)) return null
      return {
        data: normalizeSemanticData(
          result.data,
          capabilities.semanticTokenTypes ?? [],
          capabilities.semanticTokenModifiers ?? [],
        ),
        resultId: typeof result.resultId === 'string' ? result.resultId : undefined,
      }
    },

    async dispose(): Promise<void> {
      disposed = true
      resolveReady?.(false)
      resolveReady = null
      if (client) {
        await client.shutdown().catch(() => {})
        client = null
      }
      if (transport) {
        transport.dispose()
        transport = null
      }
      setPhase('stopped')
    },
  }
  return server
}

/** 归一化 definition/references 结果（Location | Location[] | LocationLink[]）。 */
function normalizeLocations(result: unknown): LspLocation[] {
  if (!Array.isArray(result)) return []
  const out: LspLocation[] = []
  for (const item of result) {
    if (!item || typeof item !== 'object') continue
    const obj = item as { uri?: unknown; range?: unknown; targetUri?: unknown; targetRange?: unknown; targetSelectionRange?: unknown }
    const uri = typeof obj.targetUri === 'string' ? obj.targetUri : typeof obj.uri === 'string' ? obj.uri : ''
    const range = (obj.targetRange ?? obj.range) as { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } } | undefined
    if (!uri || !range || !range.start || !range.end) continue
    out.push({
      uri,
      range: {
        start: { line: toInt(range.start.line), character: toInt(range.start.character) },
        end: { line: toInt(range.end.line), character: toInt(range.end.character) },
      },
    })
  }
  return out
}

/** 归一化 documentSymbol/workspaceSymbol 结果（DocumentSymbol | SymbolInformation）。 */
function normalizeSymbol(item: unknown): LspSymbol | null {
  if (!item || typeof item !== 'object') return null
  const obj = item as {
    name?: unknown
    kind?: unknown
    detail?: unknown
    containerName?: unknown
    range?: { start?: unknown; end?: unknown }
    selectionRange?: { start?: unknown; end?: unknown }
    children?: unknown
    location?: { uri?: unknown; range?: unknown }
  }
  if (typeof obj.name !== 'string') return null
  const selection = obj.selectionRange ?? (obj.location && (obj.location as { range?: unknown }).range)
  const range = obj.range ?? selection
  if (!range || typeof range !== 'object') return null
  const r = range as { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } }
  if (!r.start || !r.end) return null
  const symbol: LspSymbol = {
    name: obj.name,
    kind: toInt(obj.kind),
    range: { start: { line: toInt((r.start as { line?: unknown }).line), character: toInt((r.start as { character?: unknown }).character) }, end: { line: toInt((r.end as { line?: unknown }).line), character: toInt((r.end as { character?: unknown }).character) } },
    selectionRange: selection
      ? { start: { line: toInt(((selection as { start?: { line?: unknown } }).start as { line?: unknown } | undefined)?.line ?? toInt((r.start as { line?: unknown }).line)), character: toInt(((selection as { start?: { character?: unknown } }).start as { character?: unknown } | undefined)?.character ?? toInt((r.start as { character?: unknown }).character)) }, end: { line: toInt(((selection as { end?: { line?: unknown } }).end as { line?: unknown } | undefined)?.line ?? toInt((r.end as { line?: unknown }).line)), character: toInt(((selection as { end?: { character?: unknown } }).end as { character?: unknown } | undefined)?.character ?? toInt((r.end as { character?: unknown }).character)) } }
      : { start: { line: toInt((r.start as { line?: unknown }).line), character: toInt((r.start as { character?: unknown }).character) }, end: { line: toInt((r.end as { line?: unknown }).line), character: toInt((r.end as { character?: unknown }).character) } },
  }
  if (typeof obj.detail === 'string' && obj.detail) symbol.detail = obj.detail
  if (typeof obj.containerName === 'string' && obj.containerName) symbol.containerName = obj.containerName
  if (Array.isArray(obj.children)) {
    const kids = obj.children.map(normalizeSymbol).filter((s): s is LspSymbol => s !== null)
    if (kids.length) symbol.children = kids
  }
  return symbol
}

/** hover contents → 文本行（MarkupContent | MarkedString | MarkedString[]）。 */
function stringifyHoverContents(contents: unknown): string[] {
  if (typeof contents === 'string') return [contents]
  if (Array.isArray(contents)) return contents.map(stringifyHoverContents).flat().filter(Boolean)
  if (contents && typeof contents === 'object') {
    const value = (contents as { value?: unknown }).value
    if (typeof value === 'string') return [value]
  }
  return []
}

function toInt(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
}

/** 把服务器 legend 下的 5 元组流转换为插件固定 legend 下的 5 元组流。 */
function normalizeSemanticData(data: unknown[], types: string[], modifiers: string[]): number[] {
  const out: number[] = []
  let previousLine = 0
  let previousCharacter = 0
  let outputLine = 0
  let outputCharacter = 0
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = toInt(data[i])
    const deltaCharacter = toInt(data[i + 1])
    const length = toInt(data[i + 2])
    const sourceType = types[toInt(data[i + 3])] ?? 'variable'
    const sourceModifiers = toInt(data[i + 4])
    const line = previousLine + deltaLine
    const character = deltaLine === 0 ? previousCharacter + deltaCharacter : deltaCharacter
    const typeIndex = Math.max(0, LSP_SEMANTIC_TOKEN_TYPES.indexOf(sourceType as never))
    let modifierBits = 0
    for (let bit = 0; bit < modifiers.length; bit++) {
      if ((sourceModifiers & (1 << bit)) === 0) continue
      const modifier = modifiers[bit]
      const targetBit = LSP_SEMANTIC_TOKEN_MODIFIERS.indexOf(modifier as never)
      if (targetBit >= 0) modifierBits |= 1 << targetBit
    }
    const outputDeltaLine = line - outputLine
    const outputDeltaCharacter = outputDeltaLine === 0 ? character - outputCharacter : character
    out.push(outputDeltaLine, outputDeltaCharacter, length, typeIndex, modifierBits)
    previousLine = line
    previousCharacter = character
    outputLine = line
    outputCharacter = character
  }
  return out
}
