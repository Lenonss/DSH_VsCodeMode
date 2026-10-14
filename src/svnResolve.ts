import type { SvnConflictState, SvnResolveAccept } from './shared/svn.js'
import { attrOf, scanXmlTags } from './svnXml.js'

/** @public @author ddj 2026年10月14号 @param value Requested strategy. @returns Whether SVN accepts this explicit strategy. */
export function validAccept(value: unknown): value is SvnResolveAccept {
  return value === 'mine-full' || value === 'theirs-full' || value === 'working'
}

/** @public @author ddj 2026年10月14号 @param value Untrusted relative target. @returns Whether the path names exactly one non-root workspace target. */
export function validTarget(value: unknown): value is string {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f]/.test(value) || /^[A-Za-z]:|^[\\/]/.test(value)) return false
  return value.replace(/\\/g, '/').split('/').every((part) => Boolean(part) && part !== '.' && part !== '..' && part.toLowerCase() !== '.svn')
}

/** @public @author ddj 2026年10月14号 @param path Exact relative target. @returns Peg-safe SVN argument. */
export function pegTarget(path: string): string { return path.includes('@') ? path + '@' : path }

/** @public @author ddj 2026年10月14号 @param xml Verbose depth-empty status. @param path Client target identity. @returns Confirmed conflict evidence. @throws Missing or incomplete status evidence. */
export function conflictOf(xml: string, path: string): SvnConflictState {
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<status\b/.test(xml) || !/<\/status>\s*$/.test(xml)) {
    throw new Error('SVN 冲突状态输出为空或不完整，状态未确认')
  }
  const statuses = [...scanXmlTags(xml, ['wc-status'])].filter((hit) => !hit.closing)
  if (statuses.length !== 1) throw new Error('SVN 未返回唯一目标状态，状态未确认')
  const attrs = statuses[0].attrs
  const item = attrOf(attrs, 'item')
  if (!item) throw new Error('SVN 目标状态缺失，状态未确认')
  return { path, text: item === 'conflicted', props: attrOf(attrs, 'props') === 'conflicted',
    tree: attrOf(attrs, 'tree-conflicted') === 'true', versioned: !['unversioned', 'ignored', 'external', 'none'].includes(item) }
}

/** @public @author ddj 2026年10月14号 @param state Confirmed target evidence. @returns Whether any conflict remains. */
export function hasConflict(state: SvnConflictState): boolean { return state.text || state.props || state.tree }
