/**
 * dsh-vscode-mode client — 页签数量上限共享状态。
 * 设置来源：dsh-vscode-mode 命名空间的 maxOpenEditors 字段（通用设置页可调）；
 * 客户端 settings 订阅经 editorLimitApply 写入，编辑器经 getMaxOpenEditors 读取，
 * 变更时由 client/index.ts 派发 edrv:max-open-editors 窗口事件通知编辑器复算淘汰。
 * 形态与 sidebarMin.ts 一致（同一设置同步链路，便于统一维护）。
 * 作者 ddj 2026年09月18号
 */
import { EDITOR_LIMIT_DEFAULT, normalizeMaxOpenEditors } from '../shared/editorLimit.js'

let currentLimit = EDITOR_LIMIT_DEFAULT

/**
 * 应用设置值（client/index.ts 设置订阅同步调用）。
 * @author ddj 2026年09月18号
 * @param value 设置文档中的 maxOpenEditors
 * @returns 归一化后的生效值（0 = 不限制）
 */
export function editorLimitApply(value: unknown): number {
  currentLimit = normalizeMaxOpenEditors(value)
  return currentLimit
}

/**
 * 读取当前生效的页签上限（编辑器初始/事件回调共用；0 = 不限制）。
 * @author ddj 2026年09月18号
 * @returns 当前上限
 */
export function getMaxOpenEditors(): number {
  return currentLimit
}
