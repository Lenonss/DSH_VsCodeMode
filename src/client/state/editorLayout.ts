/** Workbench group layout without file-content ownership. @author ddj 2026年10月14号 */
import { normalizeTabs, pickActive, tabPathOf, type TabLike } from '../tabActions.js'

export const GROUP_LIMIT = 8
export const MAIN_GROUP = 'main'
export type Edge = 'left' | 'right' | 'top' | 'bottom'
export interface Group { id: string; tabs: TabLike[]; active: string | null }
export type LayoutNode = { group: string } | { axis: 'horizontal' | 'vertical'; ratio: number; first: LayoutNode; second: LayoutNode }
export interface FloatRect { left: number; top: number; width: number; height: number }
export interface FloatGroup extends FloatRect { group: string }
export interface EditorLayout { v: 1; tree: LayoutNode; groups: Group[]; floats: FloatGroup[]; focused: string; serial: number }
export type DropTarget = { kind: 'group'; group: string; index?: number } | { kind: 'split'; group: string; edge: Edge } | { kind: 'float'; rect: FloatRect }

// --region Layout transactions
/** @public @author ddj 2026年10月14号 @param tabs Legacy tabs. @param active Legacy selection. @returns Single-group layout. */
export function createLayout(tabs: TabLike[] = [], active: string | null = null): EditorLayout {
  return { v: 1, tree: { group: MAIN_GROUP }, groups: [{ id: MAIN_GROUP, tabs, active: pickActive(tabs, active) }], floats: [], focused: MAIN_GROUP, serial: 0 }
}

/** @public @author ddj 2026年10月14号 @param layout Workbench. @param path Normalized path. @returns Unique owning group. */
export function ownerOf(layout: EditorLayout, path: string): Group | undefined {
  return layout.groups.find((group) => group.tabs.some((tab) => tab.path === path))
}

/** @public @author ddj 2026年10月14号 @param layout Workbench. @param group Group id. @param path Optional tab selection. @returns Focused layout. */
export function focusGroup(layout: EditorLayout, group: string, path?: string): EditorLayout {
  const found = layout.groups.find((item) => item.id === group)
  if (!found) return layout
  const active = path && found.tabs.some((tab) => tab.path === path) ? path : found.active
  if (layout.focused === group && active === found.active) return layout
  return { ...layout, focused: group, groups: layout.groups.map((item) => item.id === group ? { ...item, active } : item) }
}

/** @private @author ddj 2026年10月14号 @param node Split subtree. @param group Leaf to replace. @param next Replacement. @returns Rewritten tree. */
function replaceLeaf(node: LayoutNode, group: string, next: LayoutNode): LayoutNode {
  if ('group' in node) return node.group === group ? next : node
  return { ...node, first: replaceLeaf(node.first, group, next), second: replaceLeaf(node.second, group, next) }
}

/** @private @author ddj 2026年10月14号 @param node Split subtree. @param alive Surviving ids. @returns Collapsed tree or null. */
function pruneTree(node: LayoutNode, alive: Set<string>): LayoutNode | null {
  if ('group' in node) return alive.has(node.group) ? node : null
  const first = pruneTree(node.first, alive)
  const second = pruneTree(node.second, alive)
  return first && second ? { ...node, first, second } : first ?? second
}

/** @private @author ddj 2026年10月14号 @param layout Changed layout. @returns Empty auxiliary groups removed; primary group retained. */
function compact(layout: EditorLayout): EditorLayout {
  const groups = layout.groups.filter((group) => group.id === MAIN_GROUP || group.tabs.length)
  const alive = new Set(groups.map((group) => group.id))
  return { ...layout, groups, tree: pruneTree(layout.tree, alive) ?? { group: MAIN_GROUP }, floats: layout.floats.filter((item) => alive.has(item.group)), focused: alive.has(layout.focused) ? layout.focused : MAIN_GROUP }
}

