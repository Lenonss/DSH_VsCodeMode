/**
 * dsh-vscode-mode client — 快捷菜单 store（文档 + 绑定快照 + 坐标防抖）。
 *
 * 为什么客户端要 store：菜单在多列里同时展示，多列共享同一份文档与绑定校验结果；
 * 用外部 store + useSyncExternalStore，避免把整棵树塞进一个组件的 state。
 * 写入一律「先改内存 → 整体提交 → host 归一后回传」；冲突（其他窗口改过）时重拉，
 * 不拿本地旧版本覆盖磁盘。
 * 作者 ddj 2026年10月30号
 */
import { defaultDoc, descendantIds, newQuickId, normalizeDoc } from '../shared/quickMenu.js'
import type { QuickMenuDoc, QuickMenuItem, RuleListSnapshot, ValidateContext } from '../shared/quickMenu.js'
import { rpc } from './rpc.js'

/** 菜单加载状态。 */
export interface QuickMenuSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** 当前文档（loading/error 时为默认或上次成功的文档）。 */
  doc: QuickMenuDoc
  /** 读取/保存失败文案。 */
  error?: string
  /** host 读取告警（配置损坏已重置等）。 */
  warning?: string
}

/** 当前会话与工作区快照。 */
export interface QuickMenuScope {
  sessionId?: string
  cwd?: string
}

/** 外部数据加载器（由 client 入口注入，避免 store 依赖 ctx 细节）。 */
export interface QuickMenuLoaders {
  /** 读取规则列表（rules.list）。 */
  rules(): Promise<RuleListSnapshot>
  /** 读取会话可见技能名；无法枚举时返回 null。 */
  skills(sessionId: string): Promise<string[] | null>
  /** 当前会话与工作区（每次调用取最新值）。 */
  scope(): QuickMenuScope
}

/** 一次写操作结果。 */
export interface QuickMenuMutation {
  ok: boolean
  error?: string
}

/** store 对外能力。 */
export interface QuickMenuStore {
  subscribe(listener: () => void): () => void
  /** 版本号（useSyncExternalStore 的快照值）。 */
  getVersion(): number
  getState(): QuickMenuSnapshot
  /** 当前校验上下文（绑定失效判定用）。 */
  getContext(): ValidateContext
  load(force?: boolean): Promise<void>
  save(doc: QuickMenuDoc): Promise<QuickMenuMutation>
  createItem(draft: QuickMenuItem): Promise<QuickMenuMutation>
  updateItem(next: QuickMenuItem): Promise<QuickMenuMutation>
  removeItem(id: string): Promise<QuickMenuMutation>
  /** 记录悬浮按钮坐标（500ms 防抖落盘）。 */
  patchLauncher(x: number | null, y: number | null): void
  /** 立即落盘待写坐标（松手/卸载时调用）。 */
  flushLauncher(): Promise<void>
  refreshBindings(force?: boolean): Promise<void>
  /** 悬浮按钮是否已挂载（= 当前 DSH 具备 shell.overlay）。 */
  markMounted(mounted: boolean): void
  isMounted(): boolean
  /** 生成新项 id。 */
  nextId(type: 'group' | 'button'): string
}

/** 绑定快照有效期（菜单打开/聚焦时刷新，期间复用）。 */
const BINDINGS_TTL_MS = 60_000
/** 坐标落盘防抖。 */
const LAUNCHER_DEBOUNCE_MS = 500

/**
 * 创建快捷菜单 store。
 * @author ddj 2026年10月30号
 * @param loaders 外部数据加载器
 * @returns store 实例
 */
