/**
 * dsh-vscode-mode client — 兼容层：设置桥选择 / slot 安全注册 / openPath 链式补丁 / 外部插件常量。
 * 纯逻辑与薄 ctx 胶水，node 环境可单测（不依赖 DOM）。
 * 作者 ddj 2026年08月24号
 */
import { log } from './log.js'

/** 本插件包名（与 host compat.PLUGIN_NAME 对应）。 */
export const PLUGIN_NAME = 'dsh-vscode-mode'
/** 外部侧栏插件名（dsh-web-ui-all 家族的文件打开能力提供方）。 */
export const SIDEBAR_PLUGIN = 'dsh-better-sidebar'

/** 设置值的已知业务字段（各设置桥透传的 namespace 内容）。 */
export interface SettingsValueLike {
  fileOpenTool?: unknown
  keybindings?: Record<string, string>
  sidebarMinWidth?: unknown
  maxOpenEditors?: unknown
  /** 原生打开范围（逗号分隔后缀；0.1.7 批次新增，旧版 undefined → 默认集）。 */
  nativeOpenExts?: unknown
}

/** 设置 scope 的跨组件上下文形状（与设置桥绑定的最小面：settingsScope / configForms 适配后同形）。 */
export interface SettingsScopeLike {
  getSnapshot: () => { status?: string; value?: SettingsValueLike; writable?: boolean }
  subscribe: (listener: () => void) => () => void
  set: (field: string, value: unknown) => Promise<void>
}

/** DSH 0.1.7+ configForms 服务最小面（0.1.6 无此服务，探测必须可降级）。 */
interface ConfigFormsService {
  get?: (entryId: string) => unknown
}

/** DSH 0.1.7+ 单个 ConfigForm 最小面（适配 SettingsScopeLike 所需子集）。 */
interface ConfigFormLike {
  getSnapshot: () => { status?: string; value?: unknown; writable?: boolean }
  subscribe: (listener: () => void) => () => void
  set: (field: string, value: unknown) => Promise<unknown>
}

/**
 * 形状守卫：判断 configForms.get 返回值是否具备适配所需的最小面。
 * @author ddj 2026年09月22号
 * @param form configForms.get(entryId) 的返回值
 * @returns 是否为可用 ConfigForm
 */
function isConfigForm(form: unknown): form is ConfigFormLike {
  if (!form || typeof form !== 'object') return false
  const candidate = form as Partial<ConfigFormLike>
  return typeof candidate.getSnapshot === 'function'
    && typeof candidate.subscribe === 'function'
    && typeof candidate.set === 'function'
}

/**
 * 将 DSH 0.1.7 ConfigForm 适配为既有 SettingsScopeLike（调用方零改动）。
 * status/value/writable 直接透传（'ready'|'loading'|'unavailable' 与既有 status 词汇一致）；
 * set 丢弃返回的 boolean（避免给未 catch 的既有调用方新增拒绝；form.set 自身 reject 仍传导）。
 * @author ddj 2026年09月22号
 * @param form configForms.get(PLUGIN_NAME) 返回的表单
 * @returns 适配后的设置 scope
 */
function adaptConfigForm(form: ConfigFormLike): SettingsScopeLike {
  return {
    getSnapshot: () => {
      const snap = form.getSnapshot()
      return { status: snap.status, value: snap.value as SettingsValueLike | undefined, writable: snap.writable }
    },
    subscribe: (listener) => form.subscribe(listener),
    set: async (field, value) => { await form.set(field, value) },
  }
}

/**
 * 探测 DSH 0.1.7+ configForms 官方新设置桥（entryId = PLUGIN_NAME）。
 * 0.1.6 无该服务、ctx.get/表单 get 抛错或形状不符时返回 undefined，交由原两级桥降级。
 * @author ddj 2026年09月22号
 * @param ctx 客户端服务上下文
 * @returns 适配后的设置 scope 或 undefined
 */
