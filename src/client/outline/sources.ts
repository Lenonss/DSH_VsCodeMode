// @ts-nocheck
/**
 * dsh-vscode-mode client — 大纲源注册表 + 内置数据源（monaco / fallback）。
 * 解析规则：按优先级降序遍历源，首个非空结果生效；全空 → 空态。
 * monaco 源吃 Monaco 原生 document symbol provider（ts/json/css/html 与未来
 * 第三方注册的 provider）；fallback 源兜底无内置提供方的语言（parse.ts）。
 * 注册表对外 provide 为 edrvOutlineSources，第三方语言插件可注册更高优先级源。
 * 作者 ddj 2026-08-27
 */
import type { OutlineSourceRegistry, OutlineSource, OutlineSourceInput, OutlineSymbol } from './types.js'
import { parseOutline } from './parse.js'

/** Monaco 原生有 document symbol provider 的语言（无需 fallback）。 */
export const OUTLINE_MONACO_LANGS = new Set([
  'typescript', 'javascript', 'json', 'jsonc', 'css', 'scss', 'less', 'html',
])

/** 无内置 provider、由 parse.ts 兜底的语言。 */
export const OUTLINE_FALLBACK_LANGS = new Set([
  'markdown', 'mdx', 'python', 'shell', 'powershell', 'lua', 'go', 'rust',
  'yaml', 'ini', 'c', 'cpp', 'csharp', 'java', 'php', 'ruby', 'kotlin',
  'swift', 'dart',
])

/**
 * 创建生命周期独立的大纲源注册表。
 * @author ddj 2026年08月27号
 * @returns 大纲源注册表
 */
export function createOutlineSourceRegistry(): OutlineSourceRegistry {
  const entries = new Map<string, OutlineSource>()
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  const list = (): readonly OutlineSource[] =>
    [...entries.values()].sort((a, b) => (b.priority - a.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {
    register(source: OutlineSource): () => void {
      if (!source || !source.id || typeof source.get !== 'function') throw new TypeError('大纲源必须提供 id 与 get')
      entries.set(source.id, source)
      notify()
      return () => {
        if (entries.get(source.id) !== source) return
        entries.delete(source.id)
        notify()
      }
    },
    list,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: (id: string) => entries.get(id),
  }
}

/** 归一化 Monaco OutlineElement（getTopLevelSymbols 产物）→ OutlineSymbol。 */
function normalizeMonaco(el): OutlineSymbol | null {
  if (!el || typeof el.name !== 'string') return null
  const range = el.range || {}
  const sel = el.selectionRange || range
  const startLine = Math.max(1, Number(sel.startLineNumber ?? range.startLineNumber ?? 1))
  const endLine = Math.max(1, Number(range.endLineNumber ?? startLine))
  const out: OutlineSymbol = {
    name: el.name,
    kind: typeof el.kind === 'number' ? el.kind : 0,
    startLine: Math.max(1, Number(range.startLineNumber ?? startLine)),
    endLine,
    selectLine: startLine,
  }
  if (typeof el.detail === 'string' && el.detail) out.detail = el.detail
  if (Array.isArray(el.children) && el.children.length) {
    const kids = el.children.map(normalizeMonaco).filter(Boolean)
    if (kids.length) out.children = kids
  }
  return out
}

/**
 * 按优先级解析大纲符号：首个非空结果生效（出错源跳过，落入下一优先级）。
 * @author ddj 2026年08月27号
 * @param sources 大纲源注册表
 * @param input 当前快照（languageId/model/editor/monaco）
 * @returns 归一化符号树（无符号时为空数组）
 */
export async function resolveOutline(sources: OutlineSourceRegistry, input: OutlineSourceInput): Promise<OutlineSymbol[]> {
  for (const source of sources.list()) {
    let supports = false
    try { supports = source.provides(input.languageId) } catch { supports = false }
    if (!supports) continue
    let items: OutlineSymbol[] | null = null
    try { items = await source.get(input) } catch { items = null }
    if (items && items.length) return items
  }
  return []
}

/**
 * 注册内置大纲源（monaco=50 / fallback=30）。
 * @author ddj 2026年08月27号
 * @param registry 目标注册表
 * @returns 注销函数（同时注销全部内置源）
 */
export function registerBuiltinOutlineSources(registry: OutlineSourceRegistry): () => void {
  const disposers = [
    registry.register({
      id: 'monaco',
      priority: 50,
      provides: () => true,
      async get(input: OutlineSourceInput): Promise<OutlineSymbol[]> {
        const ed = input.editor
        const model = input.model
        const cmd = ed?._commandService
        if (!cmd || typeof cmd.executeCommand !== 'function') return []
        const uri = model?.uri
        if (!uri) return []
        const list = await cmd.executeCommand('_executeDocumentSymbolProvider', uri)
        return Array.isArray(list) ? list.map(normalizeMonaco).filter(Boolean) : []
      },
    }),
    registry.register({
      id: 'fallback',
      priority: 30,
      provides: (languageId: string) => OUTLINE_FALLBACK_LANGS.has(languageId),
      async get(input: OutlineSourceInput): Promise<OutlineSymbol[]> {
        const model = input.model
        if (!model || typeof model.getValue !== 'function') return []
        return parseOutline(input.languageId, model.getValue())
      },
    }),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
