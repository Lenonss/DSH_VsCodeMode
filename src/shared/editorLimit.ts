/**
 * dsh-vscode-mode shared — 编辑器页签数量上限的常量与归一化（host 与 client 双面契约）。
 *
 * 纯数据模块：host（settings schema 默认值）与 client（淘汰判定）共用，禁止 import
 * 浏览器 API 或 Node API。
 *
 * ⚠️ 与 sidebarMinWidth 的关键差异：**0 是合法值**，语义为「不限制页签数量」，
 * 因此归一化时不能像 normalizeSidebarMinWidth 那样把 0 当作非法输入回退默认值。
 *
 * 作者 ddj 2026年09月18号
 */

/** 页签数量上限默认值（对齐 VS Code workbench.editor.limit 默认 10）。 */
export const EDITOR_LIMIT_DEFAULT = 10
/** 上限允许下界：0 = 不限制（关闭上限功能）。 */
export const EDITOR_LIMIT_FLOOR = 0
/** 上限允许上界（防呆：远超屏幕可容纳数量的上限无意义）。 */
export const EDITOR_LIMIT_CEIL = 50

/**
 * 归一化页签数量上限。
 *
 * 规则：`0` 合法保留（不限制）；非数字/非有限/负数 → 回退默认；其余取整后夹到
 * `[EDITOR_LIMIT_FLOOR, EDITOR_LIMIT_CEIL]`。
 * 数字字符串（设置文档/输入框可能给字符串）按数字解析，与 sidebarMin 口径一致。
 *
 * ⚠️ 只接受「真数字」与「非空数字字符串」：不得用裸 `Number(value)` 判值——
 * `Number(null)`、`Number([])`、`Number(false)`、`Number('')` 全是 0，会被误判成
 * 「不限制」；而缺失/损坏的设置必须回退默认（否则一个坏值就永久关掉上限）。
 *
 * @author ddj 2026年09月18号
 * @param value 原始值（设置文档或输入框来的任意 JSON 值）
 * @returns 合法上限（0 = 不限制）
 */
export function normalizeMaxOpenEditors(value: unknown): number {
  let n: number
  if (typeof value === 'number') {
    n = value
  } else if (typeof value === 'string' && value.trim() !== '') {
    n = Number(value)
  } else {
    return EDITOR_LIMIT_DEFAULT
  }
  if (!Number.isFinite(n) || n < 0) return EDITOR_LIMIT_DEFAULT
  return Math.max(EDITOR_LIMIT_FLOOR, Math.min(EDITOR_LIMIT_CEIL, Math.round(n)))
}
