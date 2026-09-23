/**
 * dsh-vscode-mode client — 原生打开范围的运行时状态（设置值缓存 + 官方打开 handler）。
 * 职责：
 * 1. 缓存设置字段 `nativeOpenExts` 的解析结果（mountSettingsSyncs 的 keybindings 同步
 *    块每拍推送；旧版设置无该字段 → 保持默认集，与 deferToOfficial 同源 shared 事实源）；
 * 2. 持有「原生打开」执行 handler（index.ts 装配时注册 sidebarRight.openResource 包装），
 *    EditorView 的 openFile 链路命中判定时调用，失败回退现状打开。
 * 单例模块级状态：值变更经 CustomEvent 广播（跨组件按需订阅；消费方多为每调用读缓存）。
 * @author ddj 2026年09月22号
 */
import { DEFAULT_NATIVE_CSV, DEFAULT_NATIVE_EXT, inNativeOpen, parseExtCsv } from '../shared/nativeOpen.js'

/** 设置值变化广播事件名（mountSettingsSyncs 推送时派发；幂等值不派发）。 */
export const NATIVE_OPEN_EVENT = 'edrv:native-open-exts-change'

/** 当前设置串（设置页回显 / 诊断用）。 */
let csv = DEFAULT_NATIVE_CSV
/** 解析后的后缀集合（热路径读取，避免每次点击 split）。 */
let exts: ReadonlySet<string> = new Set(DEFAULT_NATIVE_EXT)
/** 官方原生打开 handler（index.ts 装配注册；返回 false/缺失 = 回退现状打开）。 */
let handler: ((path: string) => boolean) | null = null

/**
 * 读当前原生打开设置串。
 * @author ddj 2026年09月22号
 * @returns 逗号分隔后缀串
 */
export function nativeCsv(): string {
  return csv
}

/**
 * 该路径是否命中用户配置的原生打开范围（不含 deferToOfficial 默认让位语义——
 * 那部分由调用方自行取并，保持两判定各司其职）。
 * @author ddj 2026年09月22号
 * @param path 文件路径
 * @returns 是否命中
 */
export function inNativePath(path: unknown): boolean {
  return inNativeOpen(path, exts)
}

/**
 * 推送设置值（mountSettingsSyncs 每拍调用）：解析为集合，值变化才更新并广播。
 * 非法/空输入 → 回落默认集（与 host schema default 同源）。
 * @author ddj 2026年09月22号
 * @param value 设置原值（unknown，兼容旧版 undefined）
 */
export function setNativeCsv(value: unknown): void {
  const next = typeof value === 'string' && value.trim() ? value : DEFAULT_NATIVE_CSV
  if (next === csv) return
  csv = next
  exts = parseExtCsv(next)
  if (exts.size === 0) exts = new Set(DEFAULT_NATIVE_EXT)
  try {
    window.dispatchEvent(new CustomEvent(NATIVE_OPEN_EVENT, { detail: { value: csv } }))
  } catch {
    /* 无 window 环境（测试）：仅内存更新 */
  }
}

/**
 * 注册原生打开执行 handler（index.ts 在官方 sidebarRight.openResource 可用时注册）。
 * @author ddj 2026年09月22号
 * @param fn handler（返回是否已原生打开成功）；null 解除
 */
export function setNativeOpenHandler(fn: ((path: string) => boolean) | null): void {
  handler = fn
}

/**
 * 尝试原生打开（EditorView openFile 链路命中判定时调用）。
 * @author ddj 2026年09月22号
 * @param path 文件路径
 * @returns true=已走官方原生打开；false=handler 缺失或失败（调用方回退现状）
 */
export function tryNativeOpen(path: string): boolean {
  if (!handler) return false
  try {
    return handler(path) === true
  } catch {
    return false
  }
}

/** 复位（卸载/测试隔离用：回默认集、解绑 handler）。 */
export function resetNativeOpen(): void {
  csv = DEFAULT_NATIVE_CSV
  exts = new Set(DEFAULT_NATIVE_EXT)
  handler = null
}
