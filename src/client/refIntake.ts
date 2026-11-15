// @ts-nocheck
/**
 * dsh-vscode-mode client — 引用接入：把「拖文件 / 粘贴文件 / 粘贴 @路径」变成对话引用 chip。
 *
 * 设计要点：
 * 1. **同步判定、异步解析**：浏览器的 preventDefault 必须在事件回调里同步调用，而路径解析
 *    要走 host（`edrv.resolveRef`）。因此回调里只用 payload 形态做同步判断（是否带自定义
 *    MIME、是否以 `@` 开头的引用文本、是否带了非图片文件），确认要接管后立即 preventDefault，
 *    再去异步解析并插入；解析失败时回退成纯文本，绝不吞掉用户的粘贴内容。
 * 2. **只在 composer 内生效**：以官方 `[data-composer-seat]` 为锚点，普通输入框/终端/其他
 *    插件里的拖拽与粘贴完全不受影响。
 * 3. **插入走既有通道**：统一用 addToConversation.appendReference（保 chip、忙态自动降级），
 *    不自己拼草稿文本，避免销毁用户已插入的引用。
 * 4. **多实例只让最后一个生效**：编辑器可能在侧栏/浮窗多处挂载，用 owner 栈保证一次粘贴
 *    只插入一份引用。
 *
 * @author ddj 2026年11月15号
 */
import { parseRef } from '../shared/refSyntax.js'
import { featurePrefs } from './featurePrefs.js'

/** 官方 composer 座位选择器（DSH 会话输入区锚点）。 */
export const COMPOSER_SEAT = '[data-composer-seat]'
/** 资源管理器拖拽携带的内部 MIME（JSON：{ path, range? }）。 */
export const DRAG_MIME = 'text/x-edrv-path'
/** 单次最多插入的引用数（防止整目录拖拽刷屏）。 */
export const MAX_INSERT_REFS = 5

/** 接入依赖（由 EditorView 提供，避免本模块直接依赖 ctx）。 */
export interface RefIntakeDeps {
  /** 当前会话 id（无会话时返回 undefined）。 */
  sessionId: () => string | undefined
  /** 当前活动文件（多义时的同目录优先）。 */
  activePath: () => string | null
  /** 插入引用 chip。 */
  appendReference: (sessionId: string | undefined, path: string, range?: unknown) => Promise<string>
  /** 插入纯文本（解析失败时的回退，保住用户粘贴内容）。 */
  appendText: (sessionId: string | undefined, text: string) => Promise<string>
  /** 解析路径片段（host edrv.resolveRef）。 */
  resolve: (ref: string, activePath?: string | null) => Promise<{ ok: boolean; path?: string; ambiguous?: string[]; error?: string }>
  /** 轻提示（失败/多义时用，不用于成功）。 */
  notify: (text: string) => void
}

/** 生效中的接入实例栈（最后挂载者优先）。 */
const owners = []

/**
 * 事件目标是否位于 composer 座位内。
 * @author ddj 2026年11月15号
 * @param target 事件目标
 * @returns 是否命中 composer
 */
export function insideComposer(target) {
  const element = target instanceof Element ? target : target?.parentElement
  if (!element) return false
  try {
    return element.closest(COMPOSER_SEAT) !== null
  } catch (error) {
    return false
  }
}

/**
 * 从拖拽载荷里取内部引用项（自定义 MIME 优先）。
 * @author ddj 2026年11月15号
 * @param dataTransfer 拖拽数据
 * @returns 解析出的引用项（path 必填，range 可空）
 */
export function dragRefItems(dataTransfer) {
  const items = []
  try {
    const raw = dataTransfer?.getData?.(DRAG_MIME) ?? ''
    if (raw) {
      const parsed = JSON.parse(raw)
      const path = String(parsed?.path ?? '').trim()
      if (path) items.push({ path, range: parsed?.range ?? undefined })
    }
  } catch (error) { /* 非法 JSON 当作没有 */ }
  const files = dataTransfer?.files
  if (files && files.length > 0) {
    for (const file of Array.from(files)) {
      const name = String(file?.name ?? '').trim()
      if (name) items.push({ path: name, range: undefined })
    }
  }
  return items.slice(0, MAX_INSERT_REFS)
}

/**
 * 拖拽载荷是否值得接管（同步判定，供 dragover/drop 提前 preventDefault）。
 * @author ddj 2026年11月15号
 * @param dataTransfer 拖拽数据
 * @returns 是否接管
 */
export function isRefDrop(dataTransfer) {
  try {
    const types = Array.from(dataTransfer?.types ?? [])
    return types.includes(DRAG_MIME) || types.includes('Files')
  } catch (error) {
    return false
  }
}

