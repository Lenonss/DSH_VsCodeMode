/**
 * dsh-vscode-mode client — Monaco model 跨挂载缓存（按工作区作用域）。
 * 编辑区每会话重挂载会销毁实例，但文件 model（内容）与工作区绑定：
 * 按作用域把 model 缓存在模块级，重挂载后 loadContent 命中缓存同步种出内容，
 * 消除切换对话时的加载闪烁。切换作用域时释放上一作用域未附着编辑器的模型
 * （附着中的仅移出缓存，交由编辑器自身生命周期，防正在显示的模型被销毁）。
 * 纯对象容器逻辑，不依赖 monaco，可单测。
 * 作者 ddj 2026-09-09
 */

// --region 常量与状态

/** 单作用域缓存上限（超出按写入序逐出最旧，近似 LRU）。 */
export const MODEL_CACHE_CAP = 40

/** scope →（path → model）缓存表。 */
const caches = new Map<string, Map<string, unknown>>()
/** 当前激活作用域（切换时释放上一个）。 */
let activeScope: string | null = null
// --endregion

/** 模型是否仍附着在某个编辑器实例上（缺方法视为未附着）。 */
function isAttached(model: unknown): boolean {
  const fn = (model as { isAttachedToEditor?: () => boolean } | null)?.isAttachedToEditor
  return typeof fn === 'function' ? fn.call(model) === true : false
}

/** 释放模型（仅未附着编辑器时真正 dispose；附着中的保留给编辑器自毁）。 */
function disposeIfFree(model: unknown): void {
  if (!model || isAttached(model)) return
  try { (model as { dispose: () => void }).dispose() } catch { /* 已释放/异常忽略 */ }
}

/**
 * 取（或切）某作用域的 model 缓存：同作用域重复调用复用同一 Map（跨挂载存活）；
 * 作用域变化时释放上一作用域的模型（未附着的 dispose，附着中的仅移出缓存）。
 * @author ddj 2026年09月09号
 * @param scope 作用域键（scopeStore.workspaceScopeOf 产物）
 * @returns 该作用域的 path → model Map
 */
export function modelsForScope(scope: string): Map<string, unknown> {
  const existing = caches.get(scope)
  if (existing && activeScope === scope) return existing
  if (activeScope !== null && activeScope !== scope) {
    const prev = caches.get(activeScope)
    if (prev) {
      for (const model of prev.values()) disposeIfFree(model)
      prev.clear()
      caches.delete(activeScope)
    }
  }
  activeScope = scope
  if (existing) return existing
  const map = new Map<string, unknown>()
  caches.set(scope, map)
  return map
}

/**
 * 记入模型并刷新 LRU 序（先删后插保证最新），超上限逐出最旧（未附着才 dispose）。
 * @author ddj 2026年09月09号
 * @param map 作用域缓存 Map
 * @param path 工作区相对路径
 * @param model Monaco model（或测试桩）
 */
export function rememberModel(map: Map<string, unknown>, path: string, model: unknown): void {
  if (!path || !model) return
  map.delete(path)
  map.set(path, model)
  while (map.size > MODEL_CACHE_CAP) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    const evicted = map.get(oldest)
    map.delete(oldest)
    disposeIfFree(evicted)
  }
}
