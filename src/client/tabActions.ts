/**
 * dsh-vscode-mode client — 文件页签操作纯函数（关闭族 / 固定 / 路径推导）。
 * 页签状态是 EditorView 的 `{ path, pinned }[]`；本模块不触 React/DOM，可 node 单测，
 * 菜单动作（tabMenu）与编辑器（EditorView）共用同一份语义，避免规则散落两处。
 *
 * 核心约定 —— **固定 = 保护**：
 * 「关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭」一律不关固定页签；
 * 只有单项「关闭」可以显式关掉一个固定页签（用户明确点了它）。
 *
 * 关闭后的活动页签：原活动页签未被关 → 不变；被关 → 右侧优先、否则左侧末位（VS Code 行为）。
 * 作者 ddj 2026年09月11号
 */

/** 页签的最小形状（EditorView 持有超集）。 */
export interface TabLike {
  path: string
  pinned?: boolean
}

/** 关闭操作结果（tabs 未变化时返回原引用，React 可跳过重渲染）。 */
export interface CloseResult {
  tabs: TabLike[]
  active: string | null
}

// --region 关闭族

/**
 * 关闭指定集合：活动页签被关时按「右侧优先、否则左侧末位」补位。
 * @author ddj 2026年09月11号
 * @param tabs 当前页签
 * @param closing 待关闭路径集合
 * @param active 当前活动页签路径
 * @returns 剩余页签与新的活动页签
 */
export function applyClose(tabs: TabLike[], closing: Set<string>, active: string | null): CloseResult {
  const remaining = tabs.filter((tab) => !closing.has(tab.path))
  if (remaining.length === tabs.length) return { tabs, active }
  if (active && !closing.has(active)) return { tabs: remaining, active }
  return { tabs: remaining, active: pickNeighbor(tabs, remaining, active) }
}

/**
 * 关闭其他：保留目标页签与全部固定页签。
 * @author ddj 2026年09月11号
 * @param tabs 当前页签
 * @param target 保留的目标页签路径
 * @param active 当前活动页签路径
 * @returns 关闭结果
 */
export function closeOthers(tabs: TabLike[], target: string, active: string | null): CloseResult {
  return applyClose(tabs, closingExcept(tabs, (tab) => tab.path === target || tab.pinned === true), active)
}

/**
 * 关闭右侧：关闭目标之后、未被固定的页签。
 * @author ddj 2026年09月11号
 * @param tabs 当前页签
 * @param target 基准页签路径（其右侧才关）
 * @param active 当前活动页签路径
 * @returns 关闭结果
 */
export function closeRight(tabs: TabLike[], target: string, active: string | null): CloseResult {
  const at = tabs.findIndex((tab) => tab.path === target)
  const closing = new Set<string>()
  for (let i = at + 1; i > 0 && i < tabs.length; i += 1) {
    if (tabs[i].pinned !== true) closing.add(tabs[i].path)
  }
  return applyClose(tabs, closing, active)
}

/**
 * 关闭已保存：关闭未固定且无未保存修改的页签。
 * @author ddj 2026年09月11号
 * @param tabs 当前页签
 * @param dirty 路径 → 是否有未保存修改
 * @param active 当前活动页签路径
 * @returns 关闭结果
 */
export function closeSaved(tabs: TabLike[], dirty: Record<string, boolean>, active: string | null): CloseResult {
  return applyClose(tabs, closingExcept(tabs, (tab) => tab.pinned === true || dirty[tab.path] === true), active)
}

/**
 * 全部关闭：仅关未固定页签（全部固定时无操作）。
 * @author ddj 2026年09月11号
 * @param tabs 当前页签
 * @param active 当前活动页签路径
 * @returns 关闭结果
 */
export function closeAll(tabs: TabLike[], active: string | null): CloseResult {
  return applyClose(tabs, closingExcept(tabs, (tab) => tab.pinned === true), active)
}

/**
 * 反选可关闭集合（保留 keep 命中的页签，其余进关闭集）。
 * @author ddj 2026年09月11号
 * @param tabs 当前页签
 * @param keep 保留判定
 * @returns 待关闭路径集合
 */
