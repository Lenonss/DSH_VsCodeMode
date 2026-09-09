/**
 * dsh-vscode-mode client — 官方右侧 Sidebar 桥：探测 DSH 0.1.5-alpha.1+ 的
 * ctx.sidebarRightTabs / ctx.sidebarRight 服务，两段式注册「文件编辑」Tab
 * （类型定义进注册表，正文进 keyed slot sidebar.right.pane.tab）。
 * 可选依赖模式：服务缺失时调用方回退 better-sidebar / 中央页签；本模块不注册任何东西。
 * 维护约定：官方侧边栏（DSH 0.1.5+）是侧边栏编辑形态的唯一维护面；
 * dsh-better-sidebar 桥（sidebarBridge.ts）已归档，仅作旧版 DSH 回退，不再新增能力。
 * 纯逻辑（探测/导航参数解析）可单测，注册装配仅存在于 install 路径。
 * 作者 ddj 2026年09月09号
 */

import { log } from './log.js'
import { setEnsureSideEditor } from './sidebarBridge.js'

/** 官方 Tab 类型注册表服务名（ctx.get 用；不进 inject——旧版 DSH 无此包，inject 会停等）。 */
export const OFFICIAL_TABS_SERVICE = 'sidebarRightTabs'
/** 官方导航控制器服务名（ctx.get 用）。 */
export const OFFICIAL_SERVICE = 'sidebarRight'
/** 官方 keyed slot 名（Tab 正文挂点，由官方侧边栏的 rightbar seat 声明）。 */
export const OFFICIAL_SLOT_NAME = 'sidebar.right.pane.tab'
/** 本插件 Tab 类型定义 id（官方约定用包名；正文 slot 的 key 与之相同）。 */
export const OFFICIAL_TAB_ID = 'dsh-vscode-mode'
/** 本插件 Tab 的类型判别符（ctx.sidebarRight.openTab 的 kind）。 */
export const OFFICIAL_TAB_KIND = 'edrvEditor'
/** Tab 标题（与 better-sidebar 形态一致）。 */
export const OFFICIAL_TAB_TITLE = '文件编辑'
/** 官方 file 资源地址前缀（0.1.5+ 聊天文件链接/文件树打开的统一地址语法）。 */
export const OFFICIAL_FILE_PREFIX = 'dsh-resource://file/'
/** file 地址认领的 patterns（extension 档接管官方 textpreview 的 fallback 认领，注销自动回落）。 */
export const OFFICIAL_FILE_PATTERN = 'dsh-resource://file/**'
/** file 资源类型的定义 id（正文 slot 的 key）。 */
export const OFFICIAL_FILE_TAB_ID = 'dsh-vscode-mode/file'
/** file 资源类型的 kind（与页类型 edrvEditor 区分：同 kind 只允许一份 extension）。 */
export const OFFICIAL_FILE_KIND = 'edrvEditorFile'

/** 官方 Tab 打开参数（官方运行时不校验的 JSON，正文经 navigation.params 读回）。 */
export interface OfficialTabParams {
  openPath?: string
  focusDiff?: boolean
}

/** sidebarRightTabs 服务的最小结构面（结构性探测，不 import 官方类型）。 */
export interface SidebarRightTabsLike {
  register: (definition: unknown) => () => void
}

/** sidebarRight 服务的最小结构面（openTab 页路由 + openResource 资源路由 + 可选查询/定向打开）。 */
export interface SidebarRightServiceLike {
  openTab: (kind: string, options?: { params?: unknown }) => void
  openResource?: (address: string, options?: { params?: unknown }) => void
  /** 挂载会话的激活 Tab（判读编辑 Tab 是否已激活；无 seat 时 undefined）。 */
  active?: () => { kind?: string } | undefined
  /** 向指定会话的停靠面打开页类型（store 未 adopt 时 no-op）。 */
  openTabIn?: (sessionId: string, kind: string, options?: { params?: unknown }) => void
}

/** slots 服务的最小结构面（等待声明 + 注册）。 */
export interface SlotsLike {
  inject: (name: string, register: () => unknown) => unknown
  register: (spec: object, render: unknown) => unknown
}

/** 探测命中的一对官方服务。 */
export interface OfficialSidebar {
  tabs: SidebarRightTabsLike
  service: SidebarRightServiceLike
}

