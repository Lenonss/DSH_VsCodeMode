/**
 * dsh-vscode-mode client — 会话级差异 dock store。
 * EditorView 发布当前编辑上下文，conversation.input.dock 唯一读取并渲染。
 * 作者 ddj 2026年08月26号
 */

/** 差异 dock 的显示形态。 */
export type DiffDockMode = 'chat' | 'editor' | 'editor-empty'

/**
 * 跨 slot 传递的差异 dock 快照。
 * 操作回调随快照一起更新，避免 dock 持有已卸载编辑器的旧闭包。
 */
export interface DiffDockSnapshot {
  mode: DiffDockMode
  layout?: 'side' | 'tab'
  [key: string]: unknown
}

/**
 * 判断编辑器差异栏应显示在指定布局，空态仅在尚有差异文件时显示。
 * @author ddj 2026年09月29号
 * @param snapshot 编辑器发布的差异快照
 * @param layout 目标布局
 * @returns 是否显示差异栏
 */
export function dockInLayout(snapshot: DiffDockSnapshot | null, layout: 'side' | 'tab'): boolean {
  if (!snapshot || (snapshot.layout ?? 'tab') !== layout) return false
  return snapshot.mode !== 'editor-empty' || Boolean(snapshot.fileTotal)
}

type DiffDockListener = () => void
type DiffDockSource = object

const values = new Map<string, DiffDockSnapshot>()
const sources = new Map<string, DiffDockSource>()
const listeners = new Map<string, Set<DiffDockListener>>()

/** 通知指定会话的 dock 订阅者。 */
function notifyDiff(sessionId: string): void {
  for (const listener of listeners.get(sessionId) ?? []) listener()
}

/**
 * 发布指定会话的最新编辑器差异上下文。
 * @author ddj 2026年08月26号
 * @param sessionId 会话 id
 * @param snapshot 完整 DiffBox 操作上下文
 * @param source 发布者令牌，用于卸载时防止误清理新实例
 */
export function publishDiffDock(sessionId: string, snapshot: DiffDockSnapshot, source?: DiffDockSource): void {
  values.set(sessionId, snapshot)
  if (source) sources.set(sessionId, source)
  else sources.delete(sessionId)
  notifyDiff(sessionId)
}

/**
 * 清除指定会话的差异上下文。
 * @author ddj 2026年08月26号
 * @param sessionId 会话 id
 * @param source 可选发布者令牌；不匹配时忽略清理
 */
export function clearDiffDock(sessionId: string, source?: DiffDockSource): void {
  if (source && sources.get(sessionId) !== source) return
  values.delete(sessionId)
  sources.delete(sessionId)
  notifyDiff(sessionId)
}

/**
 * 读取指定会话的最新上下文。
 * @author ddj 2026年08月26号
 * @param sessionId 会话 id
 * @returns 最新上下文或 null
 */
export function readDiffDock(sessionId?: string): DiffDockSnapshot | null {
  if (!sessionId) return null
  return values.get(sessionId) ?? null
}

/**
 * 订阅指定会话的上下文变化。
 * @author ddj 2026年08月26号
 * @param sessionId 会话 id
 * @param listener 变化回调
 * @returns 取消订阅函数
 */
export function subscribeDiffDock(sessionId: string, listener: DiffDockListener): () => void {
  let bucket = listeners.get(sessionId)
  if (!bucket) {
    bucket = new Set()
    listeners.set(sessionId, bucket)
  }
  bucket.add(listener)
  return () => {
    bucket!.delete(listener)
    if (!bucket!.size) listeners.delete(sessionId)
  }
}
