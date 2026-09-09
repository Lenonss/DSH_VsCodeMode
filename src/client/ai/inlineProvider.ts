// @ts-nocheck
/**
 * dsh-vscode-mode client — AI 内联补全（ghost text）provider。
 * 速度设计：内部 150ms 去抖（Monaco 逐键调用 provider，不逐键打 LLM）、
 * 在飞取消（新请求 abort 旧的）+ 序号守卫（过期响应丢弃）、
 * 位置+前缀缓存（dismiss 后同位置重查不重复计费）、前后缀窗口裁剪。
 * 状态经 edrv:ai-status 事件广播给编辑器底部状态栏；
 * 差异审查期间静默（edrv 差异块存在时返回空，不与 Keep/Undo 浮层打架）。
 * 作者 ddj
 */
import { rpc } from '../rpc.js'
import { RPC_PATH } from '../../shared/rpc.js'
import {
  AI_PREFIX_MAX, AI_SUFFIX_MAX, inlineWorth, trimInlineWindow,
} from '../../shared/ai.js'

/**
 * 广播补全状态给编辑器底部状态栏（EditorView 监听 edrv:ai-status 渲染）。
 * @author ddj
 * @param state busy=请求中 ok=完成（detail.ms 耗时） error=失败（detail.note） idle=就绪 config=开关变化
 * @param detail 附加信息
 */
function emitAiStatus(state, detail) {
  try { window.dispatchEvent(new CustomEvent('edrv:ai-status', { detail: { state, detail } })) } catch { /* 状态广播失败不影响补全 */ }
}

/** 去抖等待（毫秒）：Monaco 逐键调用 provider，静默该时长才真正发 RPC；
 *  网关 TTFT 本身 3.5s+（debug 实证），client 侧去抖压到 150ms 不再叠加明显延迟。 */
const DEBOUNCE_MS = 150
/** 缓存容量上限（LRU 超限即整体清空；键空间小，够用）。 */
const CACHE_MAX = 30
/** 缓存 TTL（毫秒）。 */
const CACHE_TTL_MS = 60_000

let registered = false
let seq = 0
let inFlight = null
let debounceTimer = null
const cache = new Map()

/** 上次开关状态（configUpdate 后经事件刷新，关闭时立即静默）。 */
let enabled = false

/** 供设置面板保存后同步开关状态（不重载页面即时生效）。 */
export function setAiInlineEnabled(value) {
  enabled = value === true
  emitAiStatus('config', { enabled })
  if (!enabled) {
    seq += 1 // 作废在飞响应
    cache.clear()
  }
}

/** 当前开关（EditorView 装配时决定是否注册）。 */
export function aiInlineEnabled() {
  return enabled
}

/** 初始化开关（启动时从 configGet 拉一次）。 */
export async function initAiInlineState() {
  try {
    const res = await rpc('edrv.ai.configGet', {})
    setAiInlineEnabled(res?.ok && res.enabled === true)
  } catch {
    setAiInlineEnabled(false)
  }
}

/**
 * 缓存键：路径 + 行:列 + 前缀尾 24 字符（同位置不同文本区分）。
 * @author ddj
 */
function cacheKey(path, line, column, prefix) {
  return path + ':' + line + ':' + column + ':' + String(prefix || '').slice(-24)
}

/**
 * 差异审查期间静默：编辑器上存在 AI 补全应避让的 pending 差异装饰时返回 true。
 * 通过编辑器实例上的 edrv 差异装饰类名判定，缺失视为无差异。
 * @author ddj
 */
function diffPending(editor) {
  try {
    const model = editor?.getModel?.()
    const decos = model?.getAllDecorations?.() ?? []
    return decos.some((d) => String(d?.options?.className || '').includes('edrv-mn-'))
  } catch {
    return false
  }
}

/**
 * 注册 AI 内联补全 provider（幂等；Monaco 就绪后调用一次）。
 * @author ddj
 * @param monaco window.monaco
 */
export function registerAiInline(monaco) {
  if (registered || !monaco?.languages?.registerInlineCompletionsProvider) return
  registered = true
  monaco.languages.registerInlineCompletionsProvider('*', {
    async provideInlineCompletions(model, position, context, token) {
      const t0 = Date.now()
      if (!enabled || token?.isCancellationRequested) return { items: [] }
      const path = decodeURIComponent(String(model?.uri?.path || '').replace(/^\//, ''))
      if (!path || model.uri.scheme !== 'edrv') return { items: [] }
      const editor = monacoRef?.activeEditor
      if (editor && diffPending(editor)) return { items: [] }
      const offset = model.getOffsetAt(position)
      const value = model.getValue()
      const trimmed = trimInlineWindow(value.slice(0, offset), value.slice(offset))
      if (!inlineWorth(trimmed.prefix)) return { items: [] }
      const key = cacheKey(path, position.lineNumber, position.column, trimmed.prefix)
      const hit = cache.get(key)
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        return hit.items.length ? { items: hit.items } : { items: [] }
      }
      return new Promise((resolve) => {
        // 去抖：登记最新意图，静默 DEBOUNCE_MS 后才发 RPC；期间新请求顶掉旧的
        seq += 1
        const mySeq = seq
        if (inFlight) { try { inFlight.abort() } catch { /* 已结束 */ } inFlight = null }
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(async () => {
          debounceTimer = null
          if (mySeq !== seq || token?.isCancellationRequested) { resolve({ items: [] }); return }
          const controller = new AbortController()
          inFlight = controller
          emitAiStatus('busy')
          try {
            const res = await fetch(RPC_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ method: 'edrv.ai.inline', args: { path, prefix: trimmed.prefix, suffix: trimmed.suffix } }),
              signal: controller.signal,
            })
            const data = await res.json()
            if (mySeq !== seq || !data?.ok || typeof data.text !== 'string' || !data.text) {
              cache.set(key, { items: [], at: Date.now() })
              if (data?.note) emitAiStatus('error', { note: String(data.note) })
              else emitAiStatus('idle')
              resolve({ items: [] })
              return
            }
            const items = [{ insertText: data.text, range: undefined }]
            cacheSet(key, items)
            emitAiStatus('ok', { ms: Date.now() - t0 })
            resolve({ items })
          } catch (error) {
            emitAiStatus('error', { note: String(error && error.message || error).slice(0, 80) })
            resolve({ items: [] })
          } finally {
            if (inFlight === controller) inFlight = null
          }
        }, DEBOUNCE_MS)
        // 提前取消：token 取消/新请求顶替时清掉待发定时器
        const guard = setInterval(() => {
          if (mySeq !== seq || token?.isCancellationRequested) {
            clearInterval(guard)
            if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
            resolve({ items: [] })
          } else if (!debounceTimer) {
            clearInterval(guard)
          }
        }, 120)
      })
    },
    freeInlineCompletions() { /* 无资源需释放 */ },
  })
}

/** 缓存写入（超限整体清空，LRU 简化）。 */
function cacheSet(key, items) {
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(key, { items, at: Date.now() })
}

/** EditorView ref 注入口（差异静默判定用当前编辑器）。 */
let monacoRef = null

/** EditorView 装配后调用（注册 provider + 初始化开关）。 */
export function setupAiInline(monaco) {
  monacoRef = monaco && { activeEditor: null }
  if (!registered) registerAiInline(monaco)
  void initAiInlineState()
}

/** EditorView 每次创建/切换编辑器实例时刷新引用。 */
export function trackAiEditor(editor) {
  if (monacoRef) monacoRef.activeEditor = editor
}
