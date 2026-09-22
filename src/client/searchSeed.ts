/**
 * dsh-vscode-mode client — 工作区搜索的「选区种子」。
 *
 * 需求：Ctrl+Shift+F 时若编辑器有选中，把选中文本自动填入搜索框。
 * 链路：EditorView 从 Monaco 取选区文本 → seedQueryOf 归一 → setSearchSeed 存入一次性槽
 * → 派发 edrv:search-focus → SearchPanel 消费（挂载时或已挂载时），填入并立即搜索。
 *
 * 为什么用一次性槽而不是事件 detail：
 * 侧边栏原本收起时搜索面板**尚未挂载**，派发瞬间没有监听者；事件 detail 会丢。
 * 槽在 EditorView 与 SearchPanel 之间充当交接点，挂载后由消费方自行取走。
 *
 * 为什么取首行：搜索框是单行 input，ripgrep 按字面连续匹配。多行选区（整段/整函数）
 * 作为单条 query 永远无匹配，故按项目既有口径取首行（与 VS Code 单行选区种子行为一致）。
 *
 * 纯逻辑 + 模块级槽，不依赖 React/DOM，可 node 单测。
 * 作者 ddj 2026年09月18号
 */

/** 种子最大长度（超长选区只取前 N 字符，防一次性把巨型 query 送进搜索）。 */
export const SEED_MAX = 200

/**
 * 由选区文本推导搜索种子。
 * @author ddj 2026年09月18号
 * @param text 选区原文（可能含多行、前后空白；null/undefined 视为空）
 * @returns 归一后的搜索词；无效输入返回空串（调用方据此保持原搜索词）
 */
export function seedQueryOf(text: unknown): string {
  const raw = String(text ?? '')
  if (!raw) return ''
  const firstLine = raw.split(/\r?\n/)[0] ?? ''
  const trimmed = firstLine.trim()
  if (!trimmed) return ''
  return trimmed.length > SEED_MAX ? trimmed.slice(0, SEED_MAX) : trimmed
}

/** 一次性种子槽（字符串或 null；null 表示无待消费种子）。 */
let pendingSeed: string | null = null

/**
 * 写入待消费种子（空词等价于清除）。
 * @author ddj 2026年09月18号
 * @param text 选区文本（经 seedQueryOf 归一）
 */
export function setSearchSeed(text: unknown): void {
  const seed = seedQueryOf(text)
  pendingSeed = seed ? seed : null
}

/**
 * 取走待消费种子（取后即清空，保证挂载路径与焦点路径不会重复应用同一个种子）。
 * @author ddj 2026年09月18号
 * @returns 种子搜索词；无待消费种子返回空串
 */
export function takeSearchSeed(): string {
  const seed = pendingSeed
  pendingSeed = null
  return seed ?? ''
}

/** 清空待消费种子（测试隔离用）。 */
export function clearSearchSeed(): void {
  pendingSeed = null
}

// --region 目录过滤种子（「在文件夹中查找…」：SearchPanel 消费后置 include 过滤）

/** 待消费的目录过滤种子（'' = 无）。 */
let pendingScope: string | null = null

/**
 * 写入待消费的目录过滤种子（空目录等价于清除）。
 * @author ddj 2026年09月22号
 * @param dir 目标目录（工作区相对；空 = 根 = 不限定目录）
 */
export function setSearchScope(dir: unknown): void {
  const text = String(dir ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  pendingScope = text ? text : null
}

/**
 * 取走待消费的目录过滤种子（取后即清空，与 query 种子同一一次性消费语义）。
 * @author ddj 2026年09月22号
 * @returns 目录相对路径；无待消费种子返回空串
 */
export function takeSearchScope(): string {
  const scope = pendingScope
  pendingScope = null
  return scope ?? ''
}

/**
 * 清空待消费的目录过滤种子（测试隔离用）。
 * @author ddj 2026年09月22号
 */
export function clearSearchScope(): void {
  pendingScope = null
}

// --endregion