export function createMenuStore(loaders: QuickMenuLoaders): QuickMenuStore {
  let state: QuickMenuSnapshot = { status: 'idle', doc: defaultDoc() }
  let version = 0
  let mounted = false
  const listeners = new Set<() => void>()
  /** 绑定快照（cwd/sessionId 变化或超期即重拉）。 */
  let bindings: { at: number; cwd?: string; sessionId?: string; rules?: RuleListSnapshot; skillNames?: string[] | null } = { at: 0 }
  /** 待落盘坐标与定时器。 */
  let pending: { x: number | null; y: number | null } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  /**
   * 写入状态并通知订阅者。
   * @author ddj 2026年10月30号
   * @param next 新状态
   */
  function publish(next: QuickMenuSnapshot): void {
    state = next
    version += 1
    for (const listener of listeners) listener()
  }

  /**
   * 合并补丁到当前状态。
   * @author ddj 2026年10月30号
   * @param patch 局部更新
   */
  function patch(patchState: Partial<QuickMenuSnapshot>): void {
    publish({ ...state, ...patchState })
  }

  /**
   * 读取规则与技能快照（失败保留旧值，不打断菜单）。
   * @author ddj 2026年10月30号
   * @param force 是否强制重拉
   */
  async function refreshBindings(force = false): Promise<void> {
    const scope = loaders.scope()
    const fresh = !force && Date.now() - bindings.at < BINDINGS_TTL_MS
    if (fresh && bindings.cwd === scope.cwd && bindings.sessionId === scope.sessionId) return
    bindings = { ...bindings, at: Date.now(), cwd: scope.cwd, sessionId: scope.sessionId }
    try {
      bindings.rules = await loaders.rules()
    } catch {
      // 规则服务不可用：保持 undefined（界面显示「未校验」，不误报失效）
      bindings.rules = undefined
    }
    try {
      bindings.skillNames = scope.sessionId ? await loaders.skills(scope.sessionId) : null
    } catch {
      bindings.skillNames = null
    }
    version += 1
    for (const listener of listeners) listener()
  }

  /**
   * 拉取文档（并顺带刷新绑定快照）。
   * @author ddj 2026年10月30号
   * @param force 是否强制重拉
   */
  async function load(force = false): Promise<void> {
    if (state.status === 'loading') return
    patch({ status: 'loading' })
    try {
      const result = await rpc('quickMenu.get', {})
      if (result.ok) patch({ status: 'ready', doc: result.doc, warning: result.warning, error: undefined })
      else patch({ status: 'error', error: result.error })
    } catch (error) {
      patch({ status: 'error', error: '读取快捷菜单失败：' + String(error) })
    }
    await refreshBindings(force)
  }

  /**
   * 提交整份文档（host 归一后回传，冲突时重拉）。
   * @author ddj 2026年10月30号
   * @param doc 待提交文档
   * @returns 写结果
   */
  async function save(doc: QuickMenuDoc): Promise<QuickMenuMutation> {
    try {
      const result = await rpc('quickMenu.save', { doc, baseRevision: state.doc.revision })
      if (result.ok) {
        patch({ status: 'ready', doc: result.doc, error: undefined, warning: undefined })
        return { ok: true }
      }
      await load(true)
      return { ok: false, error: result.error }
    } catch (error) {
      return { ok: false, error: '保存快捷菜单失败：' + String(error) }
    }
  }

  /**
   * 新增或替换一项（按 id 去重）。
   * @author ddj 2026年10月30号
   * @param draft 菜单项
   * @returns 写结果
   */
  async function upsert(draft: QuickMenuItem): Promise<QuickMenuMutation> {
    const items = state.doc.items.filter((item) => item.id !== draft.id)
    items.push(draft)
    return save(normalizeDoc({ ...state.doc, items }))
  }

  /**
   * 删除一项及其全部子项。
   * @author ddj 2026年10月30号
   * @param id 项 id
   * @returns 写结果
   */
  async function removeItem(id: string): Promise<QuickMenuMutation> {
    const doomed = descendantIds(state.doc, id)
    const items = state.doc.items.filter((item) => !doomed.includes(item.id))
    return save(normalizeDoc({ ...state.doc, items }))
  }

  /**
   * 定时把待写坐标落盘。
   * @author ddj 2026年10月30号
   */
  async function flushLauncher(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const target = pending
    pending = null
    if (!target) return
    try {
      const result = await rpc('quickMenu.launcher', target)
      if (result.ok) patch({ doc: result.doc })
    } catch {
      // 位置保存失败无碍主流程：下次拖动会重试
    }
  }

  /**
   * 记录坐标并防抖落盘。
   * @author ddj 2026年10月30号
   * @param x 横坐标
   * @param y 纵坐标
   */
  function patchLauncher(x: number | null, y: number | null): void {
    pending = { x, y }
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => { void flushLauncher() }, LAUNCHER_DEBOUNCE_MS)
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getVersion(): number { return version },
    getState(): QuickMenuSnapshot { return state },
    getContext(): ValidateContext {
      const scope = loaders.scope()
      return { cwd: scope.cwd, rules: bindings.rules, skillNames: bindings.skillNames ?? null }
    },
    load,
    save,
    createItem: upsert,
    updateItem: upsert,
    removeItem,
    patchLauncher,
    flushLauncher,
    refreshBindings,
    markMounted(value: boolean): void {
      mounted = value
      version += 1
      for (const listener of listeners) listener()
    },
    isMounted(): boolean { return mounted },
    nextId(type: 'group' | 'button'): string { return newQuickId(type) },
  }
}
