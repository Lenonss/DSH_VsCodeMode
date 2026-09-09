/**
 * dsh-vscode-mode client — 文件打开器注册表与自动选择。
 * @author ddj 2026年08月24号 / 2026年09月09号
 */
import { SIDEBAR_PLUGIN } from './compat.js'
import { buildFileAddress } from './officialSidebar.js'

export const AUTO_OPEN_TOOL = 'auto'
export const SYSTEM_OPEN_TOOL = 'system'
export const VSCODE_OPEN_TOOL = 'dsh-vscode-mode'
export const SIDEBAR_OPEN_TOOL = SIDEBAR_PLUGIN
/** 官方右侧侧边栏打开器 id（「文件链接使用工具」下拉的官方选项；DSH 0.1.5+）。 */
export const OFFICIAL_OPEN_TOOL = 'dsh-official-sidebar'

export interface FileOpenContext {
  sessionId?: string
  cwd?: string
}

export interface FileOpener {
  id: string
  label: string
  description?: string
  priority?: number
  isAvailable?: () => boolean
  open: (path: string, context: FileOpenContext) => void | Promise<void>
}

export interface FileOpenerRegistry {
  register(opener: FileOpener): () => void
  registerFileOpener(opener: FileOpener): () => void
  list(): readonly FileOpener[]
  subscribe(listener: () => void): () => void
  get(id: string): FileOpener | undefined
}

/**
 * 写入外部打开器并触发注册表通知。
 * @author ddj 2026年08月24号
 * @param entries 打开器存储
 * @param notify 变更通知
 * @param opener 打开器
 */
function registryRegister(entries: Map<string, FileOpener>, notify: () => void, opener: FileOpener): void {
  if (!opener.id || typeof opener.open !== 'function') throw new TypeError('文件打开器必须提供 id 和 open')
  entries.set(opener.id, opener)
  notify()
}

/**
 * 创建生命周期独立的文件打开器注册表。
 * @author ddj 2026年08月24号
 * @returns 文件打开器注册表
 */
export function createFileOpenerRegistry(): FileOpenerRegistry {
  const entries = new Map<string, FileOpener>()
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  const list = (): readonly FileOpener[] => [...entries.values()].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  return {
    register(opener: FileOpener): () => void {
      registryRegister(entries, notify, opener)
      return () => {
        if (entries.get(opener.id) !== opener) return
        entries.delete(opener.id)
        notify()
      }
    },
    registerFileOpener(opener: FileOpener): () => void {
      registryRegister(entries, notify, opener)
      return () => {
        if (entries.get(opener.id) !== opener) return
        entries.delete(opener.id)
        notify()
      }
    },
    list,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: (id: string) => entries.get(id),
  }
}

/**
 * 检查打开器当前是否可用。
 * @author ddj 2026年08月24号
 * @param opener 待检查打开器
 * @returns 是否可用
 */
export function isAvailable(opener: FileOpener): boolean {
  try {
    return opener.isAvailable ? opener.isAvailable() : true
  } catch {
    return false
  }
}

/**
 * 返回当前可展示的文件打开器。
 * @author ddj 2026年08月24号
 * @param registry 文件打开器注册表
 * @returns 可用打开器列表
 */
export function availableOpeners(registry: FileOpenerRegistry): FileOpener[] {
  return registry.list().filter(isAvailable)
}

/**
 * 按设置选择打开器，不可用时回退自动优先级。
 * @author ddj 2026年08月24号
 * @param registry 文件打开器注册表
 * @param selected 用户选择的打开器 id
 * @returns 选中的打开器
 */
export function selectOpener(
  registry: FileOpenerRegistry,
  selected: string,
): FileOpener | undefined {
  if (selected !== AUTO_OPEN_TOOL) {
    const requested = registry.get(selected)
    if (requested && isAvailable(requested)) return requested
  }
  return availableOpeners(registry)[0]
}

/**
 * 结构化探测 dsh-better-sidebar 的文件打开能力。
 * @author ddj 2026年08月24号
 * @param ctx 客户端服务上下文
 * @returns 侧边栏打开器或 undefined
 */
export function scanSidebar(ctx: { get: (name: string) => unknown }): FileOpener | undefined {
  try {
    const service = ctx.get('betterSidebar') as {
      openFile?: (scope: { sessionId: string; cwd?: string }, path: string, title?: string) => void
      isTabEnabled?: (id: string) => boolean
      features?: readonly string[]
      getSnapshot?: () => { state?: unknown }
    } | undefined
    if (!service || typeof service.openFile !== 'function') return undefined
    const advertised = service.features?.includes('openFile') ?? true
    if (!advertised) return undefined
    const canOpen = typeof service.isTabEnabled !== 'function' || service.isTabEnabled('editor')
    if (!canOpen) return undefined
    return {
      id: SIDEBAR_OPEN_TOOL,
      label: 'dsh-better-sidebar',
      description: '在 dsh-web-ui-all 侧边栏编辑器中打开',
      priority: 80,
      isAvailable: () => typeof service.openFile === 'function'
        && (service.features?.includes('openFile') ?? true)
        && (typeof service.isTabEnabled !== 'function' || service.isTabEnabled('editor')),
      open: (path, context) => {
        if (!context.sessionId) throw new Error('当前没有活动会话')
        service.openFile!({ sessionId: context.sessionId, cwd: context.cwd }, path, baseName(path))
      },
    }
  } catch {
    return undefined
  }
}

/**
 * 从路径提取文件名。
 * @author ddj 2026年08月24号
 * @param path 文件路径
 * @returns 文件名
 */
export function baseName(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || path
}

/** 官方 sidebarRight.openResource 的最小结构面（结构性使用，不 import 官方类型）。 */
export interface OfficialOpenResourceService {
  openResource?: (address: string, options?: { params?: unknown }) => void
}

/**
 * 文件链接是否由本插件认领官方 file 地址：自动/VSCodeMode 档接管（链接进本插件编辑器），
 * 官方侧边栏/system/better-sidebar 档不认领（官方查看器或旧版路由生效）。
 * @author ddj 2026年09月09号
 * @param selected 「文件链接使用工具」当前值
 * @returns 是否认领
 */
export function shouldClaimFiles(selected: unknown): boolean {
  return selected === AUTO_OPEN_TOOL || selected === VSCODE_OPEN_TOOL
}

/**
 * 创建「官方侧边栏」文件打开器（DSH 0.1.5+，经 ctx.sidebarRight.openResource 打开官方查看器）。
 * 仅官方服务探测命中时注册；下拉选项随注册动态出现（McpSettings 动态渲染）。
 * @author ddj 2026年09月09号
 * @param service 官方导航控制器
 * @returns 文件打开器
 */
export function officialSidebarOpener(service: OfficialOpenResourceService): FileOpener {
  return {
    id: OFFICIAL_OPEN_TOOL,
    label: '官方侧边栏',
    description: '在 DSH 官方右侧侧边栏查看器中打开（0.1.5+）',
    priority: 90,
    isAvailable: () => typeof service.openResource === 'function',
    open: (path, context) => {
      if (typeof service.openResource !== 'function') throw new Error('官方侧边栏 openResource 能力不可用')
      service.openResource(buildFileAddress(path, context.sessionId))
    },
  }
}
