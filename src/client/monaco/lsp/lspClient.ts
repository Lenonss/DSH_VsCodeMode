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

/** 设置当前会话（切换会话时清理旧文档跟踪由 host 端 session/disposed 兜底）。 */
export function setLspSession(id) {
  if (sessionId === id) return
  sessionId = id
  void refreshStatus()
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

/** 立即同步某文档到 host（首次打开/查询前保证服务器已认识该文档）。 */
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

/** 立即推送 + 查询定义；返回 [{ uri, range }]（uri 已转 edrv://）。 */
export async function findDefinition(path, text, position) {
  await syncDoc(path, text, true)
  const res = await rpc('edrv.lsp.definition', { sessionId, path, position: monoToLsp(position.lineNumber, position.column) }).catch(() => null)
  if (!res || !res.ok || !Array.isArray(res.locations)) return []
  return res.locations.map(toClientLocation)
}

/** 立即推送 + 查询引用。 */
export async function findReferences(path, text, position, includeDeclaration = false) {
  await syncDoc(path, text, true)
  const res = await rpc('edrv.lsp.references', { sessionId, path, position: monoToLsp(position.lineNumber, position.column), includeDeclaration }).catch(() => null)
  if (!res || !res.ok || !Array.isArray(res.locations)) return []
  return res.locations.map(toClientLocation)
}

/** 查询大纲符号（documentSymbol）。 */
export async function fetchDocumentSymbols(path, text) {
  await syncDoc(path, text, true)
  const res = await rpc('edrv.lsp.documentSymbol', { sessionId, path }).catch(() => null)
  if (!res || !res.ok || !Array.isArray(res.symbols)) return []
  return res.symbols
}

/** 查询 hover 内容。 */
export async function fetchHover(path, text, position) {
  await syncDoc(path, text, true)
  const res = await rpc('edrv.lsp.hover', { sessionId, path, position: monoToLsp(position.lineNumber, position.column) }).catch(() => null)
  if (!res || !res.ok) return null
  return res.hover || null
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
  }
}

/** file:// URI（或裸路径）→ edrv:// 相对路径（去掉盘符/根，与编辑器模型路径一致）。 */
export function toEdrvUri(uri, root) {
  if (!uri) return ''
  if (uri.startsWith('edrv://')) return uri
  const path = relativeLspPath(uri, root)
  return 'edrv:///' + encodeURI(path)
}

/** 将 LSP 目标解析为当前工作区相对路径（跨文件跳转与 model URI 对齐）。 */
export function targetOpenPath(loc) {
  return relativeLspPath(loc?.uri, loc?.root)
}

/** file URI/裸路径 → root 下的 / 分隔相对路径；root 不匹配时保留规范化绝对路径。 */
function relativeLspPath(uri, root) {
  if (!uri) return ''
  let path = String(uri)
  if (path.startsWith('file://')) {
    try { path = decodeURIComponent(path.replace(/^file:\/\//, '')) } catch (error) { path = path.replace(/^file:\/\//, '') }
  }
  path = path.replace(/\\/g, '/').replace(/^\/([A-Za-z]:)/, '$1')
  const normalizedRoot = root ? String(root).replace(/\\/g, '/').replace(/^\/([A-Za-z]:)/, '$1').replace(/\/+$/, '') : ''
  const lowerPath = path.toLowerCase()
  const lowerRoot = normalizedRoot.toLowerCase()
  if (normalizedRoot && (lowerPath === lowerRoot || lowerPath.startsWith(lowerRoot + '/'))) {
    return path.slice(normalizedRoot.length).replace(/^\/+/, '')
  }
  return path.replace(/^\/+/, '')
}

/** 目标行/列（0-based LSP → 1-based Monaco）。 */
export function targetMonoPosition(loc) {
  const range = loc.range || {}
  const start = range.start || {}
  return {
    line: Math.max(1, (start.line ?? 0) + 1),
    column: Math.max(1, (start.character ?? 0) + 1),
  }
}
