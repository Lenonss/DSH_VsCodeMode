/**
 * dsh-vscode-mode host — 单语言服务器会话（绑定 工作区根 + 语言）。
 * 负责：启动传输 + LSP 客户端握手、文档同步（didOpen/didChange/didSave/didClose）、
 * 请求封装（definition/references/documentSymbol/workspaceSymbol/hover）、状态上报。
 * 作者 ddj 2026-08-27
 */
import { spawnServer, type Transport } from './transport.js'
import { createLspClient, type LspClient } from './client.js'
import { pathToFileUri, toWorkspacePath, isAbsolutePath, fileUriToPath } from './uri.js'
import { deriveDefinitionFromLocations, deriveCrossFileDeclaration, isMisresolvedSameFileUsage } from './derive.js'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { LspProviderSpec } from './providers.js'
import { LSP_SEMANTIC_TOKEN_MODIFIERS, LSP_SEMANTIC_TOKEN_TYPES } from '../shared/lsp.js'
import type {
  LspCompletionItem,
  LspCompletionList,
  LspCompletionTextEdit,
  LspLocation,
  LspParameterInformation,
  LspPosition,
  LspRange,
  LspSemanticTokens,
  LspServerCapabilities,
  LspServerPhase,
  LspServerStatus,
  LspSignatureHelp,
  LspSignatureInformation,
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
  completion(path: string, line: number, character: number, context?: unknown): Promise<LspCompletionList | null>
  resolveCompletion(path: string, item: LspCompletionItem): Promise<LspCompletionItem | null>
  signatureHelp(path: string, line: number, character: number): Promise<LspSignatureHelp | null>
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
const MAX_DOC_VERSION = 2147483647

/**
 * 找工作区根目录下的第一个 .sln（字典序）。
 *
 * 背景：Roslyn LSP 启动后若收不到 solution/project 通知，会停留在「杂项文件」模式——
 * 工作区内自有符号可解析，但 Unity 引擎程序集 / NuGet 包等元数据符号的
 * definition/hover 一律返回空（实测 2026-10-16，GameObject.Find 全空）。
 * 需在握手后发 Roslyn 专有 `solution/open` 通知加载项目上下文。
 * @author ddj 2026年10月19号
 * @param root 工作区根（绝对路径）
 * @returns sln 绝对路径；根目录无 sln 返回 null
 */
async function findSolutionFile(root: string): Promise<string | null> {
  try {
    const names = (await readdir(root)).filter((name) => name.toLowerCase().endsWith('.sln')).sort()
    return names[0] ? join(root, names[0]) : null
  } catch {
    return null
  }
}

/**
 * 使用合法、递增的 Int32 文档版本；旧客户端的毫秒时间戳不能直发给 Roslyn。
 * @author ddj 2026年09月24号
 * @param incoming 客户端传来的版本
 * @param previous 当前服务器记录的版本
 * @returns 可发送给语言服务器的版本
 */
export function lspDocVersion(incoming: number, previous?: number): number {
  const next = Math.min(MAX_DOC_VERSION, (previous ?? 0) + 1)
  return Number.isInteger(incoming) && incoming >= next && incoming <= MAX_DOC_VERSION ? incoming : next
}

/**
 * 把查询位置挪到光标所在 Lua 标识符词的末尾字符。
 *
 * 背景：EmmyLua 0.9.41 存在词边界怪癖——查询位置落在标识符 token 前半时，definition/hover/references
 * 一律返回空 / "unknown" / []，落在 token 后半/末尾才正常解析（已对 EventId/ISTaskSystem/
 * TaskStateChange 逐字符实测确认）。把位置挪到词尾即可让基标识符（如 `EventId`）正常解析。
 * 仅当位置严格落在标识符词内时才挪；点号/空白/字符串/注释位置原样返回，不影响正常符号。
 * @author ddj 2026年10月15号
 * @param text 文档全文
 * @param pos 查询位置（0-based）
 * @returns 词末字符位置；不在词内则原样返回
 */
export function nudgeToWordEnd(text: string, pos: LspPosition): LspPosition {
  const lines = text.split(/\r\n|\r|\n/)
  const line = lines[pos.line]
  if (line === undefined) return pos
  const identifier = /[A-Za-z_][A-Za-z0-9_]*/g
  let match: RegExpExecArray | null
  while ((match = identifier.exec(line)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (pos.character >= start && pos.character < end) {
      return { line: pos.line, character: end - 1 }
    }
    if (pos.character < start) break
  }
  return pos
}

/** hover 内容是否"空/unknown"（EmmyLua 对未解析符号、成员链字段 hover 的原生输出）。 */
function isEmptyHover(contents: string[]): boolean {
  return contents.every((c) => {
    const t = c.trim()
    return !t || t === 'unknown'
  })
}

/**
 * 取光标所在成员链的基标识符范围（`EventId.ISTaskSystem.TaskStateChange` → `EventId`）。
 * 链中无成员访问（无 '.'）时返回 null——基标识符回查无意义。
 */
function chainBaseRange(line: string, character: number): { start: number; end: number } | null {
  const chain = /[A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*/g
  let match: RegExpExecArray | null
  while ((match = chain.exec(line)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (character >= start && character < end) {
      const dot = match[0].indexOf('.')
      if (dot === -1) return null
      return { start, end: start + dot }
    }
    if (character < start) break
  }
  return null
}

/** LSP position 是否落在 range 内（start 包含、end 排除）。 */
function rangeContains(pos: LspPosition, range: LspRange): boolean {
  const start = range.start
  const end = range.end ?? start
  if (pos.line < start.line || pos.line > end.line) return false
  if (pos.line === start.line && pos.character < start.character) return false
  if (pos.line === end.line && pos.character >= end.character) return false
  return true
}

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

  /**
   * 文档键 → file:// URI（防御性第二道：绝不把绝对路径拼成畸形 URI）。
   *
   * 正常路径下 rpc 入口已归一为工作区相对，此处走 `root + '/' + path`；
   * 但若将来有调用方绕过入口直接传绝对路径，旧写法会拼出 `<root>/<root>/Assets/...`
   * 这种不存在的文档，didOpen 静默落空 → 引用/定义全空且无报错。这里显式兜底。
   * @author ddj 2026年09月11号
   * @param path 工作区相对路径（或绝对路径）
   * @returns file:// URI
   */
  const docUriOf = (path: string): string => {
    const rel = toWorkspacePath(root, path)
    return isAbsolutePath(rel) ? pathToFileUri(rel) : pathToFileUri(root + '/' + rel.split('/').join('/'))
  }

  /**
   * 按 file:// URI 读取文件文本：已打开文档走内存（与语言服务器索引一致），其余读盘。
   * @author ddj 2026年10月15号
   * @param uri 目标文件 file:// URI
   * @returns 文件文本；读取失败（文件不存在/非 UTF-8 等）返回 null
   */
  const readTextByUri = async (uri: string): Promise<string | null> => {
    for (const doc of docs.values()) {
      if (doc.uri === uri) return doc.text
    }
    try {
      return await readFile(fileUriToPath(uri), 'utf8')
    } catch {
      return null
    }
  }
  let phase: LspServerPhase = 'idle'
  let transport: Transport | null = null
  let client: LspClient | null = null
  let capabilities: LspServerCapabilities = {
    definition: false,
    declaration: false,
    references: false,
    documentSymbol: false,
    workspaceSymbol: false,
    hover: false,
    semanticTokens: false,
    completion: false,
    completionResolve: false,
    signatureHelp: false,
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
          { argv: spec.argv, cwd: spec.cwd ?? root, env: spec.env },
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
        // DotRush 服务器阻塞等待带 dotrush 段的配置通知才继续初始化（加载工作区），
        // 不发则所有文档类查询返回空；官方 VSCode 扩展经 configurationSection 自动发送。
        // 按 csharp 语言统一发送：手动配置的 DotRush 与其它 C# 服务器（OmniSharp 等）
        // 对不认识的配置段按协议忽略，均安全
        if (languageId === 'csharp') {
          client.notify('workspace/didChangeConfiguration', { settings: { dotrush: { roslyn: {} } } })
          // Roslyn 专有：加载解决方案后元数据符号（引擎/NuGet 程序集）才可跳转；
          // 未知通知对其它 C# 服务器按协议安全忽略。无 sln 的纯脚本项目静默跳过。
          const slnPath = await findSolutionFile(root)
          if (slnPath) client.notify('solution/open', { solution: pathToFileUri(slnPath) })
        }
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
      const uri = existing?.uri ?? docUriOf(path)
      const safeVersion = lspDocVersion(version, existing?.version)
      if (existing) {
        existing.version = safeVersion
        existing.text = text
        if (phase === 'ready' || phase === 'indexing') {
          client?.notify('textDocument/didChange', {
            textDocument: { uri, version: safeVersion },
            contentChanges: [{ text }],
          })
        }
        return
      }
      docs.set(path, { path, uri, version: safeVersion, text })
      if (phase === 'ready' || phase === 'indexing') {
        client?.notify('textDocument/didOpen', {
          textDocument: { uri, languageId, version: safeVersion, text },
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
      const client = ensureClient()
      // EmmyLua 词边界怪癖：位置在标识符前半返回空，nudge 到词尾后基标识符可正常解析
      const position = nudgeToWordEnd(doc.text, { line, character })
      // 跨文件声明推导（references + 词级校验），两处复用
      const crossFromRefs = async (): Promise<LspLocation | null> => {
        try {
          const refs = normalizeLocations(
            await client.request<unknown>(
              'textDocument/references',
              {
                textDocument: { uri: doc.uri },
                position,
                context: { includeDeclaration: true },
              },
            ),
          )
          return await deriveCrossFileDeclaration(position, refs, doc.text, doc.uri, { readText: readTextByUri })
        } catch (error) {
          log('references fallback failed: ' + String(error))
          return null
        }
      }
      // ① 标准定义（方法/跨文件命名空间等）
      const direct = normalizeLocations(
        await client.request<unknown>(
          'textDocument/definition',
          { textDocument: { uri: doc.uri }, position },
        ),
      )
      if (direct.length) {
        // EmmyLua 0.9.41 对跨文件全局（EventId = {} 定义在别的文件）的 definition 常错误返回
        // 当前文件最后一个使用点（同文件非声明形）。识别到误解析时降级走跨文件声明推导。
        const mis = isMisresolvedSameFileUsage(doc.uri, direct, doc.text, position)
        if (mis) {
          const cross = await crossFromRefs()
          if (cross) {
            log('definition direct was same-file misresolution → cross-file declaration (' + path + ':' + line + ':' + character + ')')
            return [cross]
          }
        }
        return direct
      }
      // ② 声明（服务器能力支持时）：EmmyLua 对局部变量/参数/表字段 definition 常返回空，declaration 更准
      if (capabilities.declaration) {
        try {
          const decl = normalizeLocations(
            await client.request<unknown>(
              'textDocument/declaration',
              { textDocument: { uri: doc.uri }, position },
            ),
          )
          if (decl.length) {
            log('definition fallback → declaration (' + path + ':' + line + ':' + character + ')')
            return decl
          }
        } catch (error) {
          log('declaration request failed: ' + String(error))
        }
      }
      // ③ 引用推导：definition/declaration 均空时，从 references(includeDeclaration) 推导声明
      // （EmmyLua 局部/参数把声明排在引用首位；词文本不一致则拒绝，宁可空不误跳）
      try {
        const refs = normalizeLocations(
          await client.request<unknown>(
            'textDocument/references',
            {
              textDocument: { uri: doc.uri },
              position,
              context: { includeDeclaration: true },
            },
          ),
        )
        const derived = deriveDefinitionFromLocations(position, refs, doc.text, doc.uri)
        // derived 为"点击处自身"（字段定义缺失空转）或"同文件非声明形使用点"（把 EventId 用
        // 点当定义）时都不直接信任 → 先找跨文件声明；二者皆非才直接用同文件推导结果。
        const selfDerived = derived ? rangeContains(position, derived.range) : false
        const misDerived = derived ? isMisresolvedSameFileUsage(doc.uri, [derived], doc.text, position) : false
        if (derived && !selfDerived && !misDerived) {
          log('definition fallback → references-derived (' + path + ':' + line + ':' + character + ')')
          return [derived]
        }
        const cross = await deriveCrossFileDeclaration(position, refs, doc.text, doc.uri, { readText: readTextByUri })
        if (cross) {
          log('definition fallback → cross-file declaration (' + path + ':' + line + ':' + character + ')')
          return [cross]
        }
        if (derived) {
          // 点中的正是声明自身，或引用里没有可识别的跨文件声明 → 返回自身/同文件结果（无更优目标）
          return [derived]
        }
      } catch (error) {
        log('references fallback failed: ' + String(error))
      }
      return []
    },

    async references(path: string, line: number, character: number, includeDeclaration: boolean): Promise<LspLocation[]> {
      const doc = docs.get(path)
      if (!doc || !(await readyWait)) return []
      const position = nudgeToWordEnd(doc.text, { line, character })
      const result = await ensureClient().request<unknown>(
        'textDocument/references',
        {
          textDocument: { uri: doc.uri },
          position,
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
      const client = ensureClient()
      // EmmyLua 词边界怪癖：位置在标识符前半 hover 返回 "unknown"，nudge 到词尾可正常解析
      const position = nudgeToWordEnd(doc.text, { line, character })
      const result = await client.request<{ contents?: unknown; range?: unknown } | null>(
        'textDocument/hover',
        { textDocument: { uri: doc.uri }, position },
      )
      const contents = result?.contents ? stringifyHoverContents(result.contents) : []
      // EmmyLua 对成员链字段（EventId.ISTaskSystem.TaskStateChange）hover 恒 "unknown"：
      // 退回查询基标识符（EventId），显示其类型而非无信息文本
      if (isEmptyHover(contents)) {
        const lines = doc.text.split(/\r\n|\r|\n/)
        const base = chainBaseRange(lines[position.line] ?? '', position.character)
        if (base) {
          const baseResult = await client.request<{ contents?: unknown } | null>(
            'textDocument/hover',
            { textDocument: { uri: doc.uri }, position: { line: position.line, character: base.end - 1 } },
          )
          const baseContents = baseResult?.contents ? stringifyHoverContents(baseResult.contents) : []
          if (!isEmptyHover(baseContents)) return { contents: baseContents }
        }
      }
      return contents.length ? { contents } : null
    },

    /**
     * 查询补全列表（textDocument/completion）。
     *
     * 列表阶段**剥离 documentation**：EmmyLua 把文档挂在 resolve 阶段（我方 initialize 已声明
     * resolveSupport），但并非所有服务器都遵守；每条都带长文档会让单次 RPC 载荷暴涨。
     * `data` 原样透传，resolve 时由服务器回认该条目。
     * @author ddj 2026年09月22号
     * @param path 工作区相对路径
     * @param line 0-based 行
     * @param character 0-based 列
     * @param context LSP CompletionContext（触发字符/触发类型）
     * @returns 归一化补全列表；不支持或文档未打开时 null
     */
    async completion(path: string, line: number, character: number, context?: unknown): Promise<LspCompletionList | null> {
      const doc = docs.get(path)
      if (!doc || !(await readyWait) || !capabilities.completion) return null
      const params: Record<string, unknown> = {
        textDocument: { uri: doc.uri },
        position: { line, character },
      }
      if (context) params.context = context
      const result = await ensureClient().request<unknown>('textDocument/completion', params)
      return normCompletion(result)
    },

    /**
     * 补全项惰性补全（completionItem/resolve）：按 `data` 取回 documentation/detail/additionalTextEdits。
     *
     * 必须回传**完整条目**（服务器按 data + label 精确匹配），只发 label/data 可能被服务器忽略。
     * @author ddj 2026年09月22号
     * @param path 工作区相对路径
     * @param item 列表阶段返回的补全项
     * @returns 补全后的条目；服务器不支持时原样返回
     */
    async resolveCompletion(path: string, item: LspCompletionItem): Promise<LspCompletionItem | null> {
      if (!item || typeof item.label !== 'string') return null
      if (!(await readyWait) || !capabilities.completionResolve) return item
      const result = await ensureClient().request<unknown>('completionItem/resolve', toLspCompItem(item))
      const resolved = normCompItem(result)
      return resolved ?? item
    },

    /**
     * 查询签名帮助（textDocument/signatureHelp）。
     *
     * activeSignature/activeParameter 做边界裁剪：服务器可能给越界值（多签名时按实参推进出错），
     * Monaco 拿到越界索引会取不到签名而不渲染 —— 裁剪后至少显示首个签名。
     * @author ddj 2026年09月22号
     * @param path 工作区相对路径
     * @param line 0-based 行
     * @param character 0-based 列
     * @returns 归一化签名帮助；无签名/不支持时 null
     */
    async signatureHelp(path: string, line: number, character: number): Promise<LspSignatureHelp | null> {
      const doc = docs.get(path)
      if (!doc || !(await readyWait) || !capabilities.signatureHelp) return null
      const result = await ensureClient().request<unknown>(
        'textDocument/signatureHelp',
        { textDocument: { uri: doc.uri }, position: { line, character } },
      )
      return toSignatureHelp(result)
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

/** hover/markdown 内容 → 纯文本（string | MarkupContent | MarkedString[] | MarkedString）。 */
function plainText(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined
  if (Array.isArray(value)) {
    const parts = value.map(plainText).filter((part): part is string => Boolean(part))
    return parts.length ? parts.join('\n\n') : undefined
  }
  if (value && typeof value === 'object') {
    // MarkedString 对象形态：{ language, value }；MarkupContent 形态：{ kind, value }
    const text = (value as { value?: unknown }).value
    if (typeof text === 'string') return text || undefined
  }
  return undefined
}

/**
 * 归一化补全文本编辑范围（单 range 与 insert/replace 双 range 两种形态）。
 *
 * 两种形态必须都认：只认一种会让采用另一种形态的服务器补全落点错位（替换范围算错，
 * 已输入的前缀被重复插入）。双 range 时 insert 用于「保留前缀插入」，replace 用于覆盖。
 * @author ddj 2026年09月22号
 * @param raw 原始 textEdit
 * @returns 归一化文本编辑；无有效范围或文本时 null
 */
function normalizeTextEdit(raw: unknown): LspCompletionTextEdit | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { range?: unknown; insert?: unknown; replace?: unknown; newText?: unknown }
  const newText = typeof obj.newText === 'string' ? obj.newText : ''
  if (!newText) return null
  const single = normalizeRange(obj.range)
  if (single) return { range: single, newText }
  const insert = normalizeRange(obj.insert)
  const replace = normalizeRange(obj.replace)
  if (!insert && !replace) return null
  return { insert: insert ?? replace!, replace: replace ?? insert!, newText }
}

/** 归一化 LSP Range（缺字段返回 null，避免产出畸形范围）。 */
function normalizeRange(raw: unknown): LspRange | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } }
  if (!r.start || !r.end) return null
  return {
    start: { line: toInt(r.start.line), character: toInt(r.start.character) },
    end: { line: toInt(r.end.line), character: toInt(r.end.character) },
  }
}

/**
 * 归一化单个补全项。
 * @author ddj 2026年09月22号
 * @param raw 原始条目
 * @returns 归一化条目；缺 label 时 null
 */
export function normCompItem(raw: unknown): LspCompletionItem | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const label = typeof obj.label === 'string' ? obj.label : ''
  if (!label) return null
  const item: LspCompletionItem = { label }
  if (typeof obj.kind === 'number') item.kind = toInt(obj.kind)
  if (typeof obj.detail === 'string' && obj.detail) item.detail = obj.detail
  const documentation = plainText(obj.documentation)
  if (documentation) item.documentation = documentation
  if (typeof obj.insertText === 'string') item.insertText = obj.insertText
  if (typeof obj.insertTextFormat === 'number') item.insertTextFormat = toInt(obj.insertTextFormat)
  const textEdit = normalizeTextEdit(obj.textEdit)
  if (textEdit) item.textEdit = textEdit
  if (obj.data !== undefined) item.data = obj.data
  if (typeof obj.sortText === 'string') item.sortText = obj.sortText
  if (typeof obj.filterText === 'string') item.filterText = obj.filterText
  if (obj.preselect === true) item.preselect = true
  if (Array.isArray(obj.commitCharacters)) {
    const chars = obj.commitCharacters.filter((c): c is string => typeof c === 'string')
    if (chars.length) item.commitCharacters = chars
  }
  // 弃用标记两处来源：顶层 deprecated（旧草案）与 tags 含 1（CompletionItemTag.Deprecated）
  const tags = Array.isArray(obj.tags) ? obj.tags : []
  if (obj.deprecated === true || tags.some((tag) => toInt(tag) === 1)) item.deprecated = true
  if (Array.isArray(obj.additionalTextEdits)) {
    const edits = obj.additionalTextEdits
      .map((edit) => {
        const range = normalizeRange((edit as { range?: unknown } | null)?.range)
        const text = (edit as { newText?: unknown } | null)?.newText
        if (!range || typeof text !== 'string') return null
        return { range, newText: text }
      })
      .filter((edit): edit is { range: LspRange; newText: string } => edit !== null)
    if (edits.length) item.additionalTextEdits = edits
  }
  return item
}

/**
 * 归一化补全结果（CompletionList | CompletionItem[]）。
 *
 * 两种顶层形态都要认：`{ isIncomplete, items }` 与裸数组。裸数组是最常见形态，
 * 只认 CompletionList 会让「补全列表恒为空」且无报错。
 * @author ddj 2026年09月22号
 * @param result 原始响应
 * @returns 归一化列表；无效时 null
 */
export function normCompletion(result: unknown): LspCompletionList | null {
  if (result == null) return null
  const list = Array.isArray(result)
    ? { items: result, isIncomplete: false }
    : (result as { items?: unknown; isIncomplete?: unknown })
  if (!Array.isArray(list.items)) return null
  const items = list.items
    .map(normCompItem)
    .filter((item): item is LspCompletionItem => item !== null)
  // 截断由 RPC 层按统一上限处理（与 definition/references 同口径），此处不下刀
  return { items, incomplete: list.isIncomplete === true }
}

/**
 * 补全项 → LSP 载荷（resolve 回传用）。
 * 只回传协议字段，剔除 client 侧衍生字段；`data` 必须原样带上，服务器靠它认条目。
 * @author ddj 2026年09月22号
 * @param item 归一化条目
 * @returns LSP CompletionItem 载荷
 */
export function toLspCompItem(item: LspCompletionItem): Record<string, unknown> {
  const out: Record<string, unknown> = { label: item.label }
  if (item.kind !== undefined) out.kind = item.kind
  if (item.detail !== undefined) out.detail = item.detail
  if (item.documentation !== undefined) out.documentation = item.documentation
  if (item.insertText !== undefined) out.insertText = item.insertText
  if (item.insertTextFormat !== undefined) out.insertTextFormat = item.insertTextFormat
  if (item.data !== undefined) out.data = item.data
  if (item.sortText !== undefined) out.sortText = item.sortText
  if (item.filterText !== undefined) out.filterText = item.filterText
  if (item.textEdit) out.textEdit = item.textEdit.range ? { range: item.textEdit.range, newText: item.textEdit.newText } : item.textEdit
  if (item.additionalTextEdits) out.additionalTextEdits = item.additionalTextEdits
  if (item.commitCharacters) out.commitCharacters = item.commitCharacters
  return out
}

/** 归一化单个签名参数（label 支持字符串与 [start, end] 元组，两者原样透传）。 */
function toSignatureParam(raw: unknown): LspParameterInformation | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { label?: unknown; documentation?: unknown }
  const tuple = Array.isArray(obj.label) && obj.label.length >= 2
    ? [toInt(obj.label[0]), toInt(obj.label[1])] as [number, number]
    : null
  if (typeof obj.label !== 'string' && !tuple) return null
  const param: LspParameterInformation = { label: typeof obj.label === 'string' ? obj.label : tuple! }
  const documentation = plainText(obj.documentation)
  if (documentation) param.documentation = documentation
  return param
}

/** 归一化单个签名。 */
function toSignature(raw: unknown): LspSignatureInformation | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { label?: unknown; documentation?: unknown; parameters?: unknown; activeParameter?: unknown }
  if (typeof obj.label !== 'string') return null
  const signature: LspSignatureInformation = { label: obj.label, parameters: [] }
  const documentation = plainText(obj.documentation)
  if (documentation) signature.documentation = documentation
  if (Array.isArray(obj.parameters)) {
    signature.parameters = obj.parameters
      .map(toSignatureParam)
      .filter((param): param is LspParameterInformation => param !== null)
  }
  if (typeof obj.activeParameter === 'number') signature.activeParameter = toInt(obj.activeParameter)
  return signature
}

/**
 * 归一化签名帮助，并裁剪越界的 activeSignature / activeParameter。
 *
 * 为什么必须裁：Monaco 用这两个索引直接取签名与参数，越界时取不到签名就整个浮窗不渲染；
 * 服务器在「实参刚敲下逗号」等边界时刻常给超前一位的索引。裁剪后至少显示首个签名/末个参数，
 * 观感是「高亮没跟上」，而不是「参数提示整个不见」。
 * @author ddj 2026年09月22号
 * @param result 原始响应
 * @returns 归一化结果；无有效签名时 null
 */
export function toSignatureHelp(result: unknown): LspSignatureHelp | null {
  if (!result || typeof result !== 'object') return null
  const obj = result as { signatures?: unknown; activeSignature?: unknown; activeParameter?: unknown }
  if (!Array.isArray(obj.signatures)) return null
  const signatures = obj.signatures
    .map(toSignature)
    .filter((signature): signature is LspSignatureInformation => signature !== null)
  if (!signatures.length) return null
  const activeSignature = Math.min(Math.max(0, toInt(obj.activeSignature)), signatures.length - 1)
  const current = signatures[activeSignature]!
  const rawActive = typeof obj.activeParameter === 'number' ? toInt(obj.activeParameter) : (current.activeParameter ?? 0)
  const count = current.parameters.length
  const activeParameter = count > 0 ? Math.min(Math.max(0, rawActive), count - 1) : 0
  return { signatures, activeSignature, activeParameter }
}

/** hover contents → 文本行（MarkupContent | MarkedString | MarkedString[]）。 */function stringifyHoverContents(contents: unknown): string[] {
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
