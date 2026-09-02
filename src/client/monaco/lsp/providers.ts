// @ts-nocheck
/**
 * dsh-vscode-mode client — Monaco LSP provider 注册 + 跳转/引用命令。
 * 数据层：Definition/Reference/DocumentSymbol/Hover provider（同一文件内跳转 Monaco 原生可用）。
 * 交互层：edrv.goToDefinition（F12）/ edrv.findReferences（Shift+F12 / 右键）/ Ctrl+点击引用导航，
 * 跨文件跳转自研（target 经 openFileAt 打开并定位），多条引用走 Monaco 原生 References Peek
 * （左侧代码预览 + 右侧引用列表；registerEditorOpener 接管 edrv:// 点击跳转）。
 * 作者 ddj 2026-08-27
 */
import {
  pathOfModel, syncDoc, closeDoc, findDefinition, findReferences,
  fetchDocumentSymbols, fetchHover, fetchSemanticTokens,
  targetOpenPath, targetMonoPosition, lspStatusFor, refreshStatus,
  lspUriToAbs,
} from './lspClient.js'
import { LSP_SEMANTIC_TOKEN_MODIFIERS, LSP_SEMANTIC_TOKEN_TYPES, monoToLsp } from '../../../shared/lsp.js'

const LSP_LANGS = ['lua', 'csharp']
const SEMANTIC_LEGEND = {
  tokenTypes: [...LSP_SEMANTIC_TOKEN_TYPES],
  tokenModifiers: [...LSP_SEMANTIC_TOKEN_MODIFIERS],
}
let registered = false
const disposables = []

/** 目标文件打开并定位（复用现有 openFileAt 的 edrv:open-editor 事件通道）。 */
function openAt(path, line, column) {
  window.dispatchEvent(new CustomEvent('edrv:open-editor', { detail: { path, line, column } }))
}

function jumpToLocation(loc) {
  const path = targetOpenPath(loc)
  const pos = targetMonoPosition(loc)
  openAt(path, pos.line, pos.column)
}

