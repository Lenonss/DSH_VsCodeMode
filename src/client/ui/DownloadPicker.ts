/**
 * dsh-vscode-mode client — 「下载到本机」确认框（仅远程访问时由右键菜单打开）。
 *
 * 形态：ModalShell 居中卡片 + 懒加载目录树 + 文件勾选。产品决策是「不打包」：
 * 这里只收集勾选，由调用方（downloadFile.ts）逐个下载原文件。
 *
 * 目录节点只负责展开、不带勾选框：勾选粒度是文件，避免半选目录的语义歧义；
 * 「全选」只覆盖已展开（已加载）的文件，不会为了全选把整棵树拉一遍。
 * 样式见 editor.css 的 `[data-edrv-view] .edrv-dl-*`；本组件不新建 portal，
 * 因此自动满足 tests/overlayScope.test.ts 的 data-edrv-view 契约。
 * 作者 ddj 2026年11月03号
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { rpc } from '../rpc.js'
import type { TreeEntry } from '../../shared/rpc.js'
import { ModalShell } from './ModalShell.js'
import {
  clearSelected, collapseDir, createDlState, expandDir, formatSize, hasLoaded, isOversized, markError, markLoading,
  mergeChildren, rowList, selectLoaded, selectedFiles, toggleFile,
} from '../downloadPickerModel.js'
import type { DlRow, DlState } from '../downloadPickerModel.js'

/** 弹窗属性：只做「选文件」这件事，下载编排由调用方负责。 */
export interface DownloadPickerProps {
  /** 弹窗根：工作区相对路径；'' = 整个工作区。 */
  root: string
  /** 会话 id（工作区解析用）。 */
  sessionId?: string
  /** 取消（Esc / 遮罩 / 取消按钮）。 */
  onClose: () => void
  /** 确认：传勾选的文件路径（至少 1 个）。 */
  onConfirm: (paths: string[]) => void
}

/**
 * 「下载到本机」确认框。
 * @author ddj 2026年11月03号
 * @param props 弹窗属性
 * @returns 弹窗元素
 */
export function DownloadPicker(props: DownloadPickerProps): React.ReactElement {
  const { root, sessionId, onClose, onConfirm } = props
  const [state, setState] = React.useState<DlState>(() => createDlState(root))
  const aliveRef = React.useRef(true)

  React.useEffect(() => () => { aliveRef.current = false }, [])

  /**
   * 拉取某目录一层子项（懒加载的唯一入口）。
   * @author ddj 2026年11月03号
   * @param dirPath 目录路径（'' = 工作区根）
   */
  const loadDir = React.useCallback(async (dirPath: string): Promise<void> => {
    setState((prev) => markLoading(prev, dirPath))
    try {
      const args = sessionId ? { sessionId, path: dirPath } : { path: dirPath }
      const out = await rpc('edrv.listDir', args)
      if (!aliveRef.current) return
      if (!out.ok) {
        setState((prev) => markError(prev, dirPath, out.error))
        return
      }
      setState((prev) => mergeChildren(prev, dirPath, out.entries))
    } catch (error) {
      if (!aliveRef.current) return
      setState((prev) => markError(prev, dirPath, textOfError(error)))
    }
  }, [sessionId])

  React.useEffect(() => { void loadDir(root) }, [loadDir, root])

  /**
   * 展开 / 收起目录；首次展开才发 listDir。
   * @author ddj 2026年11月03号
   * @param path 目录路径
   */
  function onToggleDir(path: string): void {
    const expanded = state.expanded.has(path)
    setState((prev) => (expanded ? collapseDir(prev, path) : expandDir(prev, path)))
    if (expanded || hasLoaded(state, path) || state.loading.has(path)) return
    void loadDir(path)
  }

  /**
   * 勾选 / 取消勾选单个文件。
   * @author ddj 2026年11月03号
   * @param path 文件路径
   */
  function onToggleFile(path: string): void {
    setState((prev) => toggleFile(prev, path))
  }

  const rows = rowList(state)
  const picked = selectedFiles(state)
  const empty = hasLoaded(state, root) && rows.length === 0 && !state.loading.has(root)

  /**
   * 单行渲染（目录出三角、文件出勾选框；超限文件置灰不可勾）。
   * @author ddj 2026年11月03号
   * @param row 行数据
   * @returns 行元素
   */
  function renderRow(row: DlRow): React.ReactElement {
    const indent = { paddingLeft: 6 + row.depth * 14 }
    if (row.kind === 'directory') return renderDirRow(row, indent, onToggleDir, loadDir)
    return renderFileRow(row, indent, onToggleFile)
  }

  return React.createElement(ModalShell, {
    dialogClass: 'edrv-dl-dialog',
    width: 'min(640px, calc(100vw - 40px))',
    onClose,
  },
    React.createElement('h3', null, '下载到本机'),
    React.createElement('div', { className: 'edrv-dl-sub' }, root ? '/' + root : '工作区根目录'),
    renderTree({ state, root, rows, empty, loadDir, renderRow, onToggleDir, onToggleFile }),
    renderFoot({
      picked,
      rows,
      onSelectAll: () => setState(selectLoaded),
      onClear: () => setState(clearSelected),
      onClose,
      onConfirm,
    }),
  )
}

