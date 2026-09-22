/**
 * dsh-vscode-mode host — 调试适配器规格解析：按调试类型从扩展清单声明（discovery）
 * 解析 spawn 规格，通用不限定语言：
 * - runtime='node' → node 跑 js 入口（emmylua 形态，等价旧 process.execPath 硬编码）；
 * - 无 runtime → program 即原生可执行（clrdbg/monodbg 形态，args 为清单声明如 --interpreter=vscode）；
 * - 其它 runtime 明确不支持（decl.available=false 带原因，不做假启动）。
 * 旧版仅探测 tangzx.emmylua 两型（attach/new），由清单驱动后自然覆盖并扩展到任意适配器。
 * 作者 ddj 2026年09月29号 / 2026年09月21号
 */
import { debuggerDecls } from './discovery.js'

/** 适配器启动规格（spawn 参数）。 */
export interface DapAdapterSpec {
  /** 调试类型（= initialize.adapterID）。 */
  type: string
  /** 可执行文件（node 型 = node 本体；直启型 = 适配器本体）。 */
  command: string
  /** 启动参数（node 型 = [program]；直启型 = 清单声明 args）。 */
  args: string[]
  /** 扩展根目录（emmylua 兼容 shim 注入 extensionPath 用）。 */
  extensionPath: string
  /** 来源扩展 id（publisher.name；emmylua 兼容 shim 判定）。 */
  extensionId: string
  /** 可下断点扩展名（断点下发语言过滤；空 = 不限）。 */
  exts: string[]
  /** 探测描述（错误提示用）。 */
  detail: string
}

/**
 * 解析某调试类型的适配器启动规格。
 * @author ddj 2026年09月29号 / 2026年09月21号
 * @param type 调试类型（launch.json type = 清单 contributes.debuggers.type）
 * @param force 强制重扫扩展清单（测试隔离用）
 * @param home DSH home（缺省真实；测试可注入）
 * @returns 启动规格；类型未发现 / 不可用 / runtime 不支持返回 null（原因见 discovery 声明）
 */
export function resolveAdapterSpec(type: string, force = false, home?: string): DapAdapterSpec | null {
  const decl = debuggerDecls(force, home).find((d) => d.type === type)
  if (!decl || !decl.available) return null
  const base = { type, extensionPath: decl.extensionPath, extensionId: decl.extensionId, exts: decl.exts, detail: decl.extensionPath }
  if (decl.runtime === 'node') {
    return { ...base, command: process.execPath, args: [decl.program, ...decl.args] }
  }
  if (!decl.runtime) {
    return { ...base, command: decl.program, args: [...decl.args] }
  }
  return null
}
