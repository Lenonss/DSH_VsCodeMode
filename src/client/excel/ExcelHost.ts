/** React boundary that materializes the Excel engine chunk on demand. @author ddj 2026年11月10号 */
import React from 'react'
import { mountExcel } from './mountExcel.js'
import type { ExcelState } from './controller.js'

interface ExcelHostProps { state: ExcelState; path: string; cwd?: string }
interface HostView { status: 'loading' | 'ready' | 'failed'; error?: string }

/** @public @author ddj 2026年11月10号 @param props Shared controller, file path and owning workspace. @returns Loading/retry status inside the stable engine mount node. */
export function ExcelHost(props: ExcelHostProps): React.ReactElement {
  const hostRef = React.useRef<HTMLElement | null>(null)
  const [attempt, retry] = React.useState(0)
  const [view, setView] = React.useState<HostView>({ status: 'loading' })

  /** @private @author ddj 2026年11月10号 @returns Cleanup stopping late status writes after unmount. */
  function mountEffect(): () => void {
    let active = true
    setView({ status: 'loading' })
    const host = hostRef.current
    if (host) {
      void mountExcel(host, props.state, props.path, props.cwd).then(
        () => { if (active) setView({ status: 'ready' }) },
        (error) => { if (active) setView({ status: 'failed', error: String(error) }) },
      )
    }
    return () => { active = false }
  }
  React.useEffect(mountEffect, [props.state, props.path, props.cwd, attempt])

  /** @private @author ddj 2026年11月10号 @description Explicit retry; a failed chunk request never loops automatically. */
  function onRetry(): void { retry(attempt + 1) }

  const status = view.status === 'failed'
    ? React.createElement('div', { className: 'edrv-empty', role: 'alert' }, view.error,
      React.createElement('button', { onClick: onRetry }, '重试'))
    : view.status === 'loading'
      ? React.createElement('div', { className: 'edrv-empty', role: 'status' }, '正在加载表格引擎…')
      : null
  return React.createElement('div', { className: 'edrv-excel-host', ref: hostRef }, status)
}