/**
 * 结构化探测官方右侧 Sidebar 服务（可选依赖：缺失/降级返回 undefined）。
 * 服务仅存在于 DSH 0.1.5-alpha.1+，探测命中 ≡ 版本判定成立。
 * @author ddj 2026年09月09号
 * @param ctx 客户端服务上下文
 * @returns 注册表与控制器对，或 undefined
 */
export function detectOfficial(ctx: { get: (name: string) => unknown }): OfficialSidebar | undefined {
  try {
    const tabs = ctx.get(OFFICIAL_TABS_SERVICE) as SidebarRightTabsLike | undefined
    const service = ctx.get(OFFICIAL_SERVICE) as SidebarRightServiceLike | undefined
    if (!tabs || typeof tabs.register !== 'function') return undefined
    if (!service || typeof service.openTab !== 'function') return undefined
    return { tabs, service }
  } catch {
    return undefined
  }
}

/**
 * 从官方导航参数安全解析打开请求（缺字段/坏类型一律降级为空请求，不抛错）。
 * @author ddj 2026年09月09号
 * @param params openTab 传入的 params（正文经 navigation.params 读回）
 * @returns 待打开路径与是否聚焦首个差异
 */
export function resolveNavOpen(params: unknown): { path: string | null; focusDiff: boolean } {
  const value = (params ?? {}) as OfficialTabParams
  const path = typeof value?.openPath === 'string' && value.openPath ? value.openPath : null
  return { path, focusDiff: value?.focusDiff === true }
}

/** 逐段 component 解码（失败返回 null，对齐官方 parseFileAddress 的容错语义）。 */
function decodeSegment(raw: string | undefined): string | null {
  if (raw === undefined) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

/**
 * 解析官方 file 资源地址（镜像 dsh-util-workspace-path 的 parseFileAddress 语法，不 import 官方包）。
 * session 域：`dsh-resource://file/session/<sessionId>/<逐段编码的相对路径>`；
 * absolute 域：`dsh-resource://file/absolute/<去前导 / 的绝对路径>`（POSIX 补回前导 /，
 * Windows 盘符 `C:/` 原样，UNC 保留空首段 `//server/share`）。
 * @author ddj 2026年09月09号
 * @param address 候选地址
 * @returns 文件路径（session 域附带 sessionId）；非 file 地址/畸形/解码失败返回 null
 */
export function parseOfficialFileAddress(address: unknown): { path: string; sessionId?: string } | null {
  if (typeof address !== 'string' || !address.startsWith(OFFICIAL_FILE_PREFIX)) return null
  const [scope, ...tail] = address.slice(OFFICIAL_FILE_PREFIX.length).split('/')
  const kind = decodeSegment(scope)
  if (kind === 'session') {
    const sessionId = decodeSegment(tail[0])
    const segments = tail.slice(1).map(decodeSegment)
    if (!sessionId || segments.length === 0 || segments.some((s) => s === null)) return null
    const path = (segments as string[]).join('/')
    return path ? { path, sessionId } : null
  }
  if (kind === 'absolute') {
    const unc = tail[0] === '' && tail.length > 1
    const segments = (unc ? tail.slice(1) : tail).map(decodeSegment)
    if (segments.length === 0 || (segments as string[])[0] === '' || segments.some((s) => s === null)) return null
    const list = segments as string[]
    if (unc) return { path: '//' + list.join('/') }
    if (/^[A-Za-z]:$/.test(list[0])) return { path: list.join('/') }
    return { path: '/' + list.join('/') }
  }
  return null
}

/**
 * file 地址的 Tab chip 标题：解码后的 basename（解码失败回退原始串切片）。
 * @author ddj 2026年09月09号
 * @param address file 资源地址
 * @returns 标题文本
 */
export function officialFileTitle(address: unknown): string {
  const parsed = parseOfficialFileAddress(address)
  const source = parsed?.path ?? (typeof address === 'string' ? address : '')
  const normalized = source.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || source
}

/** component 编码一段（对齐官方 encodeSegment：盘符冒号保持字面）。 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/**
 * 构造官方 file 资源地址（镜像 fileAddressFor 的分派：绝对路径→absolute 域，相对→session 域）。
 * @author ddj 2026年09月09号
 * @param path 绝对或工作区相对路径（两种分隔符均可）
 * @param sessionId 会话 id（相对路径必需；绝对路径可省）
 * @returns `dsh-resource://file/…` 地址
 * @throws 路径为空，或相对路径缺 sessionId
 */
export function buildFileAddress(path: string, sessionId?: string): string {
  const posix = (typeof path === 'string' ? path : '').replace(/\\/g, '/')
  if (!posix.trim()) throw new Error('buildFileAddress：路径为空')
  const isAbsolute = posix.startsWith('/') || posix.startsWith('//') || /^[A-Za-z]:[/\\]/.test(posix)
  if (isAbsolute) {
    const unc = posix.startsWith('//')
    const body = posix.replace(/^\/+/, '')
    return OFFICIAL_FILE_PREFIX + 'absolute/' + (unc ? '/' : '') + body.split('/').map(encodeSegment).join('/')
  }
  if (!sessionId) throw new Error('buildFileAddress：相对路径需要会话 id')
  const relative = posix.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '')
  return OFFICIAL_FILE_PREFIX + 'session/' + encodeSegment(sessionId) + '/' + relative.split('/').map(encodeSegment).join('/')
}