/** 注册全部 Monaco LSP provider 与文档跟踪（幂等）。 */
export function registerLspProviders(monaco) {
  if (registered) return
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
        const start = selectionOrPosition?.getStartPosition?.() ?? selectionOrPosition
        const line = Math.max(1, start?.lineNumber ?? 1)
        const column = Math.max(1, start?.column ?? 1)
        openAt(path, line, column)
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

/** 定义查询并跳转；nativeReveal 仅供 F12 保留 Monaco 原生 reveal。 */
async function goToDefinition(ed, position, nativeReveal = false) {
  const model = ed.getModel()
  const path = pathOfModel(model)
  if (!path || !position) return
  const locations = await findDefinition(path, model.getValue(), position)
  if (!locations.length) {
    setStatus('未找到定义')
    return
  }
  const first = locations[0]
  if (nativeReveal && targetOpenPath(first) === path) {
    const action = ed.getAction('editor.action.revealDefinition')
    if (action) {
      await action.run()
      return
    }
  }
  jumpToLocation(first)
}

/** F12 / 右键「转到定义」：查询定义并跳转（首个目标）。 */
export async function runGoToDefinition(ed) {
  await goToDefinition(ed, ed.getPosition(), true)
}

/**
 * Ctrl+鼠标点击：查询其它内容对该项的引用并导航。
 * 0 条 → 无特殊效果；1 条 → 直接跳转；多条 → 打开 Monaco 原生 References Peek
 * （左侧代码预览 + 右侧引用列表，点击经 registerEditorOpener 跳转）。
 * @author ddj 2026年09月02号
 * @param ed Monaco 编辑器
 * @param position 点击位置（Monaco 1-based）
 */
export async function gotoRefsAt(ed, position) {
  const model = ed.getModel()
  const path = pathOfModel(model)
  if (!path || !position) return
  const all = await findReferences(path, model.getValue(), position, false)
  const others = filterOtherRefs(all, path, position)
  if (!others.length) {
    // 0 条「其它」引用：降级查定义（参数/局部变量只被声明时引用为空，定义可经 host 降级链推导）
    const defs = await findDefinition(path, model.getValue(), position)
    const first = defs[0]
    if (!first) return
    const lspPos = monoToLsp(position.lineNumber, position.column)
    if (sameFile(targetOpenPath(first), path) && posInRange(lspPos, first.lspRange)) return // 定义即自身：无其它可跳，保持静默
    jumpToLocation(first)
    return
  }
  if (others.length === 1) {
    jumpToLocation(others[0])
    return
  }
  // 计数器就绪：光标移到点击处（原生 Peek 按光标词查询），走原生两栏引用视图
  ed.setPosition(position)
  await triggerReferencePeek(ed)
}

/**
 * 触发 Monaco 原生 References Peek（左侧代码 + 右侧引用列表，原生点击跳转）。
 * @author ddj 2026年09月02号
 * @param ed Monaco 编辑器
 * @returns 是否成功触发（动作缺失时返回 false）
 */
export async function triggerReferencePeek(ed) {
  const action = ed.getAction('editor.action.referenceSearch.trigger')
  if (!action || typeof action.run !== 'function') return false
  await action.run()
  return true
}

/**
 * 过滤「其它内容」引用：剔除当前点击处自身（同文件且点击位置落入其 range），并按路径+起点去重。
 * @author ddj 2026年09月02号
 * @param locations 引用结果
 * @param path 当前文档路径
 * @param position 点击位置（Monaco 1-based）
 * @returns 过滤后的其它引用
 */
function filterOtherRefs(locations, path, position) {
  const lspPos = monoToLsp(position.lineNumber, position.column)
  const seen = new Set()
  const out = []
  for (const loc of locations) {
    const rel = targetOpenPath(loc)
    if (sameFile(rel, path) && posInRange(lspPos, loc.lspRange)) continue
    const start = loc.lspRange?.start ?? {}
    const key = String(rel).toLowerCase() + ':' + (start.line ?? 0) + ':' + (start.character ?? 0)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(loc)
  }
  return out
}

/**
 * 两个路径是否指向同一文件（容忍相对/绝对混合与大小写差异）。
 * @author ddj 2026年09月02号
 * @param a 路径 A
 * @param b 路径 B
 * @returns 是否同一文件
 */
function sameFile(a, b) {
  if (!a || !b) return false
  const na = String(a).replace(/\\/g, '/').toLowerCase()
  const nb = String(b).replace(/\\/g, '/').toLowerCase()
  if (na === nb) return true
  const absA = /^[A-Za-z]:\//.test(na) || na.startsWith('/')
  const absB = /^[A-Za-z]:\//.test(nb) || nb.startsWith('/')
  // 同为相对/同为绝对但不等 → 不同文件（避免根目录文件误匹配同名子目录文件）
  if (absA === absB) return false
  // 一方绝对一方相对：绝对路径以相对路径结尾视为同文件
  return absA ? na.endsWith('/' + nb) : nb.endsWith('/' + na)
}

/**
 * 0-based LSP 位置是否落在 range 内（end 排除；零宽 range 按点匹配）。
 * @author ddj 2026年09月02号
 * @param pos LSP 位置（0-based）
 * @param range LSP range
 * @returns 是否在范围内
 */
function posInRange(pos, range) {
  const start = range?.start
  if (!start) return false
  const end = range?.end ?? start
  if (start.line === end.line && start.character === end.character) {
    return pos.line === start.line && pos.character === start.character
  }
  if (pos.line < start.line || pos.line > end.line) return false
  if (pos.line === start.line && pos.character < start.character) return false
  if (pos.line === end.line && pos.character >= end.character) return false
  return true
}

/** 给一个 Monaco 编辑器绑定 Ctrl/Cmd+鼠标引用导航（幂等）。 */
export function bindLspEditor(ed) {
  if (!ed || ed.__edrvLspClick) return
  ed.__edrvLspClick = true
  const disposable = ed.onMouseDown((event) => {
    const native = event?.event
    const position = event?.target?.position
    const button = native?.button ?? event?.button
    const ctrl = native?.ctrlKey ?? event?.ctrlKey
    const meta = native?.metaKey ?? event?.metaKey
    const isLeftButton = button === 0 || native?.leftButton === true
    if (!native || !position || !isLeftButton || (!ctrl && !meta)) return
    native.preventDefault?.()
    native.stopPropagation?.()
    void gotoRefsAt(ed, position)
  })
  disposables.push(disposable)
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
