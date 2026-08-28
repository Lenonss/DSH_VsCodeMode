/**
 * dsh-vscode-mode client — 浏览器端缓存键/路径统一出口（PathConst）。
 * 统一 localStorage 键前缀（各缓存模块/编辑区/搜索面板共用），避免内联散落；
 * 键带 schema 版本号，未来版本递增时经 sweepLegacyKeys 自动清旧。
 * 浏览器不涉 ~/.dsh 文件系统，这里只管键名 + shared 路由常量。
 * 作者 ddj 2026-09-01
 */

/** localStorage 键前缀表（按功能隔离；均按会话拼接）。 */
export const CACHE_KEY = {
  /** 展开状态（explorerCache v1，当前使用）。 */
  expanded: 'edrv.cache.explorer.v1.',
  /** 目录条目 SWR 缓存（explorerEntriesCache v2，当前使用）。 */
  entries: 'edrv.cache.entries.v2.',
  /** 编辑区视图状态（viewStateCache v1）。 */
  viewstate: 'edrv.cache.viewstate.v1.',
  /** 编辑器页签/活动文件（EditorView v2）。 */
  editor: 'edrv.editor.v2.',
  /** 侧边栏状态（EditorView；按布局 side/central 追加段）。 */
  sidebar: 'edrv.sidebar.',
  /** 搜索面板条件（SearchPanel v1）。 */
  search: 'edrv.search.v1.',
  /** 侧边栏提示已关闭标记（全局，无会话）。 */
  sideHint: 'edrv.side-hint-dismissed',
  /** 「性能优化」页工作区栏目展开状态（workspaceFoldCache v1，全局不按会话）。 */
  workspaceFold: 'edrv.ws-fold.v1.',
} as const

/** 按前缀拼会话键（侧边栏/编辑器等需要布局段时自行拼接后传入）。 */
export function cacheKey(prefix: string, sessionId: string): string {
  return prefix + sessionId
}

/** 旧版本键清理入口：未来前缀版本递增时在此登记旧前缀并清空（当前无实际旧键）。 */
export function sweepLegacyKeys(): void {
  // 例：entries v2 取代 v1 时 → localStorage.removeItem('edrv.cache.entries.v1.' + sid)
  // 当前各功能均为现役版本，无待清旧键。
}
