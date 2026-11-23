/**
 * dsh-vscode-mode host — 宿主根作用域解析（跨 cordis 版本）。
 * 旧版 cordis 把根上下文挂在普通属性 `ctx.root` 上；新版 cordis 改存 `Symbol.for('cordis.root')`，
 * 并且读取已被移除的 `ctx.root` 会抛 `cannot get property "root" without inject`，
 * 直接读普通属性会让宿主 entry 激活失败。本模块只做一次按键取值，
 * 供模块级 WeakMap 作宿主级键使用（MCP 运行时 / 编辑串行锁 / 项目状态）。
 * 作者 ddj 2026年11月23号
 */
import type { Ctx } from './store.js'

/** 新版 cordis 的根上下文符号键；Symbol.for 保证与宿主内任意一份 cordis 副本一致。 */
const CONTEXT_ROOT = Symbol.for('cordis.root')

/** 上下文本身不可作键时（如 undefined）的进程级兜底作用域：一份插件模块对应一个宿主实例。 */
const fallbackScope: object = {}

/**
 * 判断取值能否作为 WeakMap 键。
 * @private @author ddj 2026年11月23号
 * @param value 待判定取值。
 * @returns 非 null 对象返回 true。
 */
function isScopeObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

/**
 * 读取旧版 cordis 挂在普通属性上的根上下文；新版宿主读取会抛错，此处吞掉并回落。
 * @private @author ddj 2026年11月23号
 * @param ctx 宿主上下文。
 * @returns 旧版根上下文；宿主不暴露该属性时返回 undefined。
 */
function legacyRootOf(ctx: Ctx): object | undefined {
  try {
    const root = ctx?.root
    return isScopeObject(root) ? root : undefined
  } catch {
    return undefined
  }
}

/**
 * 取得宿主根作用域，作为模块级状态的宿主级键。
 * 取值顺序：新版符号 → 旧版普通属性 → 上下文自身（与旧写法 `ctx.root ?? ctx` 一致，
 * 保证没有根信息的宿主（含测试桩）各自成键，不被合并成同一个作用域）。
 * @public @author ddj 2026年11月23号
 * @param ctx 宿主上下文，任意子上下文均可。
 * @returns 宿主根作用域；上下文不可作键时返回进程级兜底作用域。
 */
export function hostRootOf(ctx: Ctx): object {
  const root = ctx?.[CONTEXT_ROOT] ?? legacyRootOf(ctx)
  if (isScopeObject(root)) return root

  return isScopeObject(ctx) ? (ctx as object) : fallbackScope
}
