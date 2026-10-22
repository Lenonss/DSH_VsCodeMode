/** File explorer fixed-height row model. @author ddj 2026年10月22号 */
import type { TreeEntry } from '../../../shared/rpc.js'
import { updateRange } from '../../ui/svnUpdateModel.js'

/** Fixed geometry shared with file and loading row CSS. */
export const TREE_ROW_HEIGHT = 24

export interface TreeRow {
  key: string
  depth: number
  e?: TreeEntry
  isDir?: boolean
  isOpen?: boolean
  text?: string
}

export interface TreeViewport {
  top: number
  height: number
}

/**
 * @public @author ddj 2026年10月22号
 * @description Preserve the first visible path when rows above it expand or collapse.
 * @param previous Previous complete model.
 * @param rows New complete model.
 * @param top Previous scroll offset.
 * @returns Anchored offset, or original offset for subsequent clamping if path disappeared.
 */
export function treeAnchorTop(previous: TreeRow[], rows: TreeRow[], top: number): number {
  const index = Math.floor(Math.max(0, top) / TREE_ROW_HEIGHT)
  const anchor = previous[index]?.key
  if (!anchor) return top
  const nextIndex = rows.findIndex((row) => row.key === anchor)
  if (nextIndex < 0) return top
  return nextIndex * TREE_ROW_HEIGHT + top % TREE_ROW_HEIGHT
}

/**
 * @public @author ddj 2026年10月22号
 * @description Flatten all expanded entries in their supplied order, including metadata files.
 * @param entriesOf Directory snapshot lookup; null means unavailable.
 * @param expanded Current directory expansion flags.
 * @param loading Current loading flags.
 * @returns Complete row model, independent of viewport mounting.
 */
export function flattenTree(entriesOf: (rel: string) => TreeEntry[] | null,
  expanded: Record<string, boolean>, loading: Record<string, boolean>): TreeRow[] {
  const rows: TreeRow[] = []
  const pending: { rel: string; depth: number; entry?: TreeEntry }[] = [{ rel: '', depth: 0 }]
  while (pending.length) {
    const current = pending.pop()!
    const entry = current.entry
    if (entry) {
      const isDir = entry.type === 'directory'
      const isOpen = expanded[entry.path] === true
      rows.push({ key: entry.path, e: entry, depth: current.depth, isDir, isOpen })
      if (isDir && isOpen) pending.push({ rel: entry.path, depth: current.depth + 1 })
      continue
    }

    const entries = entriesOf(current.rel)
    if (!entries) {
      rows.push({ key: current.rel + ':loading', depth: current.depth,
        text: loading[current.rel] ? '加载中…' : '无法加载' })
      continue
    }
    // Stack reverses insertion order; push backwards to preserve host sorting.
    for (let index = entries.length - 1; index >= 0; index--) {
      pending.push({ rel: current.rel, depth: current.depth, entry: entries[index] })
    }
  }
  return rows
}

/**
 * @public @author ddj 2026年10月22号
 * @description Clamp scroll state before reusing the existing fixed-height range calculation.
 * @param count Complete row count.
 * @param viewport Latest scroll position and measured viewport height.
 * @returns Clamped scroll offset and overscanned exclusive row range.
 */
export function treeWindow(count: number, viewport: TreeViewport) {
  const height = Math.max(0, viewport.height)
  const top = Math.min(Math.max(0, viewport.top), Math.max(0, count * TREE_ROW_HEIGHT - height))
  return { top, ...updateRange(count, top, height, TREE_ROW_HEIGHT) }
}

/**
 * @public @author ddj 2026年10月22号
 * @description Locate an unmounted row using model indices, without querying row DOM.
 * @param rows Complete flattened model.
 * @param path Requested relative file path.
 * @param viewport Current viewport geometry.
 * @returns New scroll offset, or null while ancestors/viewport are unavailable.
 */
export function treeRevealTop(rows: TreeRow[], path: string, viewport: TreeViewport): number | null {
  if (viewport.height <= 0) return null
  const index = rows.findIndex((row) => row.e?.path === path)
  if (index < 0) return null
  const current = treeWindow(rows.length, viewport).top
  const rowTop = index * TREE_ROW_HEIGHT
  if (rowTop >= current && rowTop + TREE_ROW_HEIGHT <= current + viewport.height) return current
  return treeWindow(rows.length, { top: rowTop - (viewport.height - TREE_ROW_HEIGHT) / 2,
    height: viewport.height }).top
}