function bindConfigForm(ctx: { get: (name: string) => unknown }): SettingsScopeLike | undefined {
  try {
    const forms = ctx.get('configForms') as ConfigFormsService | undefined
    const form = forms?.get?.(PLUGIN_NAME)
    if (!isConfigForm(form)) return undefined
    return adaptConfigForm(form)
  } catch {
    return undefined
  }
}

/**
 * 设置桥优先序：configForms（DSH 0.1.7+ 官方新桥）→ webUiSettings（linxin666 兼容桥，
 * 旧版现网优先级不变）→ settingsScope（DSH 0.1.6 官方旧桥）→ 无。
 * 桥绑定抛错时降级到下一级，不让单个桥异常拖垮设置装配。
 * @author ddj 2026年08月24号（2026年09月22号 增补 configForms 桥）
 * @param ctx 客户端服务上下文
 * @returns 激活的桥名称与绑定 scope
 */
export function pickSettingsBinder(ctx: { get: (name: string) => unknown }): { service: string; scope: SettingsScopeLike | undefined } {
  const configForm = bindConfigForm(ctx)
  if (configForm) return { service: 'configForms', scope: configForm }
  for (const service of ['webUiSettings', 'settingsScope']) {
    try {
      const binder = ctx.get(service) as { bind?: (spec: { namespace: string }) => SettingsScopeLike } | undefined
      const scope = binder?.bind?.({ namespace: PLUGIN_NAME })
      if (scope) return { service, scope }
    } catch {
      /* 桥异常时降级到下一级 */
    }
  }
  return { service: 'none', scope: undefined }
}

/** 设置桥形状（探测 + 晚到有界重试 + 就绪通知；调用方按需取用）。 */
export interface SettingsBridge {
  scope: () => SettingsScopeLike | undefined
  service: () => string
  whenReady: (listener: () => void) => () => void
}

/**
 * 设置桥装配（带晚到有界重试）：设置桥服务一律不进 inject（0.1.6 settingsScope /
 * 0.1.7 configForms 互斥，写死任一桥名都会在另一版本停等），因此提供方可能晚于本插件
 * apply 就绪——构造时探测一次，未命中则按 schedule 节奏有界重试，命中即通知 whenReady
 * 订阅者（重挂设置同步 effect）；重试用尽保持未就绪（与旧行为一致，不无限轮询）。
 * @author ddj 2026年09月22号
 * @param ctx 客户端服务上下文
 * @param options schedule 注入（缺省不重试=旧行为）；attempts/intervalMs 重试节奏
 * @returns 设置桥
 */
export function settingsBridge(
  ctx: { get: (name: string) => unknown },
  options?: { schedule?: (fn: () => void, ms: number) => void; attempts?: number; intervalMs?: number },
): SettingsBridge {
  let hit = pickSettingsBinder(ctx)
  let attemptsLeft = options?.attempts ?? 0
  const interval = options?.intervalMs ?? 2000
  const waiters: Array<() => void> = []
  const notify = (): void => {
    for (const listener of waiters.splice(0)) {
      try { listener() } catch { /* 单个订阅者异常不拖垮其余 */ }
    }
  }
  const retry = (): void => {
    if (hit.scope || attemptsLeft <= 0 || !options?.schedule) return
    attemptsLeft -= 1
    options.schedule(() => {
      hit = pickSettingsBinder(ctx)
      if (hit.scope) { notify(); return }
      retry()
    }, interval)
  }
  retry()
  return {
    scope: () => hit.scope,
    service: () => hit.service,
    whenReady: (listener) => {
      if (hit.scope) { listener(); return () => {} }
      waiters.push(listener)
      return () => {
        const at = waiters.indexOf(listener)
        if (at >= 0) waiters.splice(at, 1)
      }
    },
  }
}

/** slot 注册描述（对齐 ctx.slots.register 的形状）。 */
export interface SlotSpec {
  name: string
  id: string
  order?: number
  label?: string
  inject?: (sessionId: string) => object
}

