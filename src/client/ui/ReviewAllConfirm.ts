import React from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

interface ReviewAllProps {
  reject: boolean
  count: number
  onCancel: () => void
  onConfirm: () => void
}

/**
 * @public
 * @author ddj 2026年10月27号
 * @description Confirm workspace-wide review through the DSH modal; dismissing never applies a decision.
 * @param props Pending file count, action and explicit confirmation callbacks.
 * @returns DSH-themed confirmation with distinct Keep and Undo safety descriptions.
 */
export function ReviewAllConfirm(props: ReviewAllProps): React.ReactElement {
  const action = props.reject ? 'Undo All' : 'Keep All'
  const warning = props.reject
    ? '撤销会改写磁盘；逐项安全校验，遇到冲突停止，已完成项不会自动恢复。'
    : '只标记待审修改为保留，不改写文件。'
  const footer = React.createElement(React.Fragment, null,
    React.createElement(Button, { variant: 'ghost', onClick: props.onCancel, autoFocus: true }, '取消'),
    React.createElement(Button, { variant: 'primary', onClick: props.onConfirm }, '确认 ' + action))

  return React.createElement(Modal, {
    open: true,
    title: action + ' 确认',
    closeLabel: '取消',
    onClose: props.onCancel,
    description: `处理当前工作区全部 ${props.count} 个待审差异文件（含其他轮次）？`,
    footer,
  }, React.createElement('p', null, warning))
}
