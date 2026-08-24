/**
 * dsh-vscode-mode 兼容层双面契约 — 与其他插件 / DSH 版本的探测与自诊断报告。
 * Purity rule: no node/react imports (same as types.ts / rpc.ts)。
 * 作者 ddj 2026-08-24
 */

/** 单项适配状态：外部插件/服务或护栏项，active 表示健康/生效。 */
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

/** 兼容性报告：host 侧构建（RPC edrv.compat 返回），client 侧补充本地适配项后展示。 */
export interface CompatReport {
  pluginVersion: string
  external: CompatAdapter[]
  guards: CompatAdapter[]
  warnings: string[]
  devForm?: DevFormInfo
}
