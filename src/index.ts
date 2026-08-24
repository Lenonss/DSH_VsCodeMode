/**
 * @dsh-external 生态 → dsh-vscode-mode：DSH 上的类 VSCode 编码体验（Host 半入口）。
 * 职责：装配 capture（tools/result 捕获 edit/write 差异）、RPC 分发（11 个 edrv.* 方法）、
 *       webServer 路由（/edrv/rpc、/edrv/assets/*、/edrv/vendor/*）、工作区旁车持久化。
 * 结构：shared/（双面契约） + model/store/capture/workspace/revert/registry/rpc/routes（host 模块）。
 * 作者 ddj 2026-08-20
 */
import { registerRoutes } from './routes.js'
import { captureToolResult } from './capture.js'
import { handleRpc } from './rpc.js'
import { newSearcher } from './search/orchestrator.js'
import { installIsolation } from './mcpIsolation.js'
import { dropFileIndex } from './workspace.js'
import { cwdOf } from './registry.js'
import { setupOpenSettings } from './fileOpenSettings.js'
import type { Registry } from './registry.js'
import type { Ctx } from './store.js'

export const name = "dsh-vscode-mode"
export const inject = ['sessions', 'fs', 'webServer', 'loader', 'tools', 'workspaceRegistry', 'agents']

/**
 * 装配插件：挂事件监听、注册路由。
 * @author ddj 2026年08月20号
 * @param ctx DSH 上下文（sessions/fs/webServer 由 inject 提供；sandboxPolicy/subprocess 惰性获取）
 * @param config 插件配置（可选 imageDir 覆盖图标目录）
 */
export function apply(ctx: Ctx, config?: unknown): void {
  const registry: Registry = new Map()
  const searcher = newSearcher(ctx)
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
    }
  })

  registerRoutes(ctx, config, (method, args) => handleRpc(ctx, registry, method, args, searcher))
  installIsolation(ctx)

  ctx.logger?.info?.('[' + name + '] 编辑差异审查已装配（/edrv/rpc 路由就绪，项目 MCP 隔离已启用）')
}
