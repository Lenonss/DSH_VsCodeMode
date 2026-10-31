import React from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { callIdAttr } from '../state/records.js'
import { SIDECAR_KEEP_TITLE, SIDECAR_LABEL, SIDECAR_LABEL_TITLE, SIDECAR_UNDO_TITLE, reviewBarView } from '../reviewBar.js'
import type { OfficialDownView } from '../reviewBar.js'
import { barIcon } from './OfficialDiffBar.js'
import { ReviewAllRow } from './reviewAllRow.js'
import { badgeOf } from './shared.js'

/** 侧车差异区域：由 records 派生的行范围，不含官方块元数据。 */
export interface SidecarRegion {
  callId: string
  idx: number
  start?: number
  end?: number
  oldLines?: string[]
  newLines?: string[]
  create?: boolean
  status?: string
}

/** 侧车栏输入：字段与官方栏对齐，缺的是官方记录元数据，多的是侧车区域的 keep/undo 能力。 */
export interface SidecarBarProps {
  activePath?: string
  missingDeletion?: boolean
  pendingRegions?: SidecarRegion[]
  staleRegions?: SidecarRegion[]
  diffIdx?: number
  /** 编辑器内容是否就绪；未就绪时不得断言差异失效 */
  contentReady?: boolean
  fileIdx?: number
  /** 待审文件总数；null 表示官方元数据尚未就绪，栏内显示占位 */
  fileTotal?: number | null
  allPendingCount?: number
  reviewBatchBusy?: boolean
  /** 官方元数据通道失败时的可操作提示 */
  officialDown?: OfficialDownView
  onRetryOfficial?: () => void
  onAcceptFile: () => void
  onUndoFile: () => void
  onAcceptAllFiles: () => void
  onUndoAllFiles: () => void
  onPrevFile: () => void
  onNextFile: () => void
  onPrevDiff: () => void
  onNextDiff: () => void
  onOpenLauncher: (tab: string) => void
  onJump?: (region: SidecarRegion) => void
  onRollback?: () => void
  onRefresh?: () => void
  reviewError?: string
  reviewErrorTone?: 'info' | 'error'
}

/**
 * 侧车（历史捕获）差异栏：与官方栏同一套版式、同一套按钮位置，只把数据源与标识换掉。
 * 两套栏并存是数据现实，但外观不能分家，否则用户会以为插件版本不一致。
 * @public
 * @author ddj 2026年10月28号
 * @param props 侧车区域计数、批量可用性与回调
 * @returns 与官方栏同构的差异工具栏；展开后列出侧车区域
 */
