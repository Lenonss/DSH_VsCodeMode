// @ts-nocheck
/**
 * dsh-vscode-mode client — LSP 装配编排。
 * setupLsp(monaco)：注册 Monaco provider 与文档跟踪（幂等）；调用方在 Monaco 加载后调用。
 * setSession(id)：会话切换时同步（provider 与文档同步共用）。
 * 作者 ddj 2026-08-27
 */
import { registerLspProviders, hideReferencesOverlay } from './providers.js'
import { setLspSession, refreshStatus, lspStatusFor, onLspProgress } from './lspClient.js'

let monacoRef = null

/** Monaco 加载后装配（幂等；重复调用仅刷新会话）。 */
export function setupLsp(monaco) {
  monacoRef = monaco
  registerLspProviders(monaco)
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

export { lspStatusFor, refreshStatus, onLspProgress }