/**
 * 注册官方 Tab 正文（keyed slot，key=定义 id；slots.inject 等待 rightbar seat 声明）。
 * @author ddj 2026年09月09号
 * @param slots slots 服务
 * @param key 正文注册键（= 类型定义 id）
 * @param renderTab 正文组件（包装后的 OfficialSideTab）
 * @returns 注销函数；注册抛错返回 null
 */
function registerBodySlot(slots: SlotsLike, key: string, renderTab: unknown): (() => void) | null {
  try {
    const disposer = slots.inject(OFFICIAL_SLOT_NAME, () => slots.register(
      { name: OFFICIAL_SLOT_NAME, key },
      renderTab,
    ))
    return typeof disposer === 'function' ? (disposer as () => void) : null
  } catch (error) {
    log.warn('官方侧边栏正文 slot 注册失败（' + String(error) + '）')
    return null
  }
}

/**
 * 注册官方右侧 Sidebar「文件编辑」Tab 并接管打开路由（两段式 + 路由）。
 * 调用方须把返回值挂进 ctx.effect；类型注册抛错时返回 null，由调用方回退旧形态。
 * @author ddj 2026年09月09号
 * @param options 装配参数（探测命中的一对服务 + slots + 正文组件 + guide 文案）
 * @returns 卸载器（反注册类型与正文 + 撤销路由）；类型注册失败返回 null
 */
export function installOfficial(options: {
  tabs: SidebarRightTabsLike
  service: SidebarRightServiceLike
  slots: SlotsLike
  renderTab: unknown
  guide: { title: () => string; description: () => string }
}): (() => void) | null {
  const { tabs, service, slots, renderTab, guide } = options
  const open = (path: string | null, focusDiff: boolean): boolean => {
    try {
      // 官方语义：打开即展开侧栏；seat 未挂载（无会话画面）时抛错，降级其他打开器
      service.openTab(OFFICIAL_TAB_KIND, { params: { openPath: path || undefined, focusDiff } })
    } catch (error) {
      log.warn('官方侧边栏打开失败（' + String(error) + '）')
      return false
    }
    return true
  }
  let typeDisposer: (() => void) | null = null
  try {
    // extension 档（默认且最高）：与官方内置类型同 kind 时接管，卸载后官方恢复
    typeDisposer = tabs.register({
      id: OFFICIAL_TAB_ID,
      kind: OFFICIAL_TAB_KIND,
      priority: 'extension',
      title: () => OFFICIAL_TAB_TITLE,
      guide: [{ order: 20, title: guide.title, description: guide.description }],
    })
  } catch (error) {
    log.warn('官方侧边栏 Tab 类型注册失败（' + String(error) + '），回退旧形态')
    return null
  }
  setEnsureSideEditor(open)
  const bodyDisposer = registerBodySlot(slots, OFFICIAL_TAB_ID, renderTab)
  return () => {
    if (typeof typeDisposer === 'function') typeDisposer()
    if (typeof bodyDisposer === 'function') bodyDisposer()
    setEnsureSideEditor(null)
  }
}

