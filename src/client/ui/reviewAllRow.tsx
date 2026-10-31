import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

/** 全工作区批量行输入：官方栏与侧车栏共用同一套外观与禁用语义。 */
export interface ReviewAllRowProps {
  /** 当前文件序号（1 基，0 表示未定位） */
  current: number
  /** 差异文件总数；null 表示官方元数据尚未就绪、归属还分不清，显示占位而不报个数 */
  total: number | null
  /** 批量操作进行中 */
  busy?: boolean
  /** 批量不可用原因（悬浮提示） */
  unavailable?: string
  /** 工作区待处理项总数；为 0 时两个按钮禁用 */
  pending?: number
  /** 打开差异总览 */
  onOpen: () => void
  /** 全部 Keep */
  onKeepAll?: () => void
  /** 全部 Undo */
  onUndoAll?: () => void
  /** Keep All 悬浮说明 */
  keepTitle?: string
  /** Undo All 悬浮说明 */
  undoTitle?: string
}

/**
 * 全局批量行：差异文件计数 + Keep All / Undo All。
 * 两套差异栏（官方 / 侧车）必须长得一样，否则用户会以为看到的是不同产品。
 * @public
 * @author ddj 2026年10月28号
 * @param props 计数、批量可用性与回调
 * @returns 持久化的全工作区控制条
 */
export function ReviewAllRow(props: ReviewAllRowProps): React.ReactElement {
  const known = typeof props.total === 'number'
  const total = known ? props.total as number : 0
  const current = total && props.current > 0 ? props.current : 0
  const disabled = props.busy || !!props.unavailable || !props.pending

  return <div className="edrv-review-global" role="group" aria-label="全部待审文件">
    <Button size="sm" variant="ghost" className="edrv-review-total" onClick={props.onOpen} title="打开当前工作区全部待审差异文件">差异文件 <strong>{known ? `${current} / ${total}` : '—'}</strong></Button>
    <span className="edrv-review-all-actions">
      <Button size="sm" variant="ghost" onClick={props.onKeepAll} disabled={disabled || !props.onKeepAll} title={props.unavailable || props.keepTitle || 'Keep 当前工作区全部待审文件'}>Keep All</Button>
      <Button size="sm" variant="ghost" className="edrv-review-undo" onClick={props.onUndoAll} disabled={disabled || !props.onUndoAll} title={props.unavailable || props.undoTitle || 'Undo 当前工作区全部待审文件'}>Undo All</Button>
    </span>
  </div>
}
