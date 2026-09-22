/**
 * dsh-vscode-mode client — Monaco 编辑器 model 路径归一化（纯函数，可单测）。
 * 与 EditorView 原 modelPathOf 逐字同逻辑，提取共享防止"编辑器切换断点"与
 * "调试面板新增断点"两处口径漂移（断点表 key 必须同源）。
 * 作者 ddj 2026年09月21号
 */

/** 最小编辑器形状（仅声明用到的 model.uri.path 链）。 */
export interface EditorPathLike {
  getModel?: () => { uri?: { path?: string } } | null
}

/**
 * 取当前 model 的文件路径（uri.path → 去首斜杠 → decode）。
 * 无 model / 无 uri.path 时返回 null（调用方降级提示，不产生断点）。
 * @author ddj 2026年09月21号
 * @param editor Monaco 编辑器实例（或形状兼容对象）
 * @returns 归一化路径；不可用时 null
 */
export function editorModelPathOf(editor: unknown): string | null {
  const uriPath = (editor as EditorPathLike | null)?.getModel?.()?.uri?.path
  return uriPath ? decodeURIComponent(String(uriPath).replace(/^\//, '')) : null
}