/**
 * 注册官方 file 资源地址认领（extension 档接管 `dsh-resource://file/**`，
 * 聊天文件链接/文件树打开改落本插件编辑器；注销后官方 textpreview 自动恢复）。
 * 认领与否由「文件链接使用工具」设置驱动（见 fileOpeners.shouldClaimFiles）。
 * @author ddj 2026年09月09号
 * @param options 装配参数（探测命中的注册表 + slots + 正文组件）
 * @returns 卸载器（反注册类型与正文）；类型注册抛错返回 null（回落官方查看器）
 */
export function registerOfficialFileClaim(options: {
  tabs: SidebarRightTabsLike
  slots: SlotsLike
  renderTab: unknown
}): (() => void) | null {
  const { tabs, slots, renderTab } = options
  let typeDisposer: (() => void) | null = null
  try {
    typeDisposer = tabs.register({
      id: OFFICIAL_FILE_TAB_ID,
      kind: OFFICIAL_FILE_KIND,
      patterns: [OFFICIAL_FILE_PATTERN],
      priority: 'extension',
      // 畸形/解码失败地址否决：回落官方 textpreview，不产生白屏 Tab
      canOpen: (address: string) => parseOfficialFileAddress(address) !== null,
      title: (address: string) => officialFileTitle(address),
    })
  } catch (error) {
    log.warn('官方 file 地址认领注册失败（' + String(error) + '），链接走官方查看器')
    return null
  }
  const bodyDisposer = registerBodySlot(slots, OFFICIAL_FILE_TAB_ID, renderTab)
  return () => {
    if (typeof typeDisposer === 'function') typeDisposer()
    if (typeof bodyDisposer === 'function') bodyDisposer()
  }
}

// --region 编辑 Tab 跨会话自动恢复

/** 编辑 Tab 是否处于激活态（正文挂载 = 激活；模块级，跨会话存活）。 */
let editorTabActive = false
/** 正文挂载纪元（每次挂载自增；延迟判定期间有新挂载则放弃清除）。 */
let mountEpoch = 0

/**
 * 标记编辑 Tab 激活并推进挂载纪元（正文挂载时调用）。
 * @author ddj 2026年09月09号
 */
export function markEditorMounted(): void {
  mountEpoch += 1
  markEditorActive(true)
}

/**
 * 直接设置激活标记（正文卸载延迟判定用；测试 also 用作状态编排入口）。
 * @author ddj 2026年09月09号
 * @param active 是否激活
 */
export function markEditorActive(active: boolean): void {
  editorTabActive = active
}

/**
 * 读编辑 Tab 激活标记（会话切换时决定是否自动恢复编辑栏）。
 * @author ddj 2026年09月09号
 * @returns 上次标记的激活状态
 */
export function isEditorTabActive(): boolean {
  return editorTabActive
}

/**
 * 读当前挂载纪元（卸载延迟判定用：纪元已推进 = 有新正文接管，不清标记）。
 * @author ddj 2026年09月09号
 * @returns 当前纪元
 */
export function editorMountEpoch(): number {
  return mountEpoch
}

/**
 * 在挂载会话恢复编辑 Tab：已激活跳过（官方幂等）；seat 未就绪抛错时有界重试。
 * openTab 官方语义「打开即展开侧栏」，一次调用同时完成展开 + 激活。
 * @author ddj 2026年09月09号
 * @param service 官方 sidebarRight 服务（缺失/未装配直接返回）
 * @param schedule 延时调度（ctx.timeout；重试节拍）
 * @param attempts 剩余尝试次数（默认 10 次 × 150ms ≈ 1.5s 窗口）
 */
export function restoreEditorTab(
  service: SidebarRightServiceLike | undefined | null,
  schedule: (fn: () => void, ms: number) => void,
  attempts = 10,
): void {
  if (!service || typeof service.openTab !== 'function' || !editorTabActive) return
  try {
    if (service.active?.()?.kind === OFFICIAL_TAB_KIND) return
    service.openTab(OFFICIAL_TAB_KIND, {})
  } catch {
    // seat 未挂载/未绑定（会话面尚未渲染）：等一拍再试，放弃后保持现状不阻塞
    if (attempts > 1) schedule(() => restoreEditorTab(service, schedule, attempts - 1), 150)
  }
}
// --endregion
