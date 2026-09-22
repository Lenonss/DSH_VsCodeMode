// @ts-nocheck
/**
 * dsh-vscode-mode client — Monaco LSP provider 注册 + 跳转/引用命令。
 * 数据层：Definition/Reference/DocumentSymbol/Hover provider（同一文件内跳转 Monaco 原生可用）。
 * 交互层：edrv.goToDefinition（F12）/ edrv.findReferences（Shift+F12 / 右键）均走 Monaco 原生命令；
 * Ctrl+点击同样交给原生（多结果弹 Peek 让用户选、无定义时按 alternativeDefinitionCommand 降级），
 * 数据经 host 的 LSP RPC 提供（registerEditorOpener 接管 edrv:// 点击跳转）。
 * 作者 ddj 2026-08-27 / 2026-09-11
 */
import {
  pathOfModel, syncDoc, closeDoc, findDefinition, findReferences,
  fetchDocumentSymbols, fetchHover, fetchSemanticTokens,
  targetOpenPath, lspStatusFor, refreshStatus,
  lspUriToAbs,
} from './lspClient.js'
import { LSP_SEMANTIC_TOKEN_MODIFIERS, LSP_SEMANTIC_TOKEN_TYPES } from '../../../shared/lsp.js'

const LSP_LANGS = ['lua', 'csharp']
const SEMANTIC_LEGEND = {
  tokenTypes: [...LSP_SEMANTIC_TOKEN_TYPES],
  tokenModifiers: [...LSP_SEMANTIC_TOKEN_MODIFIERS],
}
let registered = false
const disposables = []

/** LSP provider 注册标记的全局挂点名（跨插件重载认领；见 disposeLspProviders）。 */
const LSP_PROVIDERS_GLOBAL = '__edrvLspProvidersRegistered__'

/** 目标文件打开并定位（复用现有 openFileAt 的 edrv:open-editor 事件通道）。 */
function openAt(path, target) {
  window.dispatchEvent(new CustomEvent('edrv:open-editor', { detail: Object.assign({ path }, target) }))
}

/**
 * 解析 Monaco opener 第三参（目标位置）为 1-based 区间。
 *
 * 为什么要兼容多形态：Monaco 经官方桥 `registerEditorOpener` 传出的是
 * `options.selection`（Range，含 getStartPosition）或其**降级形态**裸
 * `{ lineNumber, column }`（官方桥在 Range 缺 endLineNumber/endColumn 时降级），
 * 另有 `editor.action.goToLocations` 完全不传 options（第三参 undefined）。
 * 三种形态都出现过，逐形态取值并对缺字段兜底，避免落点退化成第 1 行。
 * @author ddj 2026年09月17号
 * @param selectionOrPosition opener 第三参（Range / 裸位置 / undefined）
 * @returns 1-based 目标区间（end 缺省等于 start，且保证 end >= start）
 */
export function navTargetOf(selectionOrPosition) {
  const src = selectionOrPosition ?? {}
  const start = typeof src.getStartPosition === 'function' ? src.getStartPosition() : src
  const end = typeof src.getEndPosition === 'function' ? src.getEndPosition() : null
  const line = Math.max(1, start?.lineNumber ?? 1)
  const column = Math.max(1, start?.column ?? 1)
  const rawEndLine = end?.lineNumber ?? src.endLineNumber
  const rawEndColumn = end?.column ?? src.endColumn
  const endLine = Math.max(line, rawEndLine != null ? Math.max(1, rawEndLine) : line)
  const endColumn = rawEndColumn != null ? Math.max(1, rawEndColumn) : undefined
  return endColumn === undefined ? { line, column, endLine } : { line, column, endLine, endColumn }
}

