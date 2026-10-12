/** Small vector overlays over official file-type icons. @author ddj 2026年10月09号 */
import React from 'react'
import type { SvnExplorerMark, SvnViewMark } from '../../shared/svnExplorer.js'
/** @public @author ddj 2026年10月10号 @param row Compact mark. @returns Overlay description; stale evidence never renders a green check. */
export function viewOverlayOf(row?: SvnViewMark): SvnExplorerMark | null {
  if (!row?.kind || (row.stale && row.kind === 'clean')) return null
  const names = { clean: '本地正常（不表示仓库无更新）', modified: '本地修改', conflict: '冲突或阻塞',
    added: '新增', deleted: '删除或缺失', unversioned: '未受控', ignored: '忽略', external: '外部引用' }
  return { kind: row.kind, title: names[row.kind] + (row.count ? '；子项 ' + row.count + ' 处变更' : '')
    + (row.stale ? '；状态陈旧，等待确认' : '') }
}
const SIGNS = { clean: '✓', modified: '!', conflict: '×', added: '+', deleted: '−', unversioned: '?', ignored: '·', external: '↗' }

/** @public @author ddj 2026年10月09号 @param mark Confirmed local mark. @param remote Remote changed-item count. @returns Accessible vector overlay; remote arrow coexists with local conflict. */
export function svnOverlayEl(mark: SvnExplorerMark | null, remote: number): React.ReactElement | null {
  if (!mark && !remote) return null
  const title = 'SVN ' + (mark?.title ?? '本地状态未确认') + (remote ? '；仓库有可更新内容（' + remote + ' 项）' : '')
  const svg = mark ? React.createElement('svg', { viewBox: '0 0 12 12', width: 12, height: 12, 'aria-hidden': true },
    React.createElement('circle', { cx: 6, cy: 6, r: 5.5, fill: 'currentColor' }),
    React.createElement('text', { x: 6, y: 9, textAnchor: 'middle', fill: '#fff', fontSize: 9, fontFamily: 'Arial, sans-serif', fontWeight: 700 }, SIGNS[mark.kind])) : null
  return React.createElement('span', { className: 'edrv-svn-overlay', title, 'aria-label': title, role: 'img' },
    mark ? React.createElement('span', { className: 'edrv-svn-local edrv-svn-icon-' + mark.kind }, svg) : null,
    remote ? React.createElement('span', { className: 'edrv-svn-remote', 'aria-hidden': true }, '↓') : null)
}