/** 目录树区域属性（全部由组件传入，渲染函数本身不持有状态）。 */
interface TreeOpts {
  state: DlState
  root: string
  rows: DlRow[]
  empty: boolean
  loadDir: (dirPath: string) => Promise<void>
  renderRow: (row: DlRow) => React.ReactElement
  onToggleDir: (path: string) => void
  onToggleFile: (path: string) => void
}

/**
 * 目录树区域：行列表 + 根加载态 + 根错误重试 + 空态。
 * @author ddj 2026年11月03号
 * @param opts 树区域属性
 * @returns 树区域元素
 */
function renderTree(opts: TreeOpts): React.ReactElement {
  const { state, root, rows, empty, loadDir, renderRow } = opts
  return React.createElement('div', { className: 'edrv-dl-tree' },
    rows.length ? rows.map(renderRow) : null,
    state.loading.has(root) ? React.createElement('div', { className: 'edrv-dl-hint' }, '加载中…') : null,
    state.errors.has(root) ? renderRetry(root, state.errors.get(root) || '', loadDir) : null,
    empty ? React.createElement('div', { className: 'edrv-dl-hint' }, '此文件夹内没有可下载的文件') : null,
  )
}

/** 底栏属性：已选数量、批量勾选动作与确认/取消回调。 */
interface FootOpts {
  picked: string[]
  rows: DlRow[]
  onSelectAll: () => void
  onClear: () => void
  onClose: () => void
  onConfirm: (paths: string[]) => void
}

/**
 * 底栏：已选数量 + 全选已展开 / 清空 / 取消 / 下载。
 * @author ddj 2026年11月03号
 * @param opts 底栏属性
 * @returns 底栏元素
 */
function renderFoot(opts: FootOpts): React.ReactElement {
  const { picked, rows, onSelectAll, onClear, onClose, onConfirm } = opts
  return React.createElement('div', { className: 'edrv-dl-foot' },
    React.createElement('span', { className: 'edrv-dl-count' }, '已选 ' + picked.length + ' 个文件'),
    React.createElement('button', { type: 'button', disabled: !rows.length, onClick: onSelectAll }, '全选已展开'),
    React.createElement('button', { type: 'button', disabled: !picked.length, onClick: onClear }, '清空'),
    React.createElement('button', { type: 'button', onClick: onClose }, '取消'),
    React.createElement('button', {
      type: 'button',
      className: 'edrv-dl-go',
      disabled: !picked.length,
      onClick: () => onConfirm(picked),
    }, '下载 ' + picked.length + ' 个文件'),
  )
}