/** 注册全部 Monaco LSP provider 与文档跟踪（幂等）。 */
export function registerLspProviders(monaco) {
  if (registered) return
  // 跨重载守卫：window.monaco 存活的上一代已注册过整套 provider（标记落 window）
  const host = /* @__PURE__ */ (typeof window === 'undefined' ? undefined : window)
  if (host && host[LSP_PROVIDERS_GLOBAL]) {
    registered = true
    return
  }
  registered = true

  // —— 文档跟踪：model 生命周期 → host 文档同步（含未保存编辑）——
  const attachModel = (model) => {
    if (!model || model.uri.scheme !== 'edrv') return
    const path = pathOfModel(model)
    if (!path) return
    const contentDisposer = model.onDidChangeContent(() => syncDoc(path, model.getValue()))
    const disposeDisposer = model.onWillDispose(() => {
      closeDoc(path)
      contentDisposer.dispose()
    })
    disposables.push(contentDisposer, disposeDisposer)
    syncDoc(path, model.getValue(), true)
  }
  disposables.push(monaco.editor.onDidCreateModel(attachModel))
  for (const model of monaco.editor.getModels()) attachModel(model)

  // —— 重新检测事件：保存配置/切换启用/手动重检测后，把已打开模型重新同步给 host ——
  // （host 已重置该语言 server，下一次 sync 会按最新配置重新 acquire，无需重开文件）
  const onRedetect = (event) => {
    const languageId = event?.detail?.languageId
    if (!languageId) return
    for (const model of monaco.editor.getModels()) {
      const path = pathOfModel(model)
      if (!path) continue
      if (model.getLanguageId && model.getLanguageId() !== languageId) continue
      void syncDoc(path, model.getValue(), true)
    }
    void refreshStatus(true)
  }
  window.addEventListener('edrv:lsp-redetect', onRedetect)
  disposables.push(() => window.removeEventListener('edrv:lsp-redetect', onRedetect))

  // —— 数据 provider ——
  disposables.push(
    // 原生跳转（peek 参考文献列表点击 / 原生 go to definition 等）的 edrv:// 打开兜底：
    // 目标 uri 由本插件自己定义（edrv:// 工作区相对路径），Monaco 无法自行加载，
    // 必须经事件通道交给 EditorView openFileAt 打开并定位。
    monaco.editor.registerEditorOpener({
      openCodeEditor: (source, resource, selectionOrPosition) => {
        const path = lspUriToAbs(resource)
        if (!path) return false
        openAt(path, navTargetOf(selectionOrPosition))
        return true
      },
    }),
    monaco.languages.registerDefinitionProvider(LSP_LANGS, {
      provideDefinition: (model, position, token) => {
        const path = pathOfModel(model)
        if (!path) return []
        return findDefinition(path, model.getValue(), position)
      },
    }),
    monaco.languages.registerReferenceProvider(LSP_LANGS, {
      provideReferences: (model, position, context, token) => {
        const path = pathOfModel(model)
        if (!path) return []
        return findReferences(path, model.getValue(), position, Boolean(context?.includeDeclaration))
      },
    }),
    monaco.languages.registerDocumentSymbolProvider(LSP_LANGS, {
      provideDocumentSymbols: async (model, token) => {
        const path = pathOfModel(model)
        if (!path) return []
        const symbols = await fetchDocumentSymbols(path, model.getValue())
        return symbols.map(toMonacoSymbol)
      },
    }),
    monaco.languages.registerHoverProvider(LSP_LANGS, {
      provideHover: async (model, position, token) => {
        // 暂停态的 LSP 行由调试 hover 层默认隐藏、按住 Alt 时显示（见 dap/hoverTree.ts），
        // 因此这里照常返回内容，不再按位置让位。
        const path = pathOfModel(model)
        if (!path) return null
        const hover = await fetchHover(path, model.getValue(), position)
        if (!hover || !hover.contents || !hover.contents.length) return null
        const range = hover.range
          ? new monaco.Range(hover.range.start.line + 1, hover.range.start.character + 1, hover.range.end.line + 1, hover.range.end.character + 1)
          : null
        return {
          contents: hover.contents.map((text) => ({ value: text })),
          range: range || undefined,
        }
      },
    }),
    monaco.languages.registerDocumentSemanticTokensProvider(LSP_LANGS, {
      getLegend: () => SEMANTIC_LEGEND,
      provideDocumentSemanticTokens: async (model, token) => {
        const path = pathOfModel(model)
        if (!path || token?.isCancellationRequested) return { data: new Uint32Array() }
        const result = await fetchSemanticTokens(path, model.getValue())
        if (!result || token?.isCancellationRequested) return { data: new Uint32Array() }
        return { data: Uint32Array.from(result.data) }
      },
      releaseDocumentSemanticTokens: () => {},
    }),
  )
  // 注销器落 window：window.monaco 跨插件重载存活，模块级 registered 会复位，
  // 只判 registered 会在重载后重复注册全部 LSP provider（见 disposeLspProviders）。
  if (host) host[LSP_PROVIDERS_GLOBAL] = true
}

/**
 * 卸载 LSP provider 集合：注销全部注册并复位状态（插件重载/卸载时调用）。
 *
 * 必须存在的原因：DSH 0.1.6-alpha.2 起支持插件运行时卸载/重载，而 `window.monaco`
 * 由 loader 注入后**跨重载存活**；模块级 `registered`/`disposables` 却随 bundle 重新
 * 求值清空 —— 不注销则每次重载都重复叠加一整套 provider（跳转/hover/语义高亮翻倍）。
 * @author ddj 2026年09月18号
 */
