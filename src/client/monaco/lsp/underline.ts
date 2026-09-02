// @ts-nocheck
/**
 * dsh-vscode-mode client — Ctrl+hover 可导航标识符下划线提示。
 * 背景：内嵌 Monaco 构建（0.42.0-dev）无 linkDetection contrib，原生不产生 ctrl+hover 下划线，
 * 插件自绘：Ctrl/Meta 按住悬停在"语义 token 标识符"上时给词加下划线装饰，移出/松开即清除。
 * 数据来源于语义 token（每 model+version 缓存 60s），不做逐词 LSP 查询。
 * 作者 ddj 2026-09-02
 */
import { pathOfModel, fetchSemanticTokens } from './lspClient.js'
import { decodeSemanticTokens, isNavigableTokenType } from '../../../shared/lsp.js'

const CACHE_TTL_MS = 60_000

/**
 * 给一个 Monaco 编辑器绑定 Ctrl+hover 下划线提示（幂等）。
 * @author ddj 2026年09月02号
 * @param ed Monaco 编辑器
 * @param monaco Monaco 实例
 */
export function bindLspUnderline(ed, monaco) {
  if (!ed || !monaco || ed.__edrvUnderline) return
  ed.__edrvUnderline = true
  let decoIds = []
  let lastKey = null
  let hoverSeq = 0
  let cache = { path: null, version: -1, ranges: null, at: 0 }

  const clear = () => {
    if (decoIds.length) {
      ed.deltaDecorations(decoIds, [])
      decoIds = []
    }
    lastKey = null
  }

  /** 取当前文档语义 token 范围（模型版本 + TTL 缓存）。 */
  const rangesOf = async (model) => {
    const path = pathOfModel(model)
    const version = model.getVersionId?.() ?? 0
    if (cache.path === path && cache.version === version && cache.ranges && Date.now() - cache.at < CACHE_TTL_MS) {
      return cache.ranges
    }
    const res = await fetchSemanticTokens(path, model.getValue()).catch(() => null)
    const ranges = res && Array.isArray(res.data) ? decodeSemanticTokens(res.data) : []
    cache = { path, version, ranges, at: Date.now() }
    return ranges
  }

  ed.onMouseMove((event) => {
    const native = event?.event
    const ctrl = native?.ctrlKey ?? false
    const meta = native?.metaKey ?? false
    if (!ctrl && !meta) {
      clear()
      hoverSeq++
      return
    }
    const pos = event?.target?.position
    const model = ed.getModel()
    if (!pos || !model) {
      clear()
      hoverSeq++
      return
    }
    const word = model.getWordAtPosition(pos)
    if (!word) {
      clear()
      hoverSeq++
      return
    }
    const seq = ++hoverSeq
    const path = pathOfModel(model)
    void rangesOf(model).then((ranges) => {
      if (seq !== hoverSeq) return // 鼠标已移走，忽略过期结果
      const lineIndex = Math.max(0, word.startLineNumber - 1)
      const startCol = Math.max(0, word.startColumn - 1)
      const endCol = Math.max(startCol, word.endColumn - 1)
      const hit = ranges.some((r) => {
        if (r.start.line !== lineIndex) return false
        return isNavigableTokenType(r.type) && r.start.character <= startCol && r.end.character >= endCol
      })
      if (!hit) {
        if (lastKey !== null) clear()
        return
      }
      const key = String(path) + ':' + word.startColumn + ':' + word.endColumn
      if (key === lastKey) return
      lastKey = key
      decoIds = ed.deltaDecorations(decoIds, [{
        range: new monaco.Range(word.startLineNumber, word.startColumn, word.endLineNumber, word.endColumn),
        options: { inlineClassName: 'edrv-nav-underline' },
      }])
    })
  })

  ed.onMouseLeave(() => clear())
  ed.onDidBlurEditorText?.(() => clear())
}

/** 兼容占位（与 providers 的 hideReferencesOverlay 对称，无需真正释放）。 */
export function disposeLspUnderline() {}
