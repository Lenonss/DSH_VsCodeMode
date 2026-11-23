/**
 * dsh-vscode-mode client — 侧栏正文错误边界：把编辑器子树里的异常就地收住。
 *
 * 背景：编辑器正文由官方侧栏的 `sidebar.right.pane.tab` slot 承载，插件在组件里抛错时
 * slot 宿主会整片替换成空白（用户看到的是「右侧面板一片白」，对话和审批跟着看不见）。
 * 可选服务读取（如 DSH 0.2.3 起需要 inject 的 `uiSession.sessionStatus`）是最常见的触发点，
 * 但根因不一定由本模块负责：本边界只保证「一处异常不吞掉整片侧栏」，并给出可重试的提示。
 * 只收渲染/生命周期（含 useEffect）异常；事件回调与异步回调里的异常不在其职责内。
 * 作者 ddj 2026年11月23号
 */
import React from 'react'

/** 错误边界输入（无自有属性，纯隔离层）。 */
export interface SideTabBoundaryProps { children?: React.ReactNode }

/** 错误边界状态（仅记录导致子树卸载的错误）。 */
interface SideTabBoundaryState { error: Error | null }

/**
 * 侧栏正文错误边界。
 * @author ddj 2026年11月23号
 * @param props 受隔离的子树
 * @returns 正常子树，或带「重试」的就地错误面板
 */
export class SideTabBoundary extends React.Component<SideTabBoundaryProps, SideTabBoundaryState> {
  state: SideTabBoundaryState = { error: null }

  /**
   * 记录子树异常并渲染兜底面板。
   * @author ddj 2026年11月23号
   * @param error 渲染/生命周期异常
   * @returns 兜底状态
   */
  static getDerivedStateFromError(error: Error): SideTabBoundaryState {
    return { error }
  }

  /**
   * 原地重建子树（不清其他界面状态）。
   * @author ddj 2026年11月23号
   */
  private retry = (): void => {
    this.setState({ error: null })
  }

  /**
   * 渲染子树或兜底面板。
   * @author ddj 2026年11月23号
   * @returns 子元素或错误提示
   */
  render(): React.ReactNode {
    if (!this.state.error) return this.props.children ?? null
    return React.createElement('div', { className: 'edrv-empty', role: 'alert' },
      React.createElement('div', null, '文件编辑器渲染失败：' + String(this.state.error.message)),
      React.createElement('div', { style: { fontSize: 12, opacity: 0.75, maxWidth: 420, lineHeight: 1.6 } },
        '右侧面板已被就地隔离，对话与审批不受影响。点「重试」可重建编辑器。'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', onClick: this.retry }, '重试'))
  }
}
