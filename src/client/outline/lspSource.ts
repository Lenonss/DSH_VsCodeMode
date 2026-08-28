// @ts-nocheck
/**
 * dsh-vscode-mode client — 大纲「lsp」源：经 host LSP documentSymbol 解析（优先于 monaco/fallback）。
 * LSP 服务器未就绪时返回 [] → resolveOutline 自动落入下一优先级（fallback 兜底），不阻塞面板。
 * 作者 ddj 2026-08-27
 */
import type { OutlineSource, OutlineSourceInput, OutlineSymbol } from './types.js'
import { fetchDocumentSymbols } from '../monaco/lsp/lspClient.js'

export const LSP_OUTLINE_PRIORITY = 60

/** LSP 大纲源：lua/csharp 等有 host 服务器能力的语言。 */
export function createLspOutlineSource(): OutlineSource {
  return {
    id: 'lsp',
    priority: LSP_OUTLINE_PRIORITY,
    provides: (languageId: string) => languageId === 'lua' || languageId === 'csharp',
    async get(input: OutlineSourceInput): Promise<OutlineSymbol[]> {
      const model = input.model
      if (!model || typeof model.getValue !== 'function') return []
      const path = input.path || (model.uri && model.uri.path ? decodeURIComponent(String(model.uri.path).replace(/^\//, '')) : null)
      if (!path) return []
      const symbols = await fetchDocumentSymbols(path, model.getValue())
      return (Array.isArray(symbols) ? symbols : []).map(toOutline).filter(Boolean)
    },
  }
}

/** LSP SymbolInfo（host 归一化，0-based range）→ 大纲 OutlineSymbol（1-based）。 */
function toOutline(symbol) {
  if (!symbol || typeof symbol.name !== 'string') return null
  const range = symbol.range || {}
  const sel = symbol.selectionRange || range
  const start = range.start || {}
  const select = sel.start || {}
  const out = {
    name: symbol.name,
    kind: typeof symbol.kind === 'number' ? symbol.kind : 0,
    startLine: Math.max(1, (start.line ?? 0) + 1),
    endLine: Math.max(1, ((range.end?.line ?? start.line) ?? 0) + 1),
    selectLine: Math.max(1, (select.line ?? start.line ?? 0) + 1),
  }
  if (typeof symbol.detail === 'string' && symbol.detail) out.detail = symbol.detail
  if (Array.isArray(symbol.children) && symbol.children.length) {
    const kids = symbol.children.map(toOutline).filter(Boolean)
    if (kids.length) out.children = kids
  }
  return out
}
