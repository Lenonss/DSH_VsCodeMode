/**
 * dsh-vscode-mode client — launch.json「添加配置」Monaco 补全 provider。
 * 仅插件专属 `.dsh/launch.json`（DAP_LAUNCH_REL）且光标位于 configurations 数组插入点
 * （或其后键入过滤词）时出条目；
 * insertText = buildInsertText（纯文本插入，不用 InsertAsSnippet——${file}/${workspaceFolder}
 * 是 DAP 运行期变量，snippet 语法会展开吞掉它们）。
 * 数据源 host edrv.dap.snippets，模块级缓存 + TTL，失败静默降级空表；
 * window 挂注销器防热重载重复注册（与 snippets/provider 同模式）。
 * 作者 ddj 2026年09月22号
 */
import { rpc } from '../rpc.js'
import { pathOfModel } from '../monaco/lsp/lspClient.js'
import { buildInsertText, findArrayPos, LAUNCH_JSON_RE } from './launchInsert.js'
import type { DapConfigSnippet } from '../../shared/dap.js'

/** 条目缓存 TTL（毫秒）：扩展清单级数据，本地小表。 */
const CACHE_TTL_MS = 10_000

/** provider 注销器全局挂点名（跨 bundle 重载存活，见 snippets/provider 同名说明）。 */
const PROVIDER_GLOBAL = '__edrvLaunchCfgProvider__'

/** 编辑器光标位置（1-based）。 */
interface SuggestPos {
  lineNumber: number
  column: number
}

/** 最小 model 形状（仅声明用到的链）。 */
interface CompletionModel {
  getValue(): string
  uri: { scheme?: string; path?: string }
  getWordUntilPosition(position: SuggestPos): { startColumn: number; endColumn: number }
}

/** 补全条目（本模块消费的子集）。 */
interface CompletionItemLike {
  label: string
  insertText: string
  filterText: string
  detail: string
  sortText: string
  documentation?: string
  kind?: number
}

/** 最小 monaco.languages 形状。 */
interface MonacoLanguagesLike {
  registerCompletionItemProvider?: (
    selector: string,
    provider: { provideCompletionItems(model: CompletionModel, position: SuggestPos): Promise<{ suggestions: CompletionItemLike[] }> },
  ) => { dispose(): void }
  CompletionItemKind?: { Snippet?: number }
}

/** 最小 monaco 形状。 */
interface MonacoLike {
  languages?: MonacoLanguagesLike
}

/** 最小 IDisposable 形状。 */
interface Disposer {
  dispose(): void
}

/** 已加载片段缓存（null = 未加载/已失效）。 */
let cache: DapConfigSnippet[] | null = null
let cacheAt = 0
let pending: Promise<DapConfigSnippet[]> | null = null
let registered = false
let disposer: Disposer | null = null

// --region 片段数据

/**
 * 读取片段（带缓存与在飞去重；失败降级空表，补全静默不打断输入）。
 * @author ddj 2026年09月22号
 * @returns 片段列表
 */
async function loadSnippets(): Promise<DapConfigSnippet[]> {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache
  if (pending) return pending
  pending = rpc('edrv.dap.snippets', {})
    .then((res) => {
      cache = res.ok && Array.isArray(res.snippets) ? res.snippets : []
      cacheAt = Date.now()
      return cache
    })
    .catch(() => {
      cache = []
      cacheAt = Date.now()
      return cache
    })
    .finally(() => {
      pending = null
    })
  return pending
}

/**
 * 预拉片段（按钮点击时提前发起 RPC，suggest 触发即有数据；调用方据此预检可用条数）。
 * @author ddj 2026年09月22号
 * @returns 片段列表（失败空表）
 */
export function prefetchSnippets(): Promise<DapConfigSnippet[]> {
  return loadSnippets()
}

// --endregion

// --region provider 装配

/**
 * 注册 launch.json 配置补全 provider（幂等；Monaco 就绪后调用一次）。
 * @author ddj 2026年09月22号
 * @param monaco window.monaco
 */
