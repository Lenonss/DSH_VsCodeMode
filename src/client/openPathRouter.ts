/**
 * dsh-vscode-mode client — DSH 对话文件链接的统一打开路由。
 * @author ddj 2026年08月24号
 */
import { openEditorView } from './events.js'
import { AUTO_OPEN_TOOL, VSCODE_OPEN_TOOL, type FileOpenContext, type FileOpenerRegistry, isAvailable, selectOpener } from './fileOpeners.js'

export interface OpenPathRouterOptions {
  workspaces: { openPath: (path: string) => Promise<void> }
  registry: FileOpenerRegistry
  selected: () => string
  context: () => FileOpenContext
  logger?: (message: string) => void
}

/**
 * 安装可卸载的 workspaces.openPath 路由。
 * @author ddj 2026年08月24号
 * @param options 路由依赖
 * @returns 恢复原方法的 disposer
 */
export function installOpenPathRouter(options: OpenPathRouterOptions): () => void {
  const original = options.workspaces.openPath
  const open = async (path: string): Promise<void> => {
    const context = options.context()
    const opener = selectOpener(options.registry, options.selected())
    if (!opener || !isAvailable(opener)) return original.call(options.workspaces, path)
    try {
      await opener.open(path, context)
    } catch (error) {
      options.logger?.('文件打开器 ' + opener.id + ' 失败，回退系统打开: ' + String(error))
      if (opener.id !== 'system') await original.call(options.workspaces, path)
      else throw error
    }
  }
  options.workspaces.openPath = open
  return () => { options.workspaces.openPath = original }
}

/**
 * 创建 VSCodeMode 内置文件打开器。
 * @author ddj 2026年08月24号
 * @returns VSCodeMode 打开器
 */
export function vscodeOpener(): { id: string; label: string; priority: number; open: (path: string) => void } {
  return { id: VSCODE_OPEN_TOOL, label: 'VSCodeMode', priority: 100, open: (path) => openEditorView(path) }
}

/**
 * 规范化设置中的打开器 id。
 * @author ddj 2026年08月24号
 * @param value 原始设置值
 * @returns 可路由的打开器 id
 */
export function autoValue(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : AUTO_OPEN_TOOL
}
