/**
 * dsh-vscode-mode client — 兼容层：设置桥选择 / slot 安全注册 / openPath 链式补丁 / 外部插件常量。
 * 纯逻辑与薄 ctx 胶水，node 环境可单测（不依赖 DOM）。
 * 作者 ddj 2026年08月24号
 */

/** 本插件包名（与 host compat.PLUGIN_NAME 对应）。 */
export const PLUGIN_NAME = 'dsh-vscode-mode'
/** 外部侧栏插件名（dsh-web-ui-all 家族的文件打开能力提供方）。 */
export const SIDEBAR_PLUGIN = 'dsh-better-sidebar'

/** 设置 scope 的跨组件上下文形状（与官方 settingsScope 绑定的最小面）。 */
export interface SettingsScopeLike {
  getSnapshot: () => { status?: string; value?: { fileOpenTool?: unknown; keybindings?: Record<string, string>; sidebarMinWidth?: unknown }; writable?: boolean }
  subscribe: (listener: () => void) => () => void
  set: (field: string, value: unknown) => Promise<void>
}

/**
 * 设置桥三级优先：webUiSettings（linxin666 兼容桥）→ settingsScope（官方）→ 无。
 * 桥绑定抛错时降级到下一级，不让单个桥异常拖垮设置装配。
 * @author ddj 2026年08月24号
 * @param ctx 客户端服务上下文
 * @returns 激活的桥名称与绑定 scope
 */
export function pickSettingsBinder(ctx: { get: (name: string) => unknown }): { service: string; scope: SettingsScopeLike | undefined } {
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
    console.warn('[' + PLUGIN_NAME + '] slots 服务不可用，跳过 slot ' + spec.name)
    return null
  }
  try {
    const disposer = slots.inject(spec.name, () => slots.register(spec, render))
    return typeof disposer === 'function' ? disposer as () => void : null
  } catch (error) {
    console.warn('[' + PLUGIN_NAME + '] slot ' + spec.name + ' 注册失败（' + String(error) + '），已跳过')
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
