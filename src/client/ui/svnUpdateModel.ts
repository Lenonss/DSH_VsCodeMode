/**
 * dsh-vscode-mode client — SVN 更新窗口的纯视图逻辑。
 * @author ddj 2026年09月24号
 */
import type { SvnUpdatePhase, SvnUpdateRow } from '../../shared/svn.js'

/**
 * 只有真实终态允许直接关闭窗口。
 * @author ddj 2026年09月24号
 * @param phase 任务阶段
 * @returns 是否结束
 */
export function updateDone(phase: SvnUpdatePhase | undefined): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled'
}

/**
 * 后端结束并不等于前端已取完全部结果页。
 * @author ddj 2026年09月24号
 * @param phase 后台状态
 * @param pending 尚有未加载的明细
 * @returns 结果界面是否完成
 */
export function updateReady(phase: SvnUpdatePhase | undefined, pending: boolean): boolean {
  return updateDone(phase) && !pending
}

/**
 * 取消或异常终止会在工作副本上留下 SVN 锁（E155037/E155004）；
 * 只按失败态原文判定，不推测其他失败的原因。
 * @author ddj 2026年09月28号
 * @param state 任务快照
 * @returns 是否需要先执行 cleanup
 */
export function updateLocked(state: { phase?: SvnUpdatePhase; error?: string; rawTail?: string } | null | undefined): boolean {
  if (!state || state.phase !== 'failed') return false
  const text = (state.error ?? '') + '\n' + (state.rawTail ?? '')
  return /E155037|E155004|Previous operation has not finished|run 'cleanup'|Working copy .*locked|工作副本.*锁/i.test(text)
}

/**
 * 菜单/二级对话框按 Esc 只关闭自己；连接中断后允许显式暂时关闭。
 * @author ddj 2026年09月24号
 * @param ready 已取完后台结果
 * @param error 连接错误
 * @param hasJob 是否知道后台 job
 * @param overlay 子弹窗或菜单是否打开
 * @returns 自动/显式关闭及确认要求
 */
export function updateCloseMode(ready: boolean, error: string, hasJob: boolean, overlay: boolean) {
  const disconnected = Boolean(error && hasJob && !ready)
  return {
    passive: (ready || Boolean(error && !hasJob)) && !overlay,
    explicit: ready || Boolean(error),
    confirm: disconnected,
  }
}

/**
 * 窗口只能在发起它的同一会话、同一工作区作用域中挂载。
 * @author ddj 2026年09月24号
 * @param dialog 发起窗口时记录的身份
 * @param sessionId 当前会话
 * @param scope 当前工作区作用域
 * @returns 是否允许挂载
 */
export function sameUpdateOwner(dialog: { sessionId?: string; scope?: string | null } | null,
  sessionId?: string, scope?: string | null): boolean {
  return Boolean(dialog && dialog.sessionId === sessionId && dialog.scope === scope)
}

/**
 * 为数千条结果取可视区和小幅缓冲，行高由界面固定约束。
 * @author ddj 2026年09月24号
 * @param count 当前记录数
 * @param scrollTop 列表滚动偏移
 * @param height 列表高度
 * @param rowHeight 固定行高
 * @returns 可见的起止索引（尾部不含）
 */
export function updateRange(count: number, scrollTop: number, height: number, rowHeight: number): { start: number; end: number } {
  const start = Math.min(count, Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - 8))
  const end = Math.min(count, Math.ceil((Math.max(0, scrollTop) + Math.max(0, height)) / rowHeight) + 8)
  return { start, end }
}

/**
 * 输出不等于文件真实类型；只给已知扩展名提供可辨识的类型推断。
 * @author ddj 2026年09月24号
 * @param path SVN 输出路径
 * @returns 推断类型，未知为空
 */
export function updateType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  const known: Record<string, string> = {
    bytes: 'application/octet-stream', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf',
  }
  return ext ? known[ext] ?? '' : ''
}

/**
 * 行动作是否可用取决于更新是否结束、路径是否在工作区且磁盘是否有文件。
 * @author ddj 2026年09月24号
 * @param row 更新行
 * @param phase 任务阶段
 * @param kind 磁盘判型；未读到时仅开放父目录/复制
 * @param revision 完成修订号
 * @returns 菜单动作集合
 */
export function updateActs(row: SvnUpdateRow, phase: SvnUpdatePhase, kind: string, revision: number | null) {
  const valid = updateDone(phase) && Boolean(row.relPath)
  const file = valid && kind === 'file' && row.action !== 'D'
  const binary = Boolean(updateType(row.path))
  return {
    compare: file && Boolean(revision) && !binary,
    log: file,
    open: file,
    openWith: file,
    parent: valid,
    copy: Boolean(row.path),
  }
}

/**
 * 目录上下文使用工作区相对路径，根文件的父目录表示为工作区根。
 * @author ddj 2026年09月24号
 * @param path 工作区相对路径
 * @returns 父目录相对路径
 */
export function updateParent(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const at = normalized.lastIndexOf('/')
  return at < 0 ? '' : normalized.slice(0, at)
}
