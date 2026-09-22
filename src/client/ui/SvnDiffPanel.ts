// @ts-nocheck
/**
 * dsh-vscode-mode client — SVN 基线差异视图（P2 的 BASE ↔ 工作区比较）。
 *
 * 实际渲染由通用 `SideBySideDiff`（F5）承担：本文件只把「基线差异」的语义
 * （BASE 侧缺失时的文案、左侧标签）映射到通用组件上，避免 Monaco 逻辑出现两份。
 * 作者 ddj 2026年09月16号
 */
import React from 'react'
import { SideBySideDiff } from './SideBySideDiff.js'

/** 无 BASE 时的说明文案（新增未提交文件的正常语义，不是错误）。 */
const NO_PRESTINE_NOTE = '该文件尚无基线版本（新增未提交的文件），无法比较'

/**
 * SVN 基线差异视图（BASE 左 / 工作区右，只读）。
 * @author ddj 2026年09月16号
 * @param props.monaco Monaco 实例（未就绪时为 null，显示加载态）
 * @param props.path 目标文件路径
 * @param props.base BASE 侧内容（null = 无 pristine）
 * @param props.working 工作区侧内容
 * @param props.reason 无 BASE 时的原因（'no-pristine' | 'cat-failed'）
 * @param props.message 补充说明文案
 * @param props.leftLabel 左侧标签（如 BASE / r12）
 * @param props.rightLabel 右侧标签（如 工作区 / r13）
 * @param props.scheme model URI scheme 前缀（区分不同来源，避免跨视图串内容）
 * @param props.binary W2-6 护栏：内容含 NUL（二进制），true 时不渲染编辑器只显示说明
 * @param props.encodingHint W2-6 护栏：内容可能非 UTF-8，显示乱码风险提示
 * @param props.onBack 返回来源视图的回调（来自日志弹窗时由 EditorView 提供）
 * @param props.onClose 关闭回调
 * @returns 差异视图元素
 */
export function SvnDiffPanel(props) {
  const { monaco, path, base, working, reason, message, leftLabel, rightLabel, onBack, onClose, binary, encodingHint } = props
  const noBase = typeof base !== 'string'
  // W2-6 护栏：二进制（NUL 嗅探）不渲染编辑器（M4 实测 cat 对二进制原样透传字节，灌进 Monaco 只会乱码）；
  // 编码提示照常渲染（U+FFFD 提示乱码风险，是否继续看由用户决定）
  const blocked = binary === true
  const guardNote = blocked
    ? '二进制文件（嗅探到 NUL 字节），无法做文本并排对比'
    : (encodingHint ? '内容可能非 UTF-8 编码，文本显示可能乱码' : '')
  const note = blocked
    ? guardNote
    : (noBase
      ? (reason === 'no-pristine' ? NO_PRESTINE_NOTE : (reason === 'not-exist' ? '该版本尚无此文件，无可比较内容' : '读取基线失败'))
      : '')
  const shownMessage = blocked ? '' : (encodingHint ? '内容可能非 UTF-8，显示可能乱码' + (message ? '；' + message : '') : message)
  return React.createElement(SideBySideDiff, {
    monaco,
    path,
    // 左侧无内容/护栏拦截时传 ''（而非 null）：仍展示差异框体，让用户看到说明
    left: blocked ? '' : (noBase ? '' : base),
    right: blocked ? '' : working,
    title: path,
    leftLabel: leftLabel || 'BASE',
    rightLabel: rightLabel || '工作区',
    emptyNote: note,
    message: shownMessage,
    scheme: props.scheme || 'edrv-svn-base',
    onBack,
    onClose,
  })
}
