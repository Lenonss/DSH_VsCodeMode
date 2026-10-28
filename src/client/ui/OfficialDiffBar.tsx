import React from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReviewDetail, ReviewItem, ReviewPage } from '../../shared/review.js'
import { ReviewLedger } from './OfficialReview.js'
import { reviewBarView } from '../reviewBar.js'
import { ReviewAllRow } from './reviewAllRow.js'

export interface OfficialBarProps {
  official: { sessionId: string; path: string; pending: number; detail?: ReviewDetail; records?: ReviewItem[]; page: ReviewPage; onSelect: (id: string) => void }
  activePath: string
  pendingRegions?: unknown[]
  staleRegions?: unknown[]
  diffIdx?: number
  /** 编辑器内容是否就绪；未就绪时不得断言差异失效 */
  contentReady?: boolean
  fileTotal?: number
  fileIdx?: number
  allPendingCount?: number
  reviewBatchBusy?: boolean
  batchUnavailable?: string
  onAcceptAllFiles?: () => void
  onUndoAllFiles?: () => void
  onPrevFile: () => void
  onNextFile: () => void
  onPrevDiff: () => void
  onNextDiff: () => void
  onAcceptFile: () => void
  onUndoFile: () => void
  onOpenLauncher: (tab: string) => void
  reviewError?: string
  reviewErrorTone?: 'info' | 'error'
}

type Mark = 'left' | 'right' | 'up' | 'down' | 'check' | 'undo' | 'more' | 'file'
const marks: Record<Mark, string> = {
  left: 'm10 4-5 4 5 4', right: 'm6 4 5 4-5 4', up: 'm4 10 4-5 4 5', down: 'm4 6 4 5 4-5',
  check: 'm3 8 3 3 7-7', undo: 'M5 3 2 6l3 3M2 6h7a4 4 0 0 1 0 8',
  more: 'M3 8h.01M8 8h.01M13 8h.01', file: 'M9 2H4v12h8V5L9 2Zm0 0v4h3M6 9h4M6 11h3',
}

/**
 * 差异栏图标：官方栏与侧车栏共用同一套 16×16 线性图标，避免两套栏外观不一致。
 * @public
 * @author ddj 2026年10月27号
 * @param mark 工具栏动作
 * @returns 装饰性一致描边图标（标签文字在按钮上）
 */
export function barIcon(mark: Mark): React.ReactElement {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={marks[mark]} /></svg>
}