export function setupLaunchJson(monaco: MonacoLike): void {
  if (registered || !monaco?.languages?.registerCompletionItemProvider) return
  // 跨重载守卫：上一代 bundle 注册的 provider 仍在存活 window.monaco 上（注销器已落 window）
  const host = typeof window === 'undefined' ? undefined : (window as unknown as Record<string, unknown>)
  if (host && host[PROVIDER_GLOBAL]) {
    registered = true
    return
  }
  const snippetKind = monaco.languages.CompletionItemKind?.Snippet
  const kind = typeof snippetKind === 'number' ? snippetKind : undefined
  registered = true
  disposer = monaco.languages.registerCompletionItemProvider('json', {
    async provideCompletionItems(model, position) {
      return { suggestions: await suggestionsFor(model, position, kind) }
    },
  })
  // 注销器落 window：跨重载认领（见 PROVIDER_GLOBAL 说明）
  if (host) host[PROVIDER_GLOBAL] = disposer
}

/**
 * 卸载：注销 provider 并复位状态（插件热重载/卸载时调用）。
 * 兼容上一代 bundle 遗留的 window 注销器（模块级 disposer 为空时仍能清干净）。
 * @author ddj 2026年09月22号
 */
export function disposeLaunchJson(): void {
  const host = typeof window === 'undefined' ? undefined : (window as unknown as Record<string, unknown>)
  const target = (disposer && typeof disposer.dispose === 'function' ? disposer : null)
    ?? (host ? (host[PROVIDER_GLOBAL] as Disposer | undefined) ?? null : null)
  if (target && typeof target.dispose === 'function') {
    try {
      target.dispose()
    } catch {
      /* 已注销 */
    }
  }
  if (host) delete host[PROVIDER_GLOBAL]
  disposer = null
  registered = false
  cache = null
  cacheAt = 0
  pending = null
}

// --endregion

// --region 补全计算

/**
 * 计算当前光标处的配置补全条目（非 launch.json / 非插入点 / 无片段 → 空表）。
 * 光标门槛：行 = 插入行，且过滤词起点恰为插入列（既挡住误触，又允许键入过滤词）。
 * @author ddj 2026年09月22号
 * @param model Monaco 模型
 * @param position 光标位置
 * @param kind Snippet 图标 kind（monaco 枚举缺失时 undefined）
 * @returns 补全条目数组
 */
async function suggestionsFor(
  model: CompletionModel,
  position: SuggestPos,
  kind: number | undefined,
): Promise<CompletionItemLike[]> {
  const path = pathOfModel(model)
  if (!path || !LAUNCH_JSON_RE.test(path)) return []
  const pos = findArrayPos(model.getValue(), position)
  if (!pos || position.lineNumber !== pos.line) return []
  const word = model.getWordUntilPosition(position)
  if (word.startColumn !== pos.column) return []
  const snippets = await loadSnippets()
  // 可用性过滤：不可用适配器的模板不给插入（=== false 严格判断；老 host 缺字段按可用）
  const usable = snippets.filter((snip) => snip.available !== false)
  if (!usable.length) return []
  return usable.map((snip, index) => {
    const item: CompletionItemLike = {
      label: snip.label,
      // 纯文本插入（不设 insertTextRules）：DAP 变量 ${file} 等必须原样落盘
      insertText: buildInsertText(pos, snip.bodyText),
      filterText: snip.label + ' ' + snip.type + (snip.description ? ' ' + snip.description : ''),
      detail: snip.description || snip.type,
      // 空格前缀：词补全的 sortText 是词本身（'.NET' 的 '.' < '0' 会抢排模板前），
      // 0x20 空格确保配置模板恒排下拉最前并默认高亮
      sortText: ' ' + String(index).padStart(3, '0'),
      documentation: snip.bodyText,
    }
    if (kind !== undefined) item.kind = kind
    return item
  })
}

// --endregion
