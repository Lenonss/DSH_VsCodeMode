/**
 * dsh-vscode-mode host — 日志单例（全 host 面唯一日志入口）。
 * 默认 console 出口；apply() 首行调 bindHostLog(ctx) 切到 ctx.logger（缺失回退 console）。
 * 用法：`import { log } from './log.js'` → `log.debug/info/warn/error(msg)`；子域用 `log.child('scope')`。
 * 作者 ddj 2026-09-08
 */
import { createLogger, ctxLogSink } from './shared/logger.js'

/** host 面插件日志单例（格式/级别语义见 shared/logger.ts 头注释）。 */
export const log = createLogger()

/**
 * 装配期绑定 host 日志出口：ctx.logger 可用时全部日志转经 DSH 日志系统。
 * @author ddj 2026年09月08号
 * @param ctx DSH host 上下文（logger 服务缺失时保持 console 出口）
 */
export function bindHostLog(ctx: unknown): void {
  log.bind(ctxLogSink(ctx))
}
