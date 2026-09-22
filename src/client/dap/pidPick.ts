/**
 * dsh-vscode-mode client — 附加目标 pid 决策（纯函数，可单测）。
 * host 侧只对「唯一命中」自动附加；多候选由客户端弹进程选择器（VS Code QuickPick 等价物）。
 * 作者 ddj 2026年09月29号
 */
import type { DapProcessInfo } from '../../shared/dap.js'

/** pid 决策结果。 */
export type PidPlan =
  | { kind: 'none'; message: string }
  | { kind: 'auto'; pid: number }
  | { kind: 'picker'; items: DapProcessInfo[] }

/**
 * 由进程列表决策附加方式：0 命中报错；唯一命中直用；多候选交选择器。
 * @author ddj 2026年09月29号
 * @param items 已按 processName 过滤的进程列表
 * @param processName 过滤词（错误文案用）
 */
export function resolvePidPlan(items: DapProcessInfo[], processName?: string): PidPlan {
  if (!items.length) return { kind: 'none', message: '未找到匹配进程：' + (processName || '(空)') }
  if (items.length === 1) return { kind: 'auto', pid: items[0].pid }
  return { kind: 'picker', items }
}
