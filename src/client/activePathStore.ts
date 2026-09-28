/**
 * dsh-vscode-mode client — 活动编辑器文件路径单点（模块级，不依赖 React）。
 * 命令目录（ui/commandCatalog）是模块级常量、拿不到 EditorView 实例；其可用性判定
 * 需要「当前活动文件是什么」（如 Markdown 预览切换仅 .md 活动文件吞键），故由
 * EditorView 把 active 状态镜像到本 store，目录按需读取。
 * 作者 ddj 2026年10月
 */

/** 当前活动文件路径（null = 无活动文件/编辑器未挂载）。 */
let activePath: string | null = null

/**
 * 镜像活动文件路径（EditorView 渲染同步点调用；卸载时回写 null）。
 * @author ddj 2026年10月
 * @param path 活动文件路径或 null
 */
export function setActiveEditorPath(path: string | null): void {
  activePath = path
}

/**
 * 读取当前活动文件路径。
 * @author ddj 2026年10月
 * @returns 活动文件路径或 null
 */
export function activeEditorPath(): string | null {
  return activePath
}
