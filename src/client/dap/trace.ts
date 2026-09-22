/**
 * dsh-vscode-mode client — DAP 调试链路诊断 trace。
 * 仅写入 window 环形 buffer，诊断失败绝不影响调试流程。
 * 作者 ddj 2026年09月29号
 */

/**
 * 写入 DAP 调试诊断事件。
 * @author ddj 2026年09月29号
 * @param event 事件名
 * @param data 诊断数据（不包含凭据）
 */
export function dapTrace(event: string, data?: unknown): void {
  try {
    if (typeof window === 'undefined') return
    const target = window as unknown as { __DSH_DEBUG_LOG__?: Array<Record<string, unknown>> }
    const buffer = (target.__DSH_DEBUG_LOG__ = target.__DSH_DEBUG_LOG__ || [])
    buffer.push({ t: Date.now(), plugin: 'dsh-vscode-mode', event: 'dap.' + event, data })
    if (buffer.length > 500) buffer.splice(0, buffer.length - 500)
    console.info('[dsh:dap-debug]', event, data ?? '')
  } catch { /* 诊断失败不能干扰调试 */ }
}
