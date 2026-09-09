/**
 * @dsh-external 生态 → dsh-vscode-mode：DSH 上的类 VSCode 编码体验（Host 半入口）。
 * 职责：装配 capture（tools/result 捕获 edit/write 差异）、RPC 分发（edrv.* / mcp.* / vscode.* / compat）、
 *       webServer 路由（/edrv/rpc、/edrv/assets/*、/edrv/vendor/*）、工作区旁车持久化、
 *       兼容层装配（依赖守卫 + 重复装配自诊断 + 启动日志兼容性报告）。
 * 结构：shared/（双面契约） + model/store/capture/workspace/revert/registry/rpc/routes/compat（host 模块）
 *       + log/debugLog（统一日志：bindHostLog 绑定 ctx.logger，edrv.debug 诊断文件通道）。
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
import { shellMenuLifecycle } from './integrate.js'
import { disposeIndex } from './treeIndex.js'
import { sweepTreeCache } from './paths.js'
import { buildReport } from './compat.js'
import { bindHostLog, log } from './log.js'
import { createLspManager } from './lsp/manager.js'
import { createLspRpc } from './lsp/rpc.js'
import { disposeAllServers } from './lsp/transport.js'
import { createAiRpc } from './ai/rpc.js'
import { installRulesSection } from './rules.js'
import type { RpcHandlerMap } from './shared/rpc.js'
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
  // 统一日志出口：全部 host 日志经 ctx.logger（缺失时回退 console），此后任何模块 log.* 即生效
  bindHostLog(ctx)
  const registry: Registry = new Map()
  const searcher = newSearcher(ctx)
  const contentSearcher = newContentSearcher(ctx)
  /** LSP 服务器管理器（语言智能：跳转/引用/大纲；诊断行带模块内前缀如 [lsp-manager]）。 */
  const lspManager = createLspManager((line) => log.debug(line))
  /** 兼容性警告收集（route 护栏等写入，启动日志一并输出）。 */
  const warnings: string[] = []
  /** 设置状态（fileOpenTool + AI 补全配置读写；settings 不可用时内存态降级）。 */
  const openSettings = setupOpenSettings(ctx, config, () => {})
  /** LSP 配置为配置值模式：插件组合配置 + 会话内运行时覆盖（原 settings section 命名空间不合法，见 lsp/config.ts）。 */
  /** 规则注入 section（~/.dsh/rules 与 <工作区>/.dsh/rules；旧版 DSH 无 systemPrompt 时静默降级）。 */
  const rulesInstalled = installRulesSection(ctx)
  if (!rulesInstalled) log.warn('未检测到 systemPrompt 服务，规则仅可管理不注入')
  /** LSP RPC 与会话清理（一次性创建，tracker 状态跨请求保留）。 */
  const lspRpc = createLspRpc({ ctx, pluginConfig: config, manager: lspManager })
  const lspHandlers: Partial<RpcHandlerMap> = lspRpc.handlers
  /** AI 内联补全 RPC（settings 状态桥接 + llm 惰性获取）。 */
  const aiRpc = createAiRpc({ ctx, settings: openSettings })
  const aiHandlers: Partial<RpcHandlerMap> = aiRpc.handlers

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
    const sid = (session as { id?: unknown })?.id
    if (typeof sid === 'string') lspRpc.disposeSession(sid)
  })

  registerRoutes(ctx, config, (method, args) => handleRpc(ctx, registry, method, args, searcher, contentSearcher, lspHandlers, aiHandlers), (warning) => warnings.push(warning))
  installIsolation(ctx)
  // 系统集成生命周期：启动自动恢复右键菜单注册（marker 存在时）；插件卸载/reload 清理注册痕迹
  ctx.effect(() => shellMenuLifecycle(ctx))
  // 启动清理缓存目录：非当前 schema / 超保留期 / 未知残留（best-effort，不阻塞装配）
  void sweepTreeCache()
  void logCompatSummary(ctx, warnings)
  // 卸载/重启时强杀 LSP 子进程（防残留）
  ctx.effect(() => () => {
    void lspManager.disposeAll().catch(() => {})
    disposeAllServers()
  })

  log.info('编辑差异审查已装配（/edrv/rpc 路由就绪，项目 MCP 隔离已启用，语言服务器 LSP 已接入，规则注入' + (rulesInstalled ? '已接入' : '未接入') + '）')
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
    const dsh = report.dshVersion ? 'DSH ' + report.dshVersion : 'DSH 未探测'
    const head = '兼容性：' + dsh + ' · ' + report.external.length + ' 项外部适配 / ' + report.guards.length + ' 项护栏 / ' + (report.adapters?.length ?? 0) + ' 项版本适配'
    if (report.warnings.length) {
      log.warn(head + '，警告 ' + report.warnings.length + ' 条：' + report.warnings.join('；'))
    } else {
      log.info(head + '，无警告')
    }
  } catch (error) {
    log.warn('兼容性报告生成失败：' + String(error))
  }
}