/** @private @author ddj 2026年10月14号 @param tabs Target tabs without moved tab. @param tab Moved record. @param index Requested insertion slot. @returns Pinned-partition-safe insertion. */
function insertAt(tabs: TabLike[], tab: TabLike, index = tabs.length): TabLike[] {
  const pins = tabs.filter((item) => item.pinned).length
  const at = tab.pinned ? Math.max(0, Math.min(pins, index)) : Math.max(pins, Math.min(tabs.length, index))
  return [...tabs.slice(0, at), tab, ...tabs.slice(at)]
}

/** @public @author ddj 2026年10月14号 @param layout Workbench. @param path Existing normalized file. @param target Accepted destination. @returns Atomic move; invalid target leaves original unchanged. */
export function moveTab(layout: EditorLayout, path: string, target: DropTarget): EditorLayout {
  const source = ownerOf(layout, path)
  const tab = source?.tabs.find((item) => item.path === path)
  if (!source || !tab) return layout
  if (target.kind !== 'group' && layout.groups.length >= GROUP_LIMIT) return layout
  const destination = target.kind !== 'float' ? layout.groups.find((item) => item.id === target.group) : null
  if (target.kind !== 'float' && !destination) return layout
  if (target.kind === 'split' && layout.floats.some((item) => item.group === target.group)) return layout
  const id = target.kind === 'group' ? target.group : 'group-' + (layout.serial + 1)
  let index = target.kind === 'group' ? target.index : undefined
  const oldIndex = source.tabs.findIndex((item) => item.path === path)
  if (source.id === id && index !== undefined && oldIndex < index) index -= 1
  let groups = layout.groups.map((group) => {
    const tabs = group.tabs.filter((item) => item.path !== path)
    if (group.id === id) return { ...group, tabs: insertAt(tabs, tab, index), active: path }
    return { ...group, tabs, active: pickActive(tabs, group.active) }
  })
  let tree = layout.tree
  let floats = layout.floats
  if (target.kind !== 'group') groups = [...groups, { id, tabs: [tab], active: path }]
  if (target.kind === 'float') floats = [...floats, { ...target.rect, group: id }]
  if (target.kind === 'split') {
    const before = target.edge === 'left' || target.edge === 'top'
    const old: LayoutNode = { group: target.group }
    const added: LayoutNode = { group: id }
    tree = replaceLeaf(tree, target.group, { axis: target.edge === 'left' || target.edge === 'right' ? 'horizontal' : 'vertical', ratio: 0.5, first: before ? added : old, second: before ? old : added })
  }
  return compact({ ...layout, groups, tree, floats, focused: id, serial: target.kind === 'group' ? layout.serial : layout.serial + 1 })
}

/** @public @author ddj 2026年10月14号 @param layout Workbench. @param group Auxiliary group. @returns All tabs returned to main without closing documents. */
export function returnGroup(layout: EditorLayout, group: string): EditorLayout {
  const found = layout.groups.find((item) => item.id === group)
  if (!found || group === MAIN_GROUP) return layout
  let next = layout
  for (const tab of found.tabs) next = moveTab(next, tab.path, { kind: 'group', group: MAIN_GROUP })
  return next
}

/** @public @author ddj 2026年10月14号 @param layout Workbench. @param tabs Global file records. @param active Optional newly selected file. @returns Layout reconciled with opens/closes/renames. */
export function syncTabs(layout: EditorLayout, tabs: TabLike[], active?: string | null): EditorLayout {
  const byPath = new Map(tabs.map((tab) => [tab.path, tab]))
  const groups = layout.groups.map((group) => {
    const kept = group.tabs.flatMap((tab) => byPath.has(tab.path) ? [byPath.get(tab.path)!] : [])
    return { ...group, tabs: kept, active: pickActive(kept, group.active) }
  })
  const seen = new Set(groups.flatMap((group) => group.tabs.map((tab) => tab.path)))
  const focused = groups.find((group) => group.id === layout.focused) ?? groups[0]!
  for (const tab of tabs) if (!seen.has(tab.path)) focused.tabs = insertAt(focused.tabs, tab)
  let next = compact({ ...layout, groups })
  if (active) {
    const owner = ownerOf(next, active)
    if (owner) next = focusGroup(next, owner.id, active)
  }
  return next
}
// --endregion

