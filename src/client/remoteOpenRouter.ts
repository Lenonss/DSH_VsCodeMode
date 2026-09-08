/**
 * dsh-vscode-mode client — DSH 对话文件链接的 0.1.3+ 路由（remote.session 面）。
 * 0.1.3 起 dsh-client-ui-chat 的 openFile 直接调 ctx.remote.session.openWorkspacePath
 * （浏览器→host RPC session/openWorkspacePath），不再经过 workspaces.openPath，
 * 旧路由补丁因此落空；该方法是 getter-only accessor，补丁经 compat.patchAccessor
 * 换描述符安装。行为与 openPathRouter 对齐：插件打开器优先，"."（打开工作区文件夹）、
 * 无可用打开器或打开失败时透传原实现（系统默认应用打开）。
 * 纯逻辑，node 环境可单测（不依赖 DOM / events 模块）。
 * 作者 ddj 2026年09月08号
 */
import { patchAccessor } from './compat.js'
import { isAvailable, selectOpener, type FileOpenContext, type FileOpenerRegistry } from './fileOpeners.js'

/** session.openWorkspacePath 的结果形状（host 返回 { opened: true }；客户端不做输出校验）。 */
export interface OpenPathResult {
  ok: boolean
  value?: { opened: boolean }
}

/** openWorkspacePath 的请求形状；path 为 "." 时表示打开工作区文件夹。 */
export interface OpenPathRequest {
  path?: unknown
}

/** 补丁前 openWorkspacePath 的实时实现形状。 */
type RemoteOpen = (request: OpenPathRequest) => Promise<OpenPathResult>

/** 插件打开器接管成功时返回给调用方（chat 只看 ok，产物区读 value）。 */
const OPENED_RESULT: OpenPathResult = { ok: true, value: { opened: true } }

export interface RemoteOpenRouterOptions {
  registry: FileOpenerRegistry
  selected: () => string
  context: () => FileOpenContext
  logger?: (message: string) => void
}

/**
 * 结构化探测 remote.session 命名空间服务及其 openWorkspacePath 方法。
 * 旧版 DSH 无该 namespace、或 api-remotes 尚未挂载时返回 undefined。
 * @author ddj 2026年09月08号
 * @param ctx 客户端服务上下文
 * @returns 命名空间服务实例；不可用返回 undefined
 */
export function probeRemoteOpen(ctx: { get: (name: string) => unknown }): object | undefined {
  try {
    const service = ctx.get('remote.session') as { openWorkspacePath?: unknown } | undefined
    if (!service || typeof service.openWorkspacePath !== 'function') return undefined
    return service
  } catch {
    return undefined
  }
}

/**
 * 安装可卸载的 remote.session.openWorkspacePath 路由（0.1.3+ 会话文件链接主路径）。
 * @author ddj 2026年09月08号
 * @param service probeRemoteOpen 命中的命名空间服务
 * @param options 路由依赖
 * @returns 恢复函数；目标属性缺失时返回 null（调用方停止安装并告警）
 */
export function patchRemoteOpen(service: object, options: RemoteOpenRouterOptions): (() => void) | null {
  return patchAccessor(service, 'openWorkspacePath', async (original, ...args) => {
    const fallback = original as unknown as RemoteOpen
    const request = (args[0] ?? {}) as OpenPathRequest
    const path = typeof request.path === 'string' ? request.path : ''
    if (!path || path === '.') return fallback(request)
    const opener = selectOpener(options.registry, options.selected())
    if (!opener || !isAvailable(opener)) return fallback(request)
    try {
      await opener.open(path, options.context())
      return OPENED_RESULT
    } catch (error) {
      options.logger?.('文件打开器 ' + opener.id + ' 失败，回退系统打开: ' + String(error))
      return fallback(request)
    }
  })
}