/** @public @author ddj 2026年10月27号 @param props Existing review callbacks and immutable record metadata. @returns Responsive review toolbar; no disk or decision side effects until an explicit action. */
export function OfficialDiffBar(props: OfficialBarProps): React.ReactElement {
  const { official, pendingRegions = [], staleRegions = [], diffIdx = 0 } = props
  const [expanded, setExpanded] = React.useState(false)
  const [menu, setMenu] = React.useState<'records' | 'more' | null>(null)
  const name = String(props.activePath || '').split(/[\\/]/).pop() || '当前文件'
  const detail = official.detail
  const records = official.records ?? []
  const count = pendingRegions.length
  const view = reviewBarView({ jumps: count, stale: staleRegions.length, index: diffIdx, ready: props.contentReady === true,
    pendingRecords: official.pending, canKeep: detail?.capability.keep === true })

  /** @private @author ddj 2026年10月27号 @returns Close current popup without changing selection. */
  function closeMenu(): void { setMenu(null) }
  /** @private @author ddj 2026年10月27号 @param id Immutable record ID. @returns Select record and dismiss popup. */
  function selectRecord(id: string): void { official.onSelect(id); closeMenu() }
  /** @private @author ddj 2026年10月27号 @param tab Existing launcher tab. @returns Open existing overview, never create another review entry. */
  function openOverview(tab: string): void { props.onOpenLauncher(tab); closeMenu() }
  /** @private @author ddj 2026年10月27号 @param mark Navigation icon. @param label Accessible action. @param action Existing callback. @param disabled Whether navigation is unavailable. @param title Hover reason, defaults to the label. @returns Compact keyboard-focusable navigation control. */
  function navButton(mark: Mark, label: string, action: () => void, disabled: boolean, title?: string): React.ReactElement {
    return <Button size="sm" variant="ghost" className="edrv-review-icon" aria-label={label} title={title || label} disabled={disabled} onClick={action}>{barIcon(mark)}</Button>
  }

  const recordTrigger = <Button size="sm" variant="ghost" className="edrv-review-record" aria-label="选择官方差异记录" aria-haspopup="menu" aria-expanded={menu === 'records'} disabled={!records.length} onClick={() => setMenu(menu === 'records' ? null : 'records')}>
    {detail ? `轮次 ${detail.item.turn}` : '选择记录'}{barIcon('down')}
  </Button>
  const moreTrigger = <Button size="sm" variant="ghost" className="edrv-review-icon" aria-label="更多审查操作" title="更多审查操作" aria-haspopup="menu" aria-expanded={menu === 'more'} onClick={() => setMenu(menu === 'more' ? null : 'more')}>{barIcon('more')}</Button>

  return <div className="edrv-diffbar edrv-diffbar-dock edrv-reviewbar" data-edrv-diffbox="1" data-edrv-diff-source="official" role="region" aria-label="文件差异审查">
    <ReviewAllRow
      total={props.fileTotal ?? 0}
      current={(props.fileTotal ?? 0) && (props.fileIdx ?? -1) >= 0 ? (props.fileIdx ?? 0) + 1 : 0}
      busy={props.reviewBatchBusy}
      unavailable={props.batchUnavailable}
      pending={props.allPendingCount}
      onOpen={() => props.onOpenLauncher('pending')}
      onKeepAll={props.onAcceptAllFiles}
      onUndoAll={props.onUndoAllFiles}
      keepTitle="Keep 当前工作区全部待审文件（含其他轮次），不改写磁盘"
      undoTitle="检查全部待审记录后逐项 Undo；缺少证据或遇到冲突停止，不强制覆盖"
    />
    {props.reviewBatchBusy ? <div className="edrv-review-notice" role="status">正在处理全部待审记录…</div> : null}
    <div className="edrv-review-heading">
      <span className="edrv-review-filemark">{barIcon('file')}</span>
      <span className="edrv-review-filename" title={props.activePath}>{name}</span>
      <span className="edrv-review-pending" title={view.pendingTitle}>待审 <strong>{official.pending}</strong></span>
      <Menu open={menu === 'records'} anchor={recordTrigger} items={records.map((item) => ({ id: item.id, label: `轮次 ${item.turn} / 事件 ${item.seq}` }))} selectedId={detail?.item.id} onSelect={selectRecord} onClose={closeMenu} side="top" align="end" portal compact autoFocus />
    </div>
    <div className="edrv-review-tools">
      <div className="edrv-review-nav" role="group" aria-label="文件导航">
        {navButton('left', '上一个差异文件', props.onPrevFile, !props.fileTotal)}
        {navButton('right', '下一个差异文件', props.onNextFile, !props.fileTotal)}
      </div>
      <div className="edrv-review-nav edrv-review-blocknav" role="group" aria-label="差异导航">
        {navButton('up', '上一个差异', props.onPrevDiff, !count, view.navPrevTitle)}
        <span className="edrv-review-position" aria-live="polite">{view.position}</span>
        {navButton('down', '下一个差异', props.onNextDiff, !count, view.navNextTitle)}
      </div>
      <div className="edrv-review-actions">
        <Button size="sm" variant="ghost" className="edrv-review-undo" icon={barIcon('undo')} onClick={props.onUndoFile} disabled={props.reviewBatchBusy || !detail?.capability.undo} title={detail?.capability.reason}>Undo</Button>
        <Button size="sm" variant="primary" className="edrv-review-keep" icon={barIcon('check')} onClick={props.onAcceptFile} disabled={props.reviewBatchBusy || !detail?.capability.keep} title={detail?.capability.keep ? view.keepHint : detail?.capability.reason}>Keep</Button>
        <Button size="sm" variant="ghost" className="edrv-review-details" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-label={expanded ? '收起差异' : '展开差异'} title={expanded ? '收起差异' : '展开差异'}>详情{barIcon(expanded ? 'up' : 'down')}</Button>
        <Menu open={menu === 'more'} anchor={moreTrigger} items={[{ id: 'pending', label: '差异总览' }, { id: 'archive', label: '归档 / 历史' }]} onSelect={openOverview} onClose={closeMenu} side="top" align="end" portal compact autoFocus />
      </div>
    </div>
    {detail && view.notice ? <div className={view.noticeTone === 'warn' ? 'edrv-review-notice edrv-review-notice-warn' : 'edrv-review-notice'} role="status">{view.notice}</div> : null}
    {props.reviewError ? <div className={props.reviewErrorTone === 'info' ? 'edrv-review-notice' : 'edrv-review-notice edrv-review-error'} role={props.reviewErrorTone === 'info' ? 'status' : 'alert'}>{props.reviewError}</div> : null}
    {expanded ? <div className="edrv-review-body"><ReviewLedger key={`${official.sessionId}:${official.path}`} sessionId={official.sessionId} first={official.page} path={official.path} /></div> : null}
  </div>
}
