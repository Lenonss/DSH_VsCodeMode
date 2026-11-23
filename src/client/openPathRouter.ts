/**
 * dsh-vscode-mode client — DSH 对话文件链接的统一打开路由。
 * openPath 补丁经 compat.patchMethod 安装（链式恢复，多插件补丁互不踩踏）。
 * 0.2.3 把 openPath 从客户端 workspaces 移到 host 侧 remote.session：
 * 安装前必须探测真实宿主，探测不到就不装，绝不新建死属性。
 * 作者 ddj 2026年08月24号
 */
import { patchMethod } from './compat.js'
import { refreshUniver, univerCapability } from './univer/store.js'
import { routesUniver } from './univer/routing.js'
import { isOfficePath, isUniverPath } from '../shared/univer.js'
import { openEditorView } from './events.js'
import { AUTO_OPEN_TOOL, VSCODE_OPEN_TOOL, type FileOpenContext, type FileOpenerRegistry, isAvailable, selectOpener } from './fileOpeners.js'

/** 实际持有 openPath 的宿主对象与键名。 */
export interface OpenPathTarget {
  owner: Record<string, unknown>
  key: string
}

/** 探测候选：0.2.3 host 侧在前，旧版客户端服务在后。 */
const OPEN_PATH_HOSTS = ['remote.session', 'workspaces'] as const

/**
 * 探测实际存在的 openPath 宿主；探测不到返回 undefined（调用方不得安装补丁）。
 * @public @author ddj 2026年11月23号
 * @param ctx 客户端服务上下文
 * @returns 宿主对象与键名，或 undefined
 */
export function resolveOpenPathOwner(ctx: { get: (name: string) => unknown }): OpenPathTarget | undefined {
  for (const name of OPEN_PATH_HOSTS) {
    let owner: unknown
    try { owner = ctx.get(name) } catch { owner = undefined }
    if (!owner || typeof owner !== 'object') continue
    const table = owner as Record<string, unknown>
    if (typeof table.openPath !== 'function') continue
    return { owner: table, key: 'openPath' }
  }
  return undefined
}

export interface OpenPathRouterOptions {
  /** 探测到的宿主；缺省时不安装补丁。 */
  target?: OpenPathTarget
  registry: FileOpenerRegistry
  selected: () => string
  context: () => FileOpenContext
  logger?: (message: string) => void
}

/**
 * 安装可卸载的 openPath 路由。
 * @author ddj 2026年08月24号 / 2026年11月23号
 * @param options 路由依赖
 * @returns 恢复原方法的 disposer（无宿主时为空操作）
 */
export function installOpenPathRouter(options: OpenPathRouterOptions): () => void {
  const target = options.target
  if (!target || typeof target.owner[target.key] !== 'function') {
    options.logger?.('未找到 openPath 宿主（0.2.3 需 remote.session，旧版需 workspaces），跳过文件链接路由')
    return () => {}
  }
  /** @private @author ddj 2026年08月24号 @description 先试插件打开器，失败回退宿主原实现。 */
  const open = async (original: (path: string) => Promise<void>, path: string): Promise<void> => {
    const context = options.context()
    if (context.sessionId && (isOfficePath(path) || isUniverPath(path))) {
      await refreshUniver(context.sessionId)
      if (routesUniver(path, univerCapability(context.sessionId))) { openEditorView(path); return }
    }
    const opener = selectOpener(options.registry, options.selected())
    if (!opener || !isAvailable(opener)) return original.call(target.owner, path)
    try {
      await opener.open(path, context)
    } catch (error) {
      options.logger?.('文件打开器 ' + opener.id + ' 失败，回退系统打开: ' + String(error))
      if (opener.id !== 'system') await original.call(target.owner, path)
      else throw error
    }
  }
  return patchMethod(target.owner, target.key as never, open as never)
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
