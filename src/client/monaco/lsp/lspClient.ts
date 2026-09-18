// @ts-nocheck
/**
 * dsh-vscode-mode client — LSP 会话与文档同步（模块级单例）。
 * 跟踪当前会话 + Monaco 打开文档（model 事件驱动），去抖推送 edrv.lsp.sync；
 * 并提供 definition/references/documentSymbol/hover/status 的 RPC 薄封装。
 * 作者 ddj 2026-08-27
 */
import { rpc } from '../../rpc.js'
import { monoToLsp } from '../../../shared/lsp.js'

/** edrv:// 模型 URI → 工作区相对/绝对路径（与 host 侧 path 对齐）。 */
export function pathOfModel(model) {
  if (!model || !model.uri) return null
  const uri = model.uri
  if (uri.scheme !== 'edrv') return null
  const raw = uri.path ?? ''
  try {
    const decoded = decodeURIComponent(String(raw).replace(/^\//, ''))
    return decoded || null
  } catch (error) {
    return String(raw).replace(/^\//, '') || null
  }
}

const SYNC_DEBOUNCE_MS = 250

let sessionId
const syncTimers = new Map()
let statusCache = { servers: [], at: 0 }
let progressListeners = new Set()
let ready = false

/** 会话 id 变更通知（EditorView 持有权威 sessionId，经窗口事件回填）。 */
const SESSION_EVENT = 'edrv:lsp-session'

/** 上报可见状态（复用 EditorView 的状态通道；失败不再静默）。 */
function reportStatus(text) {
  try {
    window.dispatchEvent(new CustomEvent('edrv:status', { detail: { text } }))
  } catch (error) { /* 无 window/派发失败忽略 */ }
}

/**
 * 设置当前会话（切换会话时清理旧文档跟踪由 host 端 session/disposed 兜底）。
 * @author ddj 2026年08月27号
 * @param id 会话 id
 */
export function setLspSession(id) {
  if (sessionId === id) return
  sessionId = id
  void refreshStatus()
}

/**
 * 订阅窗口会话广播（幂等）：EditorView 是 sessionId 的权威来源，挂载与会话切换时广播。
 * 独立于服务订阅，避免服务形状变化时 LSP 整体失联。
 *
 * 返回值是可重入的取消订阅函数；调用方应保存并在卸载时调用（否则重载后会累积监听）。
 * @author ddj 2026年09月11号 / 2026年09月18号
 * @returns 取消订阅函数
 */
export function bindLspSession() {
  if (typeof window === 'undefined') return () => {}
  const onSession = (event) => {
    const next = event && event.detail ? event.detail.sessionId : undefined
    if (typeof next === 'string' && next) setLspSession(next)
  }
  window.addEventListener(SESSION_EVENT, onSession)
  return () => window.removeEventListener(SESSION_EVENT, onSession)
}

export function lspSessionId() {
  return sessionId
}

/** 订阅 LSP 状态变化（服务器进度/启动状态）。 */
export function onLspProgress(listener) {
  if (typeof listener !== 'function') return () => {}
  progressListeners.add(listener)
  return () => progressListeners.delete(listener)
}

/** 发布当前 server 状态给编辑器底部状态区。 */
function publishProgress() {
  for (const listener of progressListeners) {
    try { listener(statusCache.servers) } catch (error) { /* UI listener failure ignored */ }
  }
}

/**
 * 立即同步某文档到 host（首次打开/查询前保证服务器已认识该文档）。
 * sessionId 缺失时仍发起请求：host 对唯一活跃会话有兜底解析，弃发会白白丢失文档归属。
 * @author ddj 2026年08月27号 / 2026年09月11号
 * @param path 工作区相对路径
 * @param text 文档全文
 * @param immediate true 立即发送，false 去抖
 */
export async function syncDoc(path, text, immediate = false) {
  if (!path || typeof text !== 'string') return
  if (immediate) {
    clearPending(path)
    await rpc('edrv.lsp.sync', { sessionId, path, text, version: Date.now() }).catch(() => {})
    return
  }
  clearPending(path)
  syncTimers.set(path, setTimeout(() => {
    syncTimers.delete(path)
    rpc('edrv.lsp.sync', { sessionId, path, text, version: Date.now() }).catch(() => {})
  }, SYNC_DEBOUNCE_MS))
}

function clearPending(path) {
  const timer = syncTimers.get(path)
  if (timer) { clearTimeout(timer); syncTimers.delete(path) }
}

/** 文档关闭：停止去抖并通知 host。 */
export function closeDoc(path) {
  clearPending(path)
  void rpc('edrv.lsp.close', { sessionId, path }).catch(() => {})
}

/**
 * 统一查询封装：失败可见。
 * host 返回 ok:false（会话失效/服务器不可用等）时上报状态，避免被吞成"无结果"——
 * 旧实现在此处一律返回空数组，功能失效时用户看不到任何反馈。
 * @author ddj 2026年09月11号
 * @param action 动作名（错误提示用）
 * @param method RPC 方法
 * @param args 载荷（sessionId 由本函数补齐）
 * @returns 成功响应；失败返回 null
 */
async function queryLsp(action, method, args) {
  const res = await rpc(method, { ...args, sessionId }).catch(() => null)
  if (!res || !res.ok) {
    reportStatus('LSP ' + action + '失败：' + ((res && res.error) ? res.error : '请求异常'))
    return null
  }
  return res
}

/** 立即推送 + 查询定义；返回 [{ uri, range }]（uri 已转 edrv://）。 */
export async function findDefinition(path, text, position) {
  await syncDoc(path, text, true)
  const res = await queryLsp('转到定义', 'edrv.lsp.definition', { path, position: monoToLsp(position.lineNumber, position.column) })
  if (!res || !Array.isArray(res.locations)) return []
  return res.locations.map(toClientLocation)
}

/** 立即推送 + 查询引用。 */
export async function findReferences(path, text, position, includeDeclaration = false) {
  await syncDoc(path, text, true)
  const res = await queryLsp('查找引用', 'edrv.lsp.references', { path, position: monoToLsp(position.lineNumber, position.column), includeDeclaration })
  if (!res || !Array.isArray(res.locations)) return []
  return res.locations.map(toClientLocation)
}

/** 查询大纲符号（documentSymbol）。 */
export async function fetchDocumentSymbols(path, text) {
  await syncDoc(path, text, true)
  const res = await queryLsp('查询大纲', 'edrv.lsp.documentSymbol', { path })
  if (!res || !Array.isArray(res.symbols)) return []
  return res.symbols
}

/** 查询 hover 内容。 */
export async function fetchHover(path, text, position) {
  await syncDoc(path, text, true)
  const res = await queryLsp('查询悬停', 'edrv.lsp.hover', { path, position: monoToLsp(position.lineNumber, position.column) })
  if (!res) return null
  return res.hover || null
}

/** 查询当前文档的 semantic tokens（host 已归一化 legend 与 delta data）。 */
export async function fetchSemanticTokens(path, text) {
  await syncDoc(path, text, true)
  const res = await queryLsp('查询语义分色', 'edrv.lsp.semanticTokens', { path })
  if (!res || !res.tokens || !Array.isArray(res.tokens.data)) return null
  return res.tokens
}

/** 拉取服务器状态（带 5s 缓存）。 */
export async function refreshStatus(force = false) {
  if (!force && Date.now() - statusCache.at < 1500) return statusCache.servers
  const res = await rpc('edrv.lsp.status', { sessionId }).catch(() => null)
  const servers = res && res.ok && Array.isArray(res.servers) ? res.servers : []
  statusCache = { servers, at: Date.now() }
  ready = true
  publishProgress()
  return servers
}

export function lspReady() {
  return ready
}

/** 当前会话某语言服务器状态（就绪/索引中/不可用）。 */
export function lspStatusFor(languageId) {
  const servers = statusCache.servers
  const match = servers.find((s) => s.languageId === languageId && s.root)
  return match || servers.find((s) => s.languageId === languageId)
}

/** file:// 或已转 edrv:// 的 LSP location → Monaco Location（edrv:// uri + 1-based range）。 */
function toClientLocation(loc) {
  const range = loc.range || {}
  const start = range.start || {}
  const end = range.end || {}
  return {
    uri: window.monaco.Uri.parse(toEdrvUri(loc.uri, loc.root)),
    range: new window.monaco.Range(
      Math.max(1, (start.line ?? 0) + 1),
      Math.max(1, (start.character ?? 0) + 1),
      Math.max(1, (end.line ?? 0) + 1),
      Math.max(1, (end.character ?? 0) + 1),
    ),
    // 保留原始 LSP uri/root：后续跳转不能把 Monaco edrv Uri 当作磁盘路径
    lspUri: loc.uri,
    lspRoot: loc.root,
    lspRange: loc.range,
  }
}

/** file:// URI（或裸路径）→ edrv:// 相对路径（去掉盘符/根，与编辑器模型路径一致）。 */
export function toEdrvUri(uri, root) {
  if (!uri) return ''
  if (uri.startsWith('edrv://')) return uri
  const path = relativeLspPath(uri, root)
  // root 不匹配时 relativeLspPath 返回完整绝对路径（/home/x 或 D:/x）：
  // 直接拼 'edrv:///' 会得 edrv:////home/x（空 authority + // 开头）→ Uri.parse 抛
  // UriError（issue #5/#6 同源隐患，LSP 定义/引用跳转工作区外文件时触发）；
  // 剥前导 / 后与编辑器 model URI 的相对路径约定一致（Windows 盘符形态不受影响）
  return 'edrv:///' + encodeURI(String(path ?? '').replace(/^\/+/, ''))
}

/** 将 LSP 目标解析为当前工作区相对路径（跨文件跳转与 model URI 对齐）。 */
export function targetOpenPath(loc) {
  return relativeLspPath(loc?.lspUri ?? loc?.uri, loc?.lspRoot ?? loc?.root)
}

/**
 * 归一化 Location 的 uri → 工作区路径（剥离 scheme，不补盘符）。
 * 三种输入形态（缺一即导致 scheme 泄漏进文件路径 → 跳转"文件不存在"）：
 * - Monaco Uri 对象（toClientLocation 产物，scheme=edrv）→ 取 .path（已是工作区相对路径）
 * - 'edrv:///x' 字符串 → 取路径部分
 * - 'file:///D:/x' → 去 authority 空段保留盘符
 * @author ddj 2026年08月28号
 * @param uri Monaco Uri 对象 / file:// 或 edrv:// URI / 裸路径
 * @returns / 分隔的路径（edrv 相对路径 或 带盘符绝对路径）
 */
export function lspUriToAbs(uri) {
  if (!uri) return ''
  const isObject = typeof uri === 'object'
  // Monaco Uri 对象：优先取其 path（已剥离 scheme）
  const raw = isObject && typeof uri.path === 'string' ? uri.path : String(uri)
  let path = raw
  if (path.startsWith('file://')) {
    try { path = decodeURIComponent(path.replace(/^file:\/\/\/?/, '')) } catch (error) { path = path.replace(/^file:\/\/\/?/, '') }
    // file:///D:/x → D:/x（去 authority 空段保留盘符）；/home/x 保留前导 /（Unix 绝对路径）
    return path.replace(/\\/g, '/').replace(/^\/([A-Za-z]:)/, '$1')
  }
  if (path.startsWith('edrv://')) {
    try { path = decodeURIComponent(path.replace(/^edrv:\/\/\/?/, '')) } catch (error) { path = path.replace(/^edrv:\/\/\/?/, '') }
  }
  // edrv Uri（对象或字符串）→ 工作区相对路径：必须剥前导 /，否则 host 按绝对路径解析丢 cwd
  if (isObject ? uri.scheme === 'edrv' : raw.startsWith('edrv://')) {
    return path.replace(/\\/g, '/').replace(/^\/+/, '')
  }
  return path.replace(/\\/g, '/').replace(/^\/([A-Za-z]:)/, '$1')
}

/**
 * file URI/裸路径 → root 下的 / 分隔相对路径。
 * root 匹配返回工作区相对路径；root 不匹配返回完整绝对路径（保留盘符），
 * 供 edrv.read 按绝对路径解析（原先错误剥掉首个 / 导致跳转"文件不存在"）。
 * @author ddj 2026年08月28号
 * @param uri file:// URI 或裸路径
 * @param root 工作区根（可选）
 * @returns 可 edrv.read 的路径
 */
function relativeLspPath(uri, root) {
  if (!uri) return ''
  const path = lspUriToAbs(uri)
  const normalizedRoot = root ? String(root).replace(/\\/g, '/').replace(/^\/([A-Za-z]:)/, '$1').replace(/\/+$/, '') : ''
  const lowerPath = path.toLowerCase()
  const lowerRoot = normalizedRoot.toLowerCase()
  if (normalizedRoot && (lowerPath === lowerRoot || lowerPath.startsWith(lowerRoot + '/'))) {
    return path.slice(normalizedRoot.length).replace(/^\/+/, '')
  }
  return path
}

/** 目标行/列（0-based LSP → 1-based Monaco）。 */
export function targetMonoPosition(loc) {
  // 优先使用原始 LSP range（0-based）；无原始值时兼容 Monaco Range（1-based）
  const lspRange = loc?.lspRange
  if (lspRange?.start) {
    return {
      line: Math.max(1, (lspRange.start.line ?? 0) + 1),
      column: Math.max(1, (lspRange.start.character ?? 0) + 1),
    }
  }
  const range = loc?.range ?? {}
  return {
    line: Math.max(1, range.startLineNumber ?? 1),
    column: Math.max(1, range.startColumn ?? 1),
  }
}
