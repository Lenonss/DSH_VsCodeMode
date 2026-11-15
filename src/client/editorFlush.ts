// @ts-nocheck
/**
 * dsh-vscode-mode client — 全局替换前的「落盘桥」。
 *
 * 为什么必须先落盘：替换直接在磁盘上改文本，如果编辑器里还有未保存的脏缓冲，
 * 替换读到的就是旧内容，写回后会把用户的改动**静默丢掉**；反过来，盘上先落盘后，
 * 已打开页签变干净，替换完由既有外部改动同步链路自动重载，不会弹「外部已修改」冲突条。
 *
 * 协议：派发 `edrv:flush-all` 窗口事件，detail 提供 `register(name, promise)`；
 * 每个挂载中的编辑器把「提交全部待保存」的 promise 注册进来，本模块等待全部完成。
 *
 * @author ddj 2026年11月15号
 */

/** 落盘事件名（EditorView 监听）。 */
export const FLUSH_ALL_EVENT = 'edrv:flush-all'
/** 等待上限：超时即认为无法保证落盘顺序，调用方应中止破坏性操作。 */
export const FLUSH_ALL_TIMEOUT_MS = 3000

/**
 * 请求所有编辑器提交待保存内容。
 * @author ddj 2026年11月15号
 * @param timeoutMs 等待上限（毫秒）
 * @returns 结果：failures 为超时/失败的落盘方；timedOut 表示未能在上限内完成
 */
export function flushEditors(timeoutMs = FLUSH_ALL_TIMEOUT_MS) {
  if (typeof window === 'undefined') return Promise.resolve({ failures: [], timedOut: false })
  const tasks = []
  const failures = []
  const detail = {
    /**
     * 注册一个落盘任务。
     * @param name 落盘方标签（失败提示用）
     * @param promise 落盘完成 promise
     */
    register(name, promise) {
      const label = String(name ?? 'editor')
      tasks.push(Promise.resolve(promise).catch((error) => { failures.push(label) }))
    },
  }
  try {
    window.dispatchEvent(new CustomEvent(FLUSH_ALL_EVENT, { detail }))
  } catch (error) {
    return Promise.resolve({ failures: [], timedOut: false })
  }
  if (!tasks.length) return Promise.resolve({ failures, timedOut: false })
  let timer = null
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  return Promise.race([Promise.all(tasks).then(() => 'done'), deadline]).then((status) => {
    if (timer !== null) clearTimeout(timer)
    return { failures, timedOut: status === 'timeout' }
  })
}
