// @ts-nocheck
/**
 * dsh-vscode-mode client — 代码片段补全 provider（Monaco IntelliSense）。
 * 数据源：host snippets.entries（全局 ~/.dsh/snippets + 当前工作区 <工作区>/.dsh/snippets），
 * 条目按 model 语言过滤（language 空串 = 全语言）；条目主体交给 Monaco 片段语法解析
 * （${1:占位} / $TM_FILENAME 等由 InsertAsSnippet 规则展开）。
 * 性能：条目模块级缓存 + TTL，不在每次按键打 RPC（与 ai/inlineProvider 的去抖策略异曲同工，
 * 但片段是本地小表，缓存足矣）；edrv:snippets-changed（配置文件保存后）强制失效。
 * 作者 ddj 2026年09月10号
 */
import { rpc } from '../rpc.js'

/** 条目缓存 TTL（毫秒）：片段文件本就只在用户编辑时变化。 */
const CACHE_TTL_MS = 10_000

/** 补全候选上限（超大片段库下防拖慢渲染）。 */
const MAX_ITEMS = 200

/** 已加载条目缓存（null = 未加载/已失效）。 */
let cache = null
let cacheAt = 0
let pending = null
let registered = false
let disposer = null

/**
 * 片段 provider 注销器的全局挂点名。
 *
 * 为什么挂 window：`window.monaco` 由 loader 注入后**跨插件重载存活**，而模块级
 * registered/disposer 会随 bundle 重新求值复位 —— 只判 registered 会在每次重载后
 * 重复注册补全 provider（同一编辑器出现重复候补）。故注销器落 window 供跨代认领与清理。
 * @author ddj 2026年09月18号
 */
const SNIPPET_GLOBAL = '__edrvSnippetsDisposer__'

/** 当前会话 id（补全按会话工作区叠加项目片段；EditorView 装配时注入）。 */
let sessionId = null

/**
 * 设置当前会话（会话切换时更新；缓存一并失效，使项目片段跟随工作区）。
 * @author ddj 2026年09月10号
 * @param id 会话 id
 */
export function setSnippetsSession(id) {
  if (sessionId === id) return
  sessionId = id
  invalidateSnippets()
}

/**
 * 失效条目缓存（配置文件保存/会话切换后调用）。
 * @author ddj 2026年09月10号
 */
export function invalidateSnippets() {
  cache = null
  cacheAt = 0
  pending = null
}

/**
 * 读取条目（带缓存与在飞去重）；失败返回空表（补全静默降级，不打断输入）。
 * @author ddj 2026年09月10号
 * @returns 片段条目数组
 */
async function loadEntries() {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache
  if (pending) return pending
  pending = rpc('snippets.entries', { sessionId })
    .then((res) => {
      const entries = res && res.ok && Array.isArray(res.entries) ? res.entries : []
      cache = entries
      cacheAt = Date.now()
      return entries
    })
    .catch(() => {
      cache = []
      cacheAt = Date.now()
      return cache
    })
    .finally(() => { pending = null })
  return pending
}

/**
 * 按语言过滤条目：条目语言为空（全语言）或与 model 语言一致即命中。
 * 项目片段（scope=project）排在全局之后去重，同名同前缀时项目优先。
 * @author ddj 2026年09月10号
 * @param entries 全部条目
 * @param languageId 当前模型语言
 * @returns 生效条目（项目优先，已去重）
 */
export function entriesForLanguage(entries, languageId) {
  const lang = String(languageId ?? '').toLowerCase()
  const global = []
  const project = []
  for (const entry of entries) {
    const entryLang = String(entry?.language ?? '').toLowerCase()
    if (entryLang && entryLang !== lang) continue
    if (entry?.scope === 'project') project.push(entry)
    else global.push(entry)
  }
  // 项目条目覆盖同 key 的全局条目（工作区定制优先）
  const projectKeys = new Set(project.map((entry) => entry.key))
  const merged = global.filter((entry) => !projectKeys.has(entry.key)).concat(project)
  return merged.slice(0, MAX_ITEMS)
}

/**
 * 注册代码片段补全 provider（幂等；Monaco 就绪后调用一次）。
 * @author ddj 2026年09月10号
 * @param monaco window.monaco
 */
export function registerSnippetProvider(monaco) {
  if (registered || !monaco?.languages?.registerCompletionItemProvider) return
  // 跨重载守卫：上一代 bundle 注册的 provider 仍在存活 window.monaco 上（注销器已落 window）
  const host = /* @__PURE__ */ (typeof window === 'undefined' ? undefined : window)
  if (host && host[SNIPPET_GLOBAL]) {
    registered = true
    return
  }
  const snippetKind = monaco.languages.CompletionItemKind?.Snippet
  const asSnippet = monaco.languages.CompletionItemInsertTextRule?.InsertAsSnippet
  // 缺少片段枚举（精简版 Monaco）时不注册：否则候选项会退化为纯文本插入，误导用户
  if (typeof snippetKind !== 'number' || typeof asSnippet !== 'number') return
  registered = true
  disposer = monaco.languages.registerCompletionItemProvider('*', {
    async provideCompletionItems(model, position) {
      const entries = await loadEntries()
      if (!entries.length) return { suggestions: [] }
      const items = entriesForLanguage(entries, model?.getLanguageId?.())
      if (!items.length) return { suggestions: [] }
      const word = model.getWordUntilPosition(position)
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      }
      return {
        suggestions: items.map((entry) => ({
          label: entry.prefix || entry.key,
          // 无前缀条目不经键入触发（靠「插入代码片段」命令使用），补全里不展示空标签
          insertText: entry.body,
          detail: (entry.scope === 'project' ? '项目片段 · ' : '全局片段 · ') + entry.file,
          documentation: entry.description || entry.key,
          kind: snippetKind,
          insertTextRules: asSnippet,
          filterText: entry.prefix || entry.key,
          range,
        })).filter((item) => Boolean(item.label)),
      }
    },
  })
  // 注销器落 window：跨重载认领（见 SNIPPET_GLOBAL 说明）
  if (host) host[SNIPPET_GLOBAL] = disposer
}

/**
 * 装配：Monaco 就绪后注册 provider（幂等）。
 * @author ddj 2026年09月10号
 * @param monaco window.monaco
 */
export function setupSnippets(monaco) {
  registerSnippetProvider(monaco)
}

/**
 * 卸载：注销 provider 并复位状态（插件热重载/卸载时调用）。
 * 兼容上一代 bundle 遗留的 window 注销器（模块级 disposer 为空时仍能清干净）。
 * @author ddj 2026年09月10号 / 2026年09月18号
 */
export function disposeSnippets() {
  const host = /* @__PURE__ */ (typeof window === 'undefined' ? undefined : window)
  const target = (typeof disposer === 'function' ? disposer : null) ?? (host ? host[SNIPPET_GLOBAL] : null)
  if (target && typeof target.dispose === 'function') {
    try { target.dispose() } catch { /* 已注销 */ }
  }
  if (host) delete host[SNIPPET_GLOBAL]
  disposer = null
  registered = false
  invalidateSnippets()
}

/**
 * 读取可插入条目（「插入代码片段」命令用；含无前缀条目）。
 * @author ddj 2026年09月10号
 * @param languageId 当前模型语言（缺省返回全语言 + 该语言条目）
 * @returns 生效条目数组
 */
export async function listSnippetsFor(languageId) {
  const entries = await loadEntries()
  if (!languageId) return entries.slice(0, MAX_ITEMS)
  return entriesForLanguage(entries, languageId)
}
