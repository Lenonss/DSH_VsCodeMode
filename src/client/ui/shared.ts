// @ts-nocheck
/**
 * dsh-vscode-mode client — UI 共用小工具（按钮样式/状态文案/等宽字体）。
 * 迁移自原 src/client/index.ts 的 btn/badgeOf/MONO，语义不改。
 * 作者 ddj 2026-08-20
 */
import { ST } from '../state/records.js'

/** 次级按钮内联样式（accept=true 绿色 / false 红色）。 */
export function btn(accept) {
  return {
    fontSize: 11,
    padding: '1px 8px',
    border: '1px solid var(--dsw-alias-border-l2,#555)',
    borderRadius: 4,
    cursor: 'pointer',
    background: 'var(--dsw-alias-bg-layer-1,transparent)',
    color: accept ? 'var(--dsw-alias-state-success-primary,#2e9e44)' : 'var(--dsw-alias-state-error-primary,#d9534f)',
  }
}

/** 状态中文文案。 */
export function badgeOf(status) {
  return status === ST.ACCEPTED ? '已采纳' : status === ST.REJECTED ? '已拒绝' : '待处理'
}

/** 等宽字体常量（差异行渲染用）。 */
export const MONO = { fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)', fontSize: 12, lineHeight: 1.55 }