function closingExcept(tabs: TabLike[], keep: (tab: TabLike) => boolean): Set<string> {
  const closing = new Set<string>()
  for (const tab of tabs) if (!keep(tab)) closing.add(tab.path)
  return closing
}

/**
 * 选补位页签：先向右找最近的存活页签，再向左找，都没有则取剩余首个。
 * @author ddj 2026年09月11号
 * @param tabs 关闭前的页签（用于取原索引）
 * @param remaining 关闭后剩余的页签
 * @param active 被关掉的活动页签路径
 * @returns 补位页签路径；无剩余返回 null
 */
function pickNeighbor(tabs: TabLike[], remaining: TabLike[], active: string | null): string | null {
  const first = remaining[0]
  if (!first) return null
  const at = tabs.findIndex((tab) => tab.path === active)
  if (at < 0) return first.path
  const alive = new Set(remaining.map((tab) => tab.path))
  for (let i = at + 1; i < tabs.length; i += 1) if (alive.has(tabs[i].path)) return tabs[i].path
  for (let i = at - 1; i >= 0; i -= 1) if (alive.has(tabs[i].path)) return tabs[i].path
  return first.path
}
// --endregion

// --region 固定与插入

/**
 * 切换页签固定态：固定页签整体前移（两侧各自保持相对顺序）。
 * @author ddj 2026年09月11号
 * @param tabs 当前页签
 * @param target 目标页签路径
 * @returns 重排后的页签（目标不存在时原样返回）
 */
export function togglePin(tabs: TabLike[], target: string): TabLike[] {
  if (!tabs.some((tab) => tab.path === target)) return tabs
  const next = tabs.map((tab) => (
    tab.path === target ? { path: tab.path, pinned: tab.pinned !== true } : tab
  ))
  return pinnedFirst(next)
}

/**
 * 新增页签：已存在则原样返回；否则插到最后一个固定页签之后。
 * @author ddj 2026年09月11号
 * @param tabs 当前页签
 * @param path 新页签路径
 * @returns 新页签数组
 */
export function insertTab(tabs: TabLike[], path: string): TabLike[] {
  if (tabs.some((tab) => tab.path === path)) return tabs
  // 缺省追加到末尾；存在固定页签时插到最后一个固定页签之后
  let at = tabs.length
  for (let i = tabs.length - 1; i >= 0; i -= 1) {
    if (tabs[i].pinned !== true) continue
    at = i + 1
    break
  }
  return tabs.slice(0, at).concat([{ path }], tabs.slice(at))
}

/**
 * 固定分区：固定页签在前，两侧各自保持原相对顺序。
 * @author ddj 2026年09月11号
 * @param tabs 页签
 * @returns 重排后的页签
 */
function pinnedFirst(tabs: TabLike[]): TabLike[] {
  return tabs.filter(isPinned).concat(tabs.filter((tab) => !isPinned(tab)))
}

/**
 * 是否固定页签。
 * @author ddj 2026年09月11号
 * @param tab 页签
 * @returns 是否固定
 */
function isPinned(tab: TabLike): boolean {
  return tab.pinned === true
}

/**
 * 归一化持久化的页签数据：兼容旧版 `string[]`、去重、固定分区。
 * 损坏项（非字符串/非对象/无 path）直接丢弃。
 * @author ddj 2026年09月11号
 * @param raw localStorage 解析结果（任意形状）
 * @returns 归一化后的页签数组
 */
export function normalizeTabs(raw: unknown): TabLike[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: TabLike[] = []
  for (const item of raw) {
    const tab = tabOf(item)
    if (!tab || seen.has(tab.path)) continue
    seen.add(tab.path)
    out.push(tab)
  }
  return pinnedFirst(out)
}

/**
 * 解释单条持久化页签：字符串 = 路径（旧版），对象取 path/pinned。
 * @author ddj 2026年09月11号
 * @param item 原始条目
 * @returns 页签或 null（无法解释）
 */
function tabOf(item: unknown): TabLike | null {
  if (typeof item === 'string') return item ? { path: item } : null
  if (!item || typeof item !== 'object') return null
  const raw = item as { path?: unknown; pinned?: unknown }
  if (typeof raw.path !== 'string' || !raw.path) return null
  return raw.pinned === true ? { path: raw.path, pinned: true } : { path: raw.path }
}

