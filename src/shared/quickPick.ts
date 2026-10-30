/**
 * dsh-vscode-mode 快捷菜单共享纯函数 — 下拉选择器的状态与摘要文案。
 *
 * 纯函数模块：禁 node/react 导入（与 shared/quickMenu.ts 同约束）。
 * 为什么抽：工作区/技能/规则三个下拉的「触发器上显示什么」「怎么切换一项」是同一类
 * 纯计算，放在 shared 里可被 vitest 直接覆盖，避免只能靠肉眼在弹窗里验。
 *
 * 作者 ddj 2026年10月30号
 */
import { normalizePath } from './quickMenu.js'

/** 工作区限定态：全部 / 仅当前工作区 / 自定义集合。 */
export type WorkspacePickMode = 'all' | 'current' | 'some'

/** 工作区下拉触发器的摘要。 */
export interface WorkspacePickSummary {
  mode: WorkspacePickMode
  /** 触发器文案。 */
  label: string
  /** 归一化前的原始路径列表（空数组表示全部）。 */
  paths: string[]
}

/**
 * 推导工作区下拉的摘要（null / 空数组都算「全部工作区」）。
 * @author ddj 2026年10月30号
 * @param paths 已选路径列表（null = 全部工作区）
 * @param cwd 当前工作区（缺失时无法判定「当前工作区」态）
 * @returns 摘要（mode + 文案 + 原始路径）
 */
export function workspaceLabel(paths: string[] | null, cwd?: string): WorkspacePickSummary {
  const list = (paths ?? []).slice()
  if (list.length === 0) return { mode: 'all', label: '全部工作区', paths: [] }
  if (list.length === 1 && cwd !== undefined && normalizePath(cwd) !== '' && normalizePath(list[0]) === normalizePath(cwd)) {
    return { mode: 'current', label: '当前工作区', paths: list }
  }
  return { mode: 'some', label: '已选 ' + list.length + ' 个工作区', paths: list }
}

/**
 * 多选摘要文案（0 项、1~2 项全写、更多折叠成「A、B 等 N 项」）。
 * @author ddj 2026年10月30号
 * @param labels 已选项文案
 * @param unit 折叠时的单位（如「项技能」「条规则」）
 * @returns 触发器文案
 */
export function selectionLabel(labels: string[], unit: string): string {
  if (labels.length === 0) return '未绑定'
  if (labels.length <= 2) return labels.join('、')
  return labels.slice(0, 2).join('、') + ' 等 ' + labels.length + ' ' + unit
}

/**
 * 工作区集合切换（归一化比较去重；清空即回到「全部工作区」的 null 语义）。
 * @author ddj 2026年10月30号
 * @param paths 当前列表（null = 全部）
 * @param target 目标工作区路径
 * @returns 新列表；空集合返回 null
 */
export function toggleWorkspace(paths: string[] | null, target: string): string[] | null {
  const list = (paths ?? []).slice()
  const key = normalizePath(target)
  const index = list.findIndex((path) => normalizePath(path) === key)
  if (index >= 0) list.splice(index, 1)
  else list.push(target)
  return list.length === 0 ? null : list
}
