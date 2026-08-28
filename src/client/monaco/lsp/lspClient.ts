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
  if (!force && Date.now() - statusCache.at < 5000) return statusCache.servers
  const res = await rpc('edrv.lsp.status', {}).catch(() => null)
  const servers = res && res.ok && Array.isArray(res.servers) ? res.servers : []
  statusCache = { servers, at: Date.now() }
  ready = true
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
    uri: window.monaco.Uri.parse(toEdrvUri(loc.uri)),
    range: new window.monaco.Range(
      Math.max(1, (start.line ?? 0) + 1),
      Math.max(1, (start.character ?? 0) + 1),
      Math.max(1, (end.line ?? 0) + 1),
      Math.max(1, (end.character ?? 0) + 1),
    ),
  }
}

/** file:// URI（或裸路径）→ edrv:// 相对路径（去掉盘符/根，与编辑器模型路径一致）。 */
export function toEdrvUri(uri) {
  if (!uri) return ''
  if (uri.startsWith('edrv://')) return uri
  let path = uri
  if (path.startsWith('file://')) {
    path = decodeURIComponent(path.replace(/^file:\/\//, ''))
  }
  // 去掉 Windows 盘符（edrv:///C:/x → edrv:///x？）——保持与编辑器 model.uri.path 一致的相对形式
  path = path.replace(/^\/[A-Za-z]:/, '')
  return 'edrv:///' + encodeURI(path.replace(/\\/g, '/'))
}

/** 将 LSP 目标 path 解析为 edrv 打开路径（供跳转）：取 file:// 去盘符的相对形式。 */
export function targetOpenPath(loc) {
  let path = loc.uri || ''
  if (path.startsWith('file://')) path = decodeURIComponent(path.replace(/^file:\/\//, ''))
  path = path.replace(/^\/[A-Za-z]:/, '').replace(/\\/g, '/')
  return path
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
