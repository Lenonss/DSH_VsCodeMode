// @ts-nocheck
/**
 * dsh-vscode-mode client — Monaco LSP provider 注册 + 跳转/引用命令。
 * 数据层：Definition/Reference/DocumentSymbol/Hover provider（同一文件内跳转 Monaco 原生可用）。
 * 交互层：edrv.goToDefinition（F12）/ edrv.findReferences（Shift+F12 / 右键），跨文件跳转自研
 * （target 经 openFileAt 打开并定位），引用结果用轻量浮动面板展示（点击跳转）。
 * 作者 ddj 2026-08-27
 */
import {
  pathOfModel, syncDoc, closeDoc, findDefinition, findReferences,
  fetchDocumentSymbols, fetchHover, targetOpenPath, targetMonoPosition, lspStatusFor,
} from './lspClient.js'

const LSP_LANGS = ['lua', 'csharp']
let registered = false
const disposables = []
let overlayEl = null

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

  // —— 数据 provider ——
  disposables.push(
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

/** F12 / 右键「转到定义」：查询定义并跳转（首个目标）。 */
export async function runGoToDefinition(ed) {
  const model = ed.getModel()
  const path = pathOfModel(model)
  const position = ed.getPosition()
  if (!path || !position) return
  const locations = await findDefinition(path, model.getValue(), position)
  if (!locations.length) {
    setStatus('未找到定义')
    return
  }
  // 同一文件内交给 Monaco 原生 reveal（模型存在，光标/peek 体验更好）；跨文件自研跳转
  const first = locations[0]
  const firstPath = targetOpenPath(first)
  if (firstPath === path) {
    const action = ed.getAction('editor.action.revealDefinition')
    if (action) await action.run()
    else jumpToLocation(first)
  } else {
    jumpToLocation(first)
  }
}

/** Shift+F12 / 右键「查找所有引用」：查询引用并展示浮动面板。 */
export async function runFindReferences(ed) {
  const model = ed.getModel()
  const path = pathOfModel(model)
  const position = ed.getPosition()
  if (!path || !position) return
  const locations = await findReferences(path, model.getValue(), position, false)
  showReferencesOverlay(ed, path, position, locations)
}

/** 引用结果浮动面板（轻量 DOM，点击跳转；Esc/失焦关闭）。 */
function showReferencesOverlay(ed, path, position, locations) {
  hideReferencesOverlay()
  if (!locations.length) {
    setStatus('未找到引用')
    return
  }
  const root = ed.getDomNode()
  if (!root) return
  const el = document.createElement('div')
  el.className = 'edrv-refs'
  const header = document.createElement('div')
  header.className = 'edrv-refs-head'
  header.textContent = '引用 ' + locations.length + ' 处'
  el.appendChild(header)
  const list = document.createElement('div')
  list.className = 'edrv-refs-list'
  for (const loc of locations) {
    const row = document.createElement('div')
    row.className = 'edrv-refs-row'
    const pos = targetMonoPosition(loc)
    const rel = targetOpenPath(loc)
    const name = String(rel).split('/').pop() || rel
    row.textContent = name + ':' + pos.line + ':' + pos.column
    row.title = rel + ':' + pos.line
    row.addEventListener('click', () => {
      hideReferencesOverlay()
      jumpToLocation(loc)
    })
    list.appendChild(row)
  }
  el.appendChild(list)
  root.appendChild(el)
  overlayEl = el
  const onKey = (e) => { if (e.key === 'Escape') hideReferencesOverlay() }
  window.addEventListener('keydown', onKey)
  el.addEventListener('click', (e) => { if (e.target === el) hideReferencesOverlay() })
  el._onKey = onKey
}

export function hideReferencesOverlay() {
  if (overlayEl) {
    window.removeEventListener('keydown', overlayEl._onKey)
    overlayEl.remove()
    overlayEl = null
  }
}

/** 编辑器状态栏提示（复用 EditorView 的 status 通道）。 */
function setStatus(text) {
  window.dispatchEvent(new CustomEvent('edrv:status', { detail: { text } }))
}

/** 当前会话与语言就绪状态（供编辑器状态点）。 */
export function lspStatusDot(languageId) {
  const status = lspStatusFor(languageId)
  return status ? status.phase : 'none'
}