export function disposeLspProviders() {
  for (const dispose of disposables.splice(0)) {
    try {
      if (typeof dispose === 'function') dispose()
      else if (dispose && typeof dispose.dispose === 'function') dispose.dispose()
    } catch { /* 单个注销异常不影响其余清理 */ }
  }
  registered = false
  const host = /* @__PURE__ */ (typeof window === 'undefined' ? undefined : window)
  if (host) delete host[LSP_PROVIDERS_GLOBAL]
}

/** LSP SymbolInfo（host 归一化后）→ Monaco DocumentSymbol。 */
function toMonacoSymbol(symbol) {
  const range = symbol.range || {}
  const sel = symbol.selectionRange || range
  const s = (p) => ({ lineNumber: Math.max(1, (p.line ?? 0) + 1), column: Math.max(1, (p.character ?? 0) + 1) })
  const out = {
    name: symbol.name,
    detail: symbol.detail || '',
    kind: symbol.kind ?? 0,
    tags: [],
    range: new window.monaco.Range(s(range.start).lineNumber, s(range.start).column, s(range.end).lineNumber, s(range.end).column),
    selectionRange: new window.monaco.Range(s(sel.start).lineNumber, s(sel.start).column, s(sel.end).lineNumber, s(sel.end).column),
  }
  if (Array.isArray(symbol.children) && symbol.children.length) {
    out.children = symbol.children.map(toMonacoSymbol)
  }
  return out
}

/**
 * F12 / 右键「转到定义」：交给完整 Monaco 原生命令（命令通道）。
 *
 * 为什么用原生而不是自研跳转：原生已内置多结果处理与降级链 ——
 * `gotoLocation.multipleDefinitions` 默认 `peek`（多个定义弹 Peek 让用户选），
 * 且取不到定义时按 `alternativeDefinitionCommand` 自动转 `goToReferences`。
 * 自研路径反而在「有 2 个定义但 0 条其它引用」时硬跳第一个，用户没有选择余地。
 * @author ddj 2026年09月11号
 * @param ed Monaco 编辑器
 */
export async function runGoToDefinition(ed) {
  if (!ed) return
  ed.trigger('edrv-lsp', 'editor.action.revealDefinition', null)
}

/**
 * 触发 Monaco 原生 References Peek（左侧代码 + 右侧引用列表，原生点击跳转）。
 *
 * ⚠️ 不能用 `ed.getAction(id)` 判断可用性：`getAction` 只反映 `_actions` 表（由
 * `registerEditorAction` 填充），而 peek 系列动作经 `registerAction2` 注册进命令表，
 * 二者不是同一通道——实测 Peek 能正常弹出时 `getAction(...)` 仍返回 null，
 * 旧实现据此 return false，正是「引用查找完全没反应」的直接成因。
 * 现改为：① 以 referencesController contribution 判能力；② 经命令通道 trigger 触发。
 * @author ddj 2026年09月02号 / 2026年09月11号
 * @param ed Monaco 编辑器
 * @returns 是否触发成功（不支持时给出状态栏提示）
 */
export async function triggerReferencePeek(ed) {
  if (!peekSupported(ed)) {
    setStatus('当前 Monaco 构建不支持引用预览（缺 gotoSymbol/peekView 贡献），请更新插件 vendor')
    return false
  }
  // 命令通道：peek 动作为 registerAction2 注册，须经 trigger 执行
  ed.trigger('edrv-lsp', 'editor.action.referenceSearch.trigger', null)
  return true
}

/**
 * 当前 Monaco 是否具备引用 Peek 能力（referencesController contribution 注入即视为支持）。
 * @author ddj 2026年09月11号
 * @param ed Monaco 编辑器
 * @returns 是否支持
 */
function peekSupported(ed) {
  if (!ed || typeof ed.getContribution !== 'function') return false
  try {
    return Boolean(ed.getContribution('editor.contrib.referencesController'))
  } catch (error) {
    return false
  }
}

/** Shift+F12 / 右键「查找所有引用」：走 Monaco 原生 References Peek（两栏引用视图）。 */
export async function runFindReferences(ed) {
  const position = ed.getPosition()
  if (!position) return
  ed.setPosition(position)
  await triggerReferencePeek(ed)
}

/**
 * 兼容占位（历史导出；自绘引用浮窗已移除，改走 Monaco 原生 Peek）。
 * @author ddj 2026年09月02号
 */
export function hideReferencesOverlay() {}

/** 编辑器状态栏提示（复用 EditorView 的 status 通道）。 */
function setStatus(text) {
  window.dispatchEvent(new CustomEvent('edrv:status', { detail: { text } }))
}

/** 当前会话与语言就绪状态（供编辑器状态点）。 */
export function lspStatusDot(languageId) {
  const status = lspStatusFor(languageId)
  return status ? status.phase : 'none'
}
