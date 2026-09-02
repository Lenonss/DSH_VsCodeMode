/**
 * dsh-vscode-mode 兼容层双面契约 — 与其他插件 / DSH 版本的探测与自诊断报告。
 * Purity rule: no node/react imports (same as types.ts / rpc.ts)。
 * 作者 ddj 2026-08-24 / 2026-09-02
 */

/** 单项适配状态：外部插件/服务、护栏或版本适配项，active 表示健康/生效。 */
export interface CompatAdapter {
  name: string
  active: boolean
  note?: string
}

/** 开发形态信息：profile 中以 link: 依赖 + junction 指向工作区的安装形态。 */
export interface DevFormInfo {
  enabled: boolean
  path?: string
}

/**
 * 兼容性报告：host 侧构建（RPC edrv.compat 返回），client 侧补充本地适配项后展示。
 * dshVersion = 运行中 DSH 核心版本（未探测到为空串）；adapters = 版本适配机制状态行
 * （旧客户端忽略未知字段，安全前向兼容）。
 */
export interface CompatReport {
  pluginVersion: string
  external: CompatAdapter[]
  guards: CompatAdapter[]
  warnings: string[]
  devForm?: DevFormInfo
  dshVersion?: string
  adapters?: CompatAdapter[]
}