// --region Persistence and geometry
/** @public @author ddj 2026年10月14号 @param rect Floating bounds. @param width Viewport width. @param height Viewport height. @returns Visible, finite rectangle. */
export function clampFloat(rect: FloatRect, width: number, height: number): FloatRect {
  const w = Math.max(1, width), h = Math.max(1, height)
  const sizeW = Math.min(w, Math.max(Math.min(360, w), Number.isFinite(rect.width) ? rect.width : 600))
  const sizeH = Math.min(h, Math.max(Math.min(240, h), Number.isFinite(rect.height) ? rect.height : 400))
  return { width: sizeW, height: sizeH, left: Math.max(0, Math.min(w - sizeW, Number.isFinite(rect.left) ? rect.left : 0)), top: Math.max(0, Math.min(h - sizeH, Number.isFinite(rect.top) ? rect.top : 0)) }
}

/** @private @author ddj 2026年10月14号 @param raw Unknown tree. @param ids Available nonfloating groups. @param seen Leaf uniqueness guard. @param depth Recursion budget. @returns Valid tree or null. */
function parseTree(raw: unknown, ids: Set<string>, seen: Set<string>, depth = 0): LayoutNode | null {
  if (!raw || typeof raw !== 'object' || depth > GROUP_LIMIT) return null
  const node = raw as Record<string, unknown>
  if (typeof node.group === 'string') {
    if (!ids.has(node.group) || seen.has(node.group)) return null
    seen.add(node.group)
    return { group: node.group }
  }
  if (node.axis !== 'horizontal' && node.axis !== 'vertical') return null
  if (typeof node.ratio !== 'number' || !Number.isFinite(node.ratio)) return null
  const first = parseTree(node.first, ids, seen, depth + 1)
  const second = parseTree(node.second, ids, seen, depth + 1)
  return first && second ? { axis: node.axis, ratio: Math.max(0.1, Math.min(0.9, node.ratio)), first, second } : null
}

/** @public @author ddj 2026年10月14号 @param text Saved layout JSON. @param cwd Workspace path normalization. @returns Valid bounded layout or null for legacy fallback. */
export function parseLayout(text: string | null, cwd?: string | null): EditorLayout | null {
  if (!text) return null
  try {
    const raw = JSON.parse(text)
    if (raw?.v !== 1 || !Array.isArray(raw.groups) || !Array.isArray(raw.floats)) return null
    if (!raw.groups.length || raw.groups.length > GROUP_LIMIT) return null
    const seen = new Set<string>(), paths = new Set<string>()
    const groups: Group[] = []
    for (const item of raw.groups) {
      if (typeof item?.id !== 'string' || !item.id || seen.has(item.id)) return null
      seen.add(item.id)
      const tabs = normalizeTabs(item.tabs, cwd)
      if (tabs.some((tab) => paths.has(tab.path))) return null
      for (const tab of tabs) paths.add(tab.path)
      groups.push({ id: item.id, tabs, active: pickActive(tabs, typeof item.active === 'string' ? tabPathOf(item.active, cwd) : null) })
    }
    if (!seen.has(MAIN_GROUP)) return null
    const floats: FloatGroup[] = [], floating = new Set<string>()
    for (const item of raw.floats) {
      if (!seen.has(item?.group) || item.group === MAIN_GROUP || floating.has(item.group)) return null
      if (![item.left, item.top, item.width, item.height].every(Number.isFinite)) return null
      floating.add(item.group)
      floats.push({ group: item.group, ...clampFloat(item, 100000, 100000) })
    }
    const leaves = new Set<string>(), ids = new Set([...seen].filter((id) => !floating.has(id)))
    const tree = parseTree(raw.tree, ids, leaves)
    if (!tree || leaves.size !== ids.size) return null
    const serial = Number.isSafeInteger(raw.serial) && raw.serial >= 0 ? raw.serial : 0
    if (groups.some((group) => group.id !== MAIN_GROUP && (!/^group-\d+$/.test(group.id) || Number(group.id.slice(6)) > serial))) return null
    return compact({ v: 1, tree, groups, floats, focused: seen.has(raw.focused) ? raw.focused : MAIN_GROUP, serial })
  } catch { return null }
}
// --endregion