/**
 * 粘贴内容是否应转成引用（同步判定）。
 * @author ddj 2026年11月15号
 * @param clipboard 剪贴板数据
 * @returns 'ref'（@路径文本）| 'file'（非图片文件）| null（放行原生粘贴）
 */
export function pasteIntent(clipboard) {
  if (!clipboard) return null
  const text = String(clipboard.getData?.('text/plain') ?? '').trim()
  if (text.startsWith('@')) return 'ref'
  const files = clipboard.files
  if (files && files.length > 0) {
    const nonImage = Array.from(files).filter((file) => !String(file?.type ?? '').startsWith('image/'))
    if (nonImage.length > 0) return 'file'
  }
  return null
}

/**
 * 插入一组引用；返回实际插入数量（0 表示全部失败）。
 * @author ddj 2026年11月15号
 * @param deps 接入依赖
 * @param items 引用项（path 可为绝/相对/裸文件名，range 可空）
 * @param fallbackText 失败时回填的纯文本（paste 场景用；drop 场景传空串）
 * @returns 插入数量
 * @sideEffects 写会话草稿
 */
async function insertItems(deps, items, fallbackText) {
  const sessionId = deps.sessionId()
  const activePath = deps.activePath()
  let inserted = 0
  let ambiguous = false
  for (const item of items) {
    const resolved = await deps.resolve(item.path, activePath)
    if (!resolved || resolved.ok !== true || !resolved.path) continue
    if (Array.isArray(resolved.ambiguous) && resolved.ambiguous.length > 0) {
      ambiguous = true
      deps.notify('同名文件较多，未能确定引用：' + item.path)
      continue
    }
    const outcome = await deps.appendReference(sessionId, resolved.path, item.range)
    if (outcome === 'ok' || outcome === 'busy') inserted += 1
  }
  if (inserted === 0 && fallbackText) await deps.appendText(sessionId, fallbackText)
  if (inserted === 0 && items.length > 0 && !fallbackText && !ambiguous) deps.notify('未能在工作区内找到对应文件')
  return inserted
}

/**
 * 挂载引用接入（返回解绑函数）。
 * @author ddj 2026年11月15号
 * @param deps 接入依赖
 * @returns 解绑函数（移除全部监听并退出 owner 栈）
 */
export function attachRefIntake(deps) {
  const owner = { deps }
  owners.push(owner)
  const active = () => owners[owners.length - 1]

  /** @private @author ddj 2026年11月15号 @param event 拖拽事件 @returns void */
  const onDragOver = (event) => {
    if (!featurePrefs().refIntake) return
    if (!insideComposer(event.target)) return
    if (!isRefDrop(event.dataTransfer)) return
    event.preventDefault()
    try { event.dataTransfer.dropEffect = 'copy' } catch (error) { /* 只读实现忽略 */ }
  }

  /** @private @author ddj 2026年11月15号 @param event 放置事件 @returns void */
  const onDrop = (event) => {
    if (!featurePrefs().refIntake) return
    if (!insideComposer(event.target)) return
    if (!isRefDrop(event.dataTransfer)) return
    const items = dragRefItems(event.dataTransfer)
    // 同步拦截：否则浏览器会把拖入的文件当导航打开
    event.preventDefault()
    event.stopPropagation()
    if (!items.length) return
    void insertItems(active().deps, items, '')
  }

  /** @private @author ddj 2026年11月15号 @param event 粘贴事件 @returns void */
  const onPaste = (event) => {
    if (!featurePrefs().refIntake) return
    if (!insideComposer(event.target)) return
    const intent = pasteIntent(event.clipboardData)
    if (intent === null) return
    const text = String(event.clipboardData?.getData?.('text/plain') ?? '')
    const parsed = intent === 'ref' ? parseRef(text) : null
    const files = event.clipboardData?.files
    const items = parsed
      ? [{ path: parsed.path, range: parsed.range }]
      : Array.from(files ?? []).map((file) => ({ path: String(file?.name ?? ''), range: undefined })).filter((item) => item.path)
    if (!items.length) return
    // 同步拦截后异步插入；解析失败回退纯文本，内容不丢
    event.preventDefault()
    event.stopPropagation()
    void insertItems(active().deps, items.slice(0, MAX_INSERT_REFS), intent === 'ref' ? text : '')
  }

  document.addEventListener('dragover', onDragOver, true)
  document.addEventListener('drop', onDrop, true)
  document.addEventListener('paste', onPaste, true)
  return () => {
    document.removeEventListener('dragover', onDragOver, true)
    document.removeEventListener('drop', onDrop, true)
    document.removeEventListener('paste', onPaste, true)
    const index = owners.indexOf(owner)
    if (index >= 0) owners.splice(index, 1)
  }
}