export function SidecarDiffBar(props: SidecarBarProps): React.ReactElement {
  const pendingRegions = props.pendingRegions ?? []
  const staleRegions = props.staleRegions ?? []
  const [menu, setMenu] = React.useState<'more' | null>(null)
  const name = String(props.activePath || '').split(/[\\/]/).pop() || '当前文件'
  const count = pendingRegions.length
  const total = count + staleRegions.length
  const busy = props.reviewBatchBusy === true
  const canDecide = total > 0 && !busy
  const view = reviewBarView({
    jumps: count, stale: staleRegions.length, index: props.diffIdx ?? 0,
    ready: props.contentReady === true, pendingRecords: total, canKeep: true,
  })
  const down = props.officialDown

  /** @private @author ddj 2026年10月28号 @param tab 既有总览页签 @returns 打开既有总览并收起菜单 */
  function openOverview(tab: string): void { props.onOpenLauncher(tab); setMenu(null) }

  /** @private @author ddj 2026年10月28号 @param mark 工具栏图标 @param label 无障碍名称 @param action 既有回调 @param disabled 是否禁用 @param title 禁用原因 @returns 紧凑导航按钮 */
  function navButton(mark: Parameters<typeof barIcon>[0], label: string, action: () => void, disabled: boolean, title?: string): React.ReactElement {
    return <Button size="sm" variant="ghost" className="edrv-review-icon" aria-label={label} title={title || label} disabled={disabled} onClick={action}>{barIcon(mark)}</Button>
  }

  const moreTrigger = <Button size="sm" variant="ghost" className="edrv-review-icon" aria-label="更多审查操作" title="更多审查操作" aria-haspopup="menu" aria-expanded={menu === 'more'} onClick={() => setMenu(menu === 'more' ? null : 'more')}>{barIcon('more')}</Button>

  return <div className="edrv-diffbar edrv-diffbar-dock edrv-reviewbar" data-edrv-diffbox="1" data-edrv-diff-source="sidecar" role="region" aria-label="文件差异审查">
    <ReviewAllRow
      total={props.fileTotal ?? null}
      current={(props.fileTotal ?? 0) && (props.fileIdx ?? -1) >= 0 ? (props.fileIdx ?? 0) + 1 : 0}
      busy={busy}
      pending={props.allPendingCount}
      onOpen={() => props.onOpenLauncher('pending')}
      onKeepAll={props.onAcceptAllFiles}
      onUndoAll={props.onUndoAllFiles}
      keepTitle="把这批历史改动全部标记为已看过（只改记录，不动磁盘文件）"
      undoTitle="逐项撤销这些历史改动；缺少证据或遇到冲突即停止"
    />
    {props.missingDeletion ? <div className="edrv-review-notice" role="status">文件已删除 · 展示最后记录快照。Keep 保留删除；Undo 恢复展示的完整快照。</div> : null}
    {busy ? <div className="edrv-review-notice" role="status">正在处理历史改动…</div> : null}
    {down ? <div className="edrv-review-notice edrv-review-notice-warn edrv-sidecar-down" role="status">
      <span className="edrv-sidecar-down-text">{down.text}</span>
      {props.onRetryOfficial ? <Button size="sm" variant="ghost" onClick={props.onRetryOfficial} title="重新读取官方待审记录">{down.retryLabel || '重试'}</Button> : null}
    </div> : null}
    <div className="edrv-review-heading">
      <span className="edrv-review-filemark">{barIcon('file')}</span>
      <span className="edrv-review-filename" title={props.activePath}>{name}</span>
      <span className="edrv-review-source" title={SIDECAR_LABEL_TITLE}>{SIDECAR_LABEL}</span>
      <span className="edrv-review-pending" title={view.pendingTitle}>待审 <strong>{total}</strong></span>
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
        <Button size="sm" variant="ghost" className="edrv-review-undo" icon={barIcon('undo')} onClick={props.onUndoFile} disabled={!canDecide} title={props.missingDeletion ? '恢复展示的完整历史快照（不会覆盖重新出现的文件）' : SIDECAR_UNDO_TITLE}>Undo</Button>
        <Button size="sm" variant="primary" className="edrv-review-keep" icon={barIcon('check')} onClick={props.onAcceptFile} disabled={!canDecide} title={props.missingDeletion ? '保持文件删除并结清覆盖的待审历史记录，不写文件' : SIDECAR_KEEP_TITLE}>Keep</Button>
        <Menu open={menu === 'more'} anchor={moreTrigger} items={[{ id: 'pending', label: '差异总览' }, { id: 'archive', label: '归档 / 历史' }, { id: 'rollback', label: '回滚当前文件' }, { id: 'refresh', label: '刷新' }]} onSelect={(id: string) => {
          if (id === 'rollback') { setMenu(null); props.onRollback?.(); return }
          if (id === 'refresh') { setMenu(null); props.onRefresh?.(); return }
          openOverview(id)
        }} onClose={() => setMenu(null)} side="top" align="end" portal compact autoFocus />
      </div>
    </div>
    {view.notice ? <div className={view.noticeTone === 'warn' ? 'edrv-review-notice edrv-review-notice-warn' : 'edrv-review-notice'} role="status">{view.notice}</div> : null}
    {props.reviewError ? <div className={props.reviewErrorTone === 'info' ? 'edrv-review-notice' : 'edrv-review-notice edrv-review-error'} role={props.reviewErrorTone === 'info' ? 'status' : 'alert'}>{props.reviewError}</div> : null}
  </div>
}
