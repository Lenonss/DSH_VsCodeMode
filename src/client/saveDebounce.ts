/**
 * dsh-vscode-mode client — 防抖保存槽（纯逻辑，可单测）。
 *
 * 存在意义（真实缺陷，勿把「取消」与「保存」再合并回一个句柄）：
 * 自动保存由 `schedule(fn, 700)` 承载，而 `schedule` = `ctx.timeout(fn, ms)` 的返回值是
 * **cordis disposer**（只 `clearTimeout`，不执行 fn）。旧实现把定时器句柄直接存下，并在
 * 「切页签 / 关闭文件 / 卸载」时调用它来「立即保存」—— 实际只取消了这一轮保存，
 * 于是 700ms 防抖窗口内的编辑**既不落盘也不再重试**，静默丢改动
 * （实测：改文件后 150ms 内关闭页签，磁盘仍是旧内容）。
 *
 * 故把「取消」与「立即提交」拆成两个明确入口：
 * - `arm()`   重新计时（先取消上一轮，到点自动执行）
 * - `flush()` 立即执行待提交的保存（先取消定时器防重复，再执行回调体）
 * - `cancel()` 纯取消（确实要放弃时才用）
 *
 * 作者 ddj 2026年09月11号
 */

/** 定时器调度器（EditorView 传入 ctx.timeout 包装；返回值为 canceller）。 */
export type Scheduler = (fn: () => void, ms: number) => (() => void) | undefined

/** 防抖保存槽句柄。 */
export interface SaveTimer {
  /** 重新计时：取消上一轮并挂新定时器（到点自动执行并清槽）。 */
  arm(schedule: Scheduler, delay: number, run: () => void): void
  /** 立即提交待执行的保存（无待提交时为空操作）；幂等。 */
  flush(): void
  /** 纯取消（不保存）。 */
  cancel(): void
  /** 当前是否有待提交的保存。 */
  isPending(): boolean
}

/**
 * 创建防抖保存槽。
 * @author ddj 2026年09月11号
 * @returns 保存槽句柄
 */
export function createSaveTimer(): SaveTimer {
  let pending: { cancel?: () => void; run: () => void } | null = null
  return {
    arm(schedule, delay, run) {
      if (pending) { pending.cancel?.(); pending = null }
      const cancel = schedule(() => {
        // 到点：先清槽再执行，避免回调内 flush 重入同一份保存
        pending = null
        run()
      }, delay)
      pending = { cancel: typeof cancel === 'function' ? cancel : undefined, run }
    },
    flush() {
      const slot = pending
      if (!slot) return
      pending = null
      // 先取消定时器再执行：否则到点后会重复保存一次
      slot.cancel?.()
      slot.run()
    },
    cancel() {
      const slot = pending
      if (!slot) return
      pending = null
      slot.cancel?.()
    },
    isPending() {
      return pending !== null
    },
  }
}