/**
 * 目录行：三角展开 / 收起，名称后带加载或错误提示。
 * @author ddj 2026年11月03号
 * @param row 行数据
 * @param indent 缩进样式
 * @param onToggle 展开回调
 * @param retry 重试加载回调
 * @returns 目录行元素
 */
function renderDirRow(
  row: DlRow,
  indent: React.CSSProperties,
  onToggle: (path: string) => void,
  retry: (path: string) => Promise<void>,
): React.ReactElement {
  // 整行可点（三角与名称都展开），避免只有三角能点导致误以为无子项
  return React.createElement('div', {
    key: row.path,
    className: 'edrv-dl-row is-dir',
    style: indent,
    onClick: () => onToggle(row.path),
  },
    React.createElement('span', { className: 'edrv-dl-twist' }, row.expanded ? '▾' : '▸'),
    React.createElement('span', { className: 'edrv-dl-name edrv-dl-dir' }, row.name),
    row.loading ? React.createElement('span', { className: 'edrv-dl-hint' }, '加载中…') : null,
    row.error ? renderRetry(row.path, row.error, retry) : null,
  )
}

/**
 * 文件行：勾选框 + 名称 + 体积；超限文件禁用勾选并标注原因。
 * @author ddj 2026年11月03号
 * @param row 行数据
 * @param indent 缩进样式
 * @param onToggle 勾选回调
 * @returns 文件行元素
 */
function renderFileRow(
  row: DlRow,
  indent: React.CSSProperties,
  onToggle: (path: string) => void,
): React.ReactElement {
  const oversized = isOversized(row.size)
  return React.createElement('div', { key: row.path, className: 'edrv-dl-row', style: indent },
    React.createElement('input', {
      type: 'checkbox',
      checked: row.checked,
      disabled: oversized,
      onChange: () => onToggle(row.path),
    }),
    React.createElement('span', { className: 'edrv-dl-name', onClick: () => onToggle(row.path) }, row.name),
    oversized
      ? React.createElement('span', { className: 'edrv-dl-size is-large' }, '超过 32MB')
      : (typeof row.size === 'number' ? React.createElement('span', { className: 'edrv-dl-size' }, formatSize(row.size)) : null),
  )
}

/**
 * 错误行 + 重试按钮（保留主机错误原文）。
 * @author ddj 2026年11月03号
 * @param path 目录路径
 * @param message 错误原文
 * @param retry 重试回调
 * @returns 提示行元素
 */
function renderRetry(path: string, message: string, retry: (path: string) => Promise<void>): React.ReactElement {
  return React.createElement('div', { key: 'err:' + path, className: 'edrv-dl-hint is-error' },
    React.createElement('span', null, message),
    React.createElement('button', {
      type: 'button',
      onClick: (event: React.MouseEvent) => {
        // 错误行嵌在目录行内，重试不应顺带切换该目录的展开态
        event.stopPropagation()
        void retry(path)
      },
    }, '重试'),
  )
}

/**
 * 挂载弹窗：临时宿主 + createRoot，关闭时卸载并移除（与工作区选择弹窗同一范式）。
 * @author ddj 2026年11月03号
 * @param opts 根目录 / 会话 / 确认回调
 * @sideEffects 向 body 追加一个宿主节点，关闭时移除
 */
export function openDownloader(opts: { root: string; sessionId?: string; onConfirm: (paths: string[]) => void }): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const mount = createRoot(host)

  function close(): void {
    mount.unmount()
    host.remove()
  }

  function confirm(paths: string[]): void {
    close()
    opts.onConfirm(paths)
  }

  mount.render(React.createElement(DownloadPicker, {
    root: opts.root,
    sessionId: opts.sessionId,
    onClose: close,
    onConfirm: confirm,
  }))
}

/**
 * 错误可读文案（Error.message 优先，其余 String 化）。
 * @author ddj 2026年11月03号
 * @param error 捕获值
 * @returns 提示文案
 */
function textOfError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
