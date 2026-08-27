/**
 * @dsh-external 生态 → dsh-vscode-mode：DSH 上的类 VSCode 编码体验（Host 半入口）。
 * 职责：装配 capture（tools/result 捕获 edit/write 差异）、RPC 分发（edrv.* / mcp.* / vscode.* / compat）、
 *       webServer 路由（/edrv/rpc、/edrv/assets/*、/edrv/vendor/*）、工作区旁车持久化、
 *       兼容层装配（依赖守卫 + 重复装配自诊断 + 启动日志兼容性报告）。
 * 结构：shared/（双面契约） + model/store/capture/workspace/revert/registry/rpc/routes/compat（host 模块）。
 * 作者 ddj 2026-08-20
 */
import { registerRoutes } from './routes.js'
import { captureToolResult } from './capture.js'
import { handleRpc } from './rpc.js'
import { newSearcher } from './search/orchestrator.js'
import { newContentSearcher } from './search/content.js'
import { installIsolation } from './mcpIsolation.js'
import { dropFileIndex } from './workspace.js'
import { cwdOf } from './registry.js'
import { setupOpenSettings } from './fileOpenSettings.js'
import { disposeIndex } from './treeIndex.js'
import { sweepTreeCache } from './paths.js'
import { PLUGIN_NAME, buildReport } from './compat.js'
import type { Registry } from './registry.js'
import type { Ctx } from './store.js'

export const name = "dsh-vscode-mode"
export const inject = ['sessions', 'fs', 'webServer', 'loader', 'tools', 'workspaceRegistry', 'agents']

/**
 * 装配插件：挂事件监听、注册路由、安装兼容层。
 * @author ddj 2026年08月20号
 * @param ctx DSH 上下文（sessions/fs/webServer 由 inject 提供；sandboxPolicy/subprocess 惰性获取）
 * @param config 插件配置（可选 imageDir 覆盖图标目录）
 */
export function apply(ctx: Ctx, config?: unknown): void {
  const registry: Registry = new Map()
  const searcher = newSearcher(ctx)
  const contentSearcher = newContentSearcher(ctx)
  /** 兼容性警告收集（route 护栏等写入，启动日志一并输出）。 */
  const warnings: string[] = []
  setupOpenSettings(ctx, config, () => {})

  ctx.on('tools/result', (exec: unknown, result: unknown) => {
    void captureToolResult(ctx, registry, exec, result)
  })

  ctx.on('session/disposed', (session: unknown) => {
    const cwd = cwdOf(session as never)
    if (cwd) {
      registry.delete(cwd)
      dropFileIndex(cwd)
      searcher.dispose(cwd)
      contentSearcher.dispose(cwd)
      disposeIndex(cwd)
    }
  })

  registerRoutes(ctx, config, (method, args) => handleRpc(ctx, registry, method, args, searcher, contentSearcher), (warning) => warnings.push(warning))
  installIsolation(ctx)
  // 启动清理缓存目录：非当前 schema / 超保留期 / 未知残留（best-effort，不阻塞装配）
  void sweepTreeCache()
  void logCompatSummary(ctx, warnings)

  ctx.logger?.info?.('[' + name + '] 编辑差异审查已装配（/edrv/rpc 路由就绪，项目 MCP 隔离已启用）')
}

/**
 * 异步输出兼容性报告摘要（含重复装配/路由冲突自诊断）。
 * @author ddj 2026年08月24号
 * @param ctx DSH host 上下文
 * @param warnings 装配期收集的兼容性警告
 */
async function logCompatSummary(ctx: Ctx, warnings: string[]): Promise<void> {
  try {
    const report = await buildReport(ctx)
    for (const warning of warnings) report.warnings.push(warning)
    const logger = ctx.logger
    if (!logger?.info) return
    const head = '[' + PLUGIN_NAME + '] 兼容性：' + report.external.length + ' 项外部适配 / ' + report.guards.length + ' 项护栏'
    if (report.warnings.length) {
      logger.warn?.(head + '，警告 ' + report.warnings.length + ' 条：' + report.warnings.join('；'))
    } else {
      logger.info?.(head + '，无警告')
    }
  } catch (error) {
    ctx.logger?.warn?.('[' + PLUGIN_NAME + '] 兼容性报告生成失败：' + String(error))
  }
}
