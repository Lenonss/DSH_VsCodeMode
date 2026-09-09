/**
 * dsh-vscode-mode client — 日志单例（全 client 面唯一日志入口）。
 * client 无 ctx.logger 服务，固定 console 出口；格式/级别语义与 host 面一致（shared/logger.ts）。
 * 用法：`import { log } from './log.js'` → `log.debug/info/warn/error(msg)`；子域用 `log.child('scope')`。
 * 作者 ddj 2026-09-08
 */
import { createLogger } from '../shared/logger.js'

/** client 面插件日志单例。 */
export const log = createLogger()