/**
 * 选活动页签：恢复值仍存在则用它，否则取首个（无页签返回 null）。
 * @author ddj 2026年09月11号
 * @param tabs 页签
 * @param wanted 持久化的活动路径
 * @returns 活动页签路径
 */
export function pickActive(tabs: TabLike[], wanted: unknown): string | null {
  const first = tabs[0]
  if (!first) return null
  if (typeof wanted === 'string' && tabs.some((tab) => tab.path === wanted)) return wanted
  return first.path
}
// --endregion

// --region 路径推导

/** Windows 盘符 / UNC / POSIX 根：视为工作区外的绝对路径。 */
const ABSOLUTE_RE = /^(?:[a-z]:[\\/]|\\\\|\/)/i

/**
 * 是否绝对路径（工作区外）。
 * @author ddj 2026年09月11号
 * @param path 路径
 * @returns 是否绝对路径
 */
export function isAbsolutePath(path: string): boolean {
  return ABSOLUTE_RE.test(String(path ?? ''))
}

/**
 * 是否可在资源管理器视图中定位（工作区相对且不含 `..` 上跳段）。
 * @author ddj 2026年09月11号
 * @param path 路径
 * @returns 是否可定位
 */
export function isTreeRevealable(path: string): boolean {
  const text = String(path ?? '').trim()
  if (!text || isAbsolutePath(text)) return false
  return !text.replace(/\\/g, '/').split('/').includes('..')
}

/**
 * 相对路径：cwd 内路径去掉工作区前缀；工作区外/无 cwd 回退规范化原路径。
 * @author ddj 2026年09月11号
 * @param path 路径
 * @param cwd 会话工作区目录（可空）
 * @returns 展示/复制用的相对路径
 */
export function relativeOf(path: string, cwd?: string | null): string {
  const target = normalizeSlashes(path)
  const base = normalizeSlashes(cwd).replace(/\/+$/, '')
  if (base && target.toLowerCase().startsWith((base + '/').toLowerCase())) return target.slice(base.length + 1)
  return target
}

/**
 * 绝对路径：相对路径按 cwd 拼接；已是绝对路径或没有 cwd 时回退规范化原路径。
 * @author ddj 2026年09月11号
 * @param path 路径
 * @param cwd 会话工作区目录（可空）
 * @returns 展示/复制用的绝对路径
 */
export function absoluteOf(path: string, cwd?: string | null): string {
  const target = normalizeSlashes(path)
  if (isAbsolutePath(target)) return target
  const base = normalizeSlashes(cwd).replace(/\/+$/, '')
  return base ? base + '/' + target : target
}

/**
 * 反斜杠归一为斜杠（页签/引用/剪贴板统一用正斜杠，与既有 mentionOf 口径一致）。
 * @author ddj 2026年09月11号
 * @param path 路径
 * @returns 正斜杠路径
 */
function normalizeSlashes(path: string | null | undefined): string {
  return String(path ?? '').replace(/\\/g, '/')
}

/**
 * 文件路径的祖先目录（由浅到深）：`a/b/c.ts` → `['a', 'a/b']`。
 * 根级文件、绝对路径与含 `..` 的路径返回空数组。
 * @author ddj 2026年09月11号
 * @param path 工作区相对路径
 * @returns 祖先目录相对路径数组
 */
export function ancestorDirsOf(path: string): string[] {
  if (!isTreeRevealable(path)) return []
  const segs = normalizeSlashes(path).split('/').filter(Boolean)
  const out: string[] = []
  for (let i = 1; i < segs.length; i += 1) {
    const prev = segs[i - 1]
    out.push(out.length ? out[out.length - 1] + '/' + prev : prev)
  }
  return out
}

/**
 * 文件名（页签/状态栏展示与 tooltip 用）。
 * @author ddj 2026年09月11号
 * @param path 路径
 * @returns 末段文件名；空路径返回空串
 */
export function baseNameOf(path: string): string {
  const text = normalizeSlashes(path)
  return text.split('/').filter(Boolean).pop() ?? ''
}
// --endregion
