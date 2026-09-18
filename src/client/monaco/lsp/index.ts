// @ts-nocheck
/**
 * dsh-vscode-mode client — LSP 装配编排。
 * setupLsp(monaco)：注册 Monaco provider 与文档跟踪（幂等）；调用方在 Monaco 加载后调用。
 * setSession(id)：会话切换时同步（provider 与文档同步共用）。
 * 作者 ddj 2026-08-27
 */
import { registerLspProviders, disposeLspProviders, hideReferencesOverlay } from './providers.js'
import { setLspSession, refreshStatus, lspStatusFor, onLspProgress, bindLspSession } from './lspClient.js'

let monacoRef = null
let sessionBound = false
/** 会话广播取消订阅函数（卸载时调用；落 window 以便跨重载清理上一代监听）。 */
let sessionUnbind = null

/** 会话广播订阅标记的全局挂点名（跨插件重载认领；见 disposeLsp）。 */
const LSP_SESSION_GLOBAL = '__edrvLspSessionUnbind__'

/** Monaco 加载后装配（幂等；重复调用仅刷新会话）。 */
export function setupLsp(monaco) {
  monacoRef = monaco
  registerLspProviders(monaco)
  // 会话广播订阅只装一次：跨重载时上一代已订阅（取消函数落 window，模块级状态会复位），
  // 只判 sessionBound 会重复订阅 → 同一 LSP 会话事件被处理多次。
  const host = /* @__PURE__ */ (typeof window === 'undefined' ? undefined : window)
  if (host && typeof host[LSP_SESSION_GLOBAL] === 'function') {
    sessionBound = true
    sessionUnbind = host[LSP_SESSION_GLOBAL]
    return
  }
  if (!sessionBound) {
    sessionBound = true
    sessionUnbind = bindLspSession()
    if (host) host[LSP_SESSION_GLOBAL] = sessionUnbind
  }
}

/** 会话切换：更新 host 侧文档归属 + 刷新状态。 */
export function setSession(sessionId) {
  setLspSession(sessionId)
  void refreshStatus(true)
}

/** 编辑器卸载时清理浮动面板。 */
export function disposeLspOverlay() {
  hideReferencesOverlay()
}

/**
 * 卸载 LSP 装配（插件重载/卸载时调用）：注销全部 provider、解绑会话广播并复位标记。
 * @author ddj 2026年09月18号
 */
export function disposeLsp() {
  disposeLspProviders()
  const unbind = sessionUnbind
  if (typeof unbind === 'function') {
    try { unbind() } catch { /* 已解绑 */ }
  }
  sessionUnbind = null
  sessionBound = false
  monacoRef = null
  const host = /* @__PURE__ */ (typeof window === 'undefined' ? undefined : window)
  if (host) delete host[LSP_SESSION_GLOBAL]
}

export { lspStatusFor, refreshStatus, onLspProgress }