/**
 * 跨版本 slot 安全注册：封装 ctx.slots.inject 等待声明模式（新老 DSH 通用），
 * 服务缺失或注册抛错时降级为警告，不让单条 slot 拖垮装配。
 * 注意：方法必须挂在服务对象上调用（slots.register 是依赖 this.records 的类方法，
 * 解构后 this 丢失会静默失败），故禁止解构。
 * @author ddj 2026年08月24号
 * @param ctx 客户端上下文（slots 服务）
 * @param spec slot 描述
 * @param render 渲染函数
 * @returns 注销函数（未注册返回 null；形态切换时用于卸载旧 slot）
 */
export function registerSlotSafely(ctx: { slots?: { inject?: (name: string, register: () => unknown) => unknown; register?: (...args: unknown[]) => unknown } }, spec: SlotSpec, render: (props: unknown) => unknown): (() => void) | null {
  const slots = ctx?.slots as { inject: (name: string, register: () => unknown) => unknown; register: (...args: unknown[]) => unknown } | undefined
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    log.warn('slots 服务不可用，跳过 slot ' + spec.name)
    return null
  }
  try {
    const disposer = slots.inject(spec.name, () => slots.register(spec, render))
    return typeof disposer === 'function' ? disposer as () => void : null
  } catch (error) {
    log.warn('slot ' + spec.name + ' 注册失败（' + String(error) + '），已跳过')
    return null
  }
}

/**
 * 链式补丁对象方法：保存原实现、装入包装实现，dispose 恢复。
 * 恢复带归属校验（仅当当前实现仍是本包装时还原），多插件补丁按栈序互不踩踏。
 * @author ddj 2026年08月24号
 * @param owner 目标对象
 * @param key 方法名
 * @param wrapper 包装实现（original 为补丁前的实现）
 * @returns 恢复函数（幂等）
 */
export function patchMethod<T extends object, K extends keyof T>(
  owner: T,
  key: K,
  wrapper: (original: T[K], ...args: never[]) => unknown,
): () => void {
  const original = owner[key]
  const patched = ((...args: never[]) => wrapper(original, ...args)) as T[K]
  owner[key] = patched
  return () => {
    if (owner[key] === patched) owner[key] = original
  }
}

/** patchAccessor 的包装实现形状（original 为补丁前的实时实现）。 */
export type PatchWrapper = (original: (...args: never[]) => unknown, ...args: never[]) => unknown

/**
 * accessor 感知的链式补丁：DSH 0.1.3+ 的 remote 命名空间方法（如
 * remote.session.openWorkspacePath）是 getter-only accessor（Object.defineProperty
 * 仅定义 get，直接赋值在严格模式下抛 TypeError），须整体替换属性描述符。
 * 新 getter 每次访问现场调用原 getter 取最新一次性函数作 original，天然跟随
 * DSH 内部 methods 表变化；data 属性降级走 patchMethod；属性缺失返回 null。
 * @author ddj 2026年09月08号
 * @param owner 目标对象
 * @param key 属性名
 * @param wrapper 包装实现（original 为补丁前的实时实现）
 * @returns 恢复函数（幂等、带归属校验）；属性缺失时返回 null
 */
export function patchAccessor(owner: object, key: string, wrapper: PatchWrapper): (() => void) | null {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key)
  if (!descriptor) return null
  if (typeof descriptor.get !== 'function') return patchMethod(owner, key as never, wrapper as never)
  const rawGet = descriptor.get as (this: object) => unknown
  const patchedGet = function (): unknown {
    const original = (...args: never[]) => (rawGet.call(owner) as (...args: never[]) => unknown)(...args)
    return (...args: never[]) => wrapper(original, ...args)
  }
  Object.defineProperty(owner, key, { configurable: true, enumerable: descriptor.enumerable, get: patchedGet })
  return () => {
    const current = Object.getOwnPropertyDescriptor(owner, key)
    if (current?.get === patchedGet) Object.defineProperty(owner, key, descriptor)
  }
}
