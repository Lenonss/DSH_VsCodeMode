// @ts-nocheck
/**
 * dsh-vscode-mode client — LSP 装配编排。
 * setupLsp(monaco)：注册 Monaco provider 与文档跟踪（幂等）；调用方在 Monaco 加载后调用。
 * setSession(id)：会话切换时同步（provider 与文档同步共用）。
 * 作者 ddj 2026-08-27
 */
import { registerLspProviders, disposeLspProviders, hideReferencesOverlay } from './providers.js'
import { registerDapHover, disposeDapHover } from '../../dap/hover.js'
import { installHoverTree, disposeHoverTree } from '../../dap/hoverTree.js'
import { installHoverMode, disposeHoverMode } from '../../dap/hoverMode.js'
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
  // 注册顺序决定同分 provider 的 ordinal：LanguageFeatureRegistry._compareByScoreAndTime 对
  // 同分选择器按 _time 倒序（后注册者排前），hover 部件再按 ordinal 升序渲染 —— 因此 DAP
  // 必须**最后**注册，暂停态的调试值行才会稳定渲染在 LSP 文档行之前；反序会让调试值被
  // LSP 长文档挤到浮窗下方（超出 maxHeight 需滚动，等同看不到）。
  registerLspProviders(monaco)
  registerDapHover(monaco)
  // hover 变量树的 DOM 绑定（观察 hover 面板插入/重渲染；幂等）
  installHoverTree()
  // Alt 跟踪：暂停态默认调试值浮窗、按住 Alt 切 LSP 信息（对齐 CodeBuddy）
  installHoverMode()
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
  disposeDapHover()
  disposeHoverTree()
  disposeHoverMode()
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
