/** dsh-vscode-mode Host composition. @author ddj 2026年09月28号 */
import { registerRoutes } from './routes.js'
import { captureToolResult } from './capture.js'
import { installCapture } from './officialCapture.js'
import { installEvidence } from './reviewCapture.js'
import { installPending } from './pending/capture.js'
import type { PendingWrite } from './pending/capture.js'
import { installExternalCapture, VCS_WRITE_METHODS, VCS_WRITE_TOOLS } from './pending/externalCapture.js'
import { windows } from './pending/provenance.js'
import { recordWrite } from './pending/store.js'
import { cwdOfSession } from './store.js'
import { resolveScope } from './registry.js'
import { trackPendingCover } from './pendingCompat.js'
import { closeArchiveDbs } from './archiveDb.js'
import { startArchiveSweep } from './archivePurge.js'
import { startLoopWatchdog } from './slowLog.js'
import { handleRpc, integrationBaseUrlOf } from './rpc.js'
import { newSearcher } from './search/orchestrator.js'
import { newContentSearcher } from './search/content.js'
import { installIsolation } from './mcpIsolation.js'
import { installMcpRuntime } from './mcpRuntime.js'
import { cwdOf } from './registry.js'
import { setupOpenSettings, buildSettingsSchema } from './fileOpenSettings.js'
import type { SettingsDeps } from './fileOpenSettings.js'
import z from '@deepseek-ai/schemastery'
import { shellMenuLifecycle } from './integrate.js'
import { startOpenInbox } from './openInbox.js'
import { ensureActiveBridge } from './openBridge.js'
import { installPlanTool } from './svnPlanTool.js'
import { installNoteTool } from './pending/noteTool.js'
import { clearNotes } from './pending/notes.js'
import { disposeIndex } from './treeIndex.js'
import { sweepTreeCache } from './paths.js'
import { buildReport } from './compat.js'
import { bindHostLog, log } from './log.js'
import { createLspManager } from './lsp/manager.js'
import { createLspRpc } from './lsp/rpc.js'
import { disposeAllServers, hookExitReclaim } from './lsp/transport.js'
import { createAiRpc } from './ai/rpc.js'
import { createFileVersions } from './fileVersions.js'
import { createSvnRpc } from './svn.js'
import { installSvnTools } from './svnTools.js'
import { createDapRpc } from './dap/rpc.js'
import { installRulesSection } from './rules.js'
import { installSkillGroup } from './skills.js'
import { installHtmlPlanCommand } from './htmlPlanCommand.js'
import type { RpcHandlerMap, RpcMethod, RpcRequestMap } from './shared/rpc.js'
import type { Registry } from './registry.js'
import type { Ctx } from './store.js'

export const name = 'dsh-vscode-mode'
export const inject = ['sessions', 'fs', 'webServer', 'loader', 'tools', 'workspaceRegistry', 'agents']
/** Shared settings schema; volatile fields remain live across supported Host generations. */
export const Config = buildSettingsSchema(z as unknown as SettingsDeps['z'], { volatile: true })
type Runtime = ReturnType<typeof createRuntime>

// #region Owned services
/**
 * Create the managers shared by RPC routes, tools and lifecycle callbacks.
 * @author ddj 2026年09月28号
 * @param ctx Host context.
 * @param config Plugin configuration.
 * @returns One owned set of managers for this plugin instance.
 */
function createRuntime(ctx: Ctx, config: unknown) {
  const registry: Registry = new Map()
  const searcher = newSearcher(ctx)
  const contentSearcher = newContentSearcher(ctx)
  const settings = setupOpenSettings(ctx, config, () => {})
  const lspManager = createLspManager((line) => log.debug(line))
  const lspRpc = createLspRpc({ ctx, pluginConfig: config, manager: lspManager })
  const aiRpc = createAiRpc({ ctx, settings })
  const svnRpc = createSvnRpc({ ctx, settings })
  const dapRpc = createDapRpc(ctx)
  const fileVersions = createFileVersions(ctx)
  return { registry, searcher, contentSearcher, lspManager, lspRpc, aiRpc, svnRpc, dapRpc, fileVersions, settings }
}

/**
 * Own tool capture, per-session caches, and process cleanup under one Host fiber.
 * @author ddj 2026年09月28号
 * @param ctx Host context.
 * @param runtime Managers created by this instance.
 */
function attachRuntime(ctx: Ctx, runtime: Runtime): { external: ReturnType<typeof installExternalCapture> } {
  const evidence = installEvidence(ctx)
  const stopCapture = installCapture(ctx, (cwd, snapshot) => { evidence.persist(cwd, snapshot); return true })
  /** @author ddj 2026年11月24号 @param write 已确认的一次写入 @returns 无；落库失败不打断用户工具调用 */
  function recordPendingWrite(write: PendingWrite): void {
    try { trackPendingCover(write.cwd, write.path, true, write.sessionId) } catch { /* 内存登记失败不阻断采集 */ }
    try { recordWrite(write) } catch (error) { log.warn('待审差异落库失败：' + String(error)) }
  }
  // 待审累计基线：只有写后内容确实变化才落库，异常一律不打断用户工具调用
  const pending = installPending(ctx, recordPendingWrite)
  // 外部改动采集：非 DSH 文件工具（bash 里的 node -e、脚本、生成器）写盘也进审查面板
  const external = installExternalCapture({
    ctx,
    settings: () => runtime.settings.external(),
    record: recordPendingWrite,
  })
  // 归档库每日清理：保留期 + 每文件上限，独立于会话存续
  const sweep = startArchiveSweep()
  // 事件循环看门狗：宿主是单进程单事件循环，任何同步大活都会把所有 RPC 一起拖住
  const loopWatch = startLoopWatchdog()
  /**
   * @author ddj 2026年11月24号
   * @description: 任一工具调用期间都是 agent 写入窗口：bash / python 写盘落在窗口内时归属 agent。
   * 版本库写工具结束后再补扫一次，把命令造成的成片变化对齐进待审投影。
   * @param exec 工具执行描述
   * @param next 原始分发
   * @returns 原始结果
   */
  function aroundToolWindow(exec: { name?: unknown; agent?: { session?: unknown } }, next: () => Promise<unknown>): Promise<unknown> {
    windows.enterTool()
    return Promise.resolve()
      .then(next)
      .finally(() => {
        windows.exitTool()
        if (!VCS_WRITE_TOOLS.has(String(exec.name ?? ''))) return
        const cwd = cwdOfSession(ctx, exec.agent?.session)
        if (cwd) external.requestAlign(cwd)
      })
  }
  /** @author ddj 2026年11月24号 @param session 新建会话 @returns 无；工作区可用即开始监听 */
  function onCreated(session: { id?: unknown }): void {
    if (typeof session.id !== 'string') return
    const cwd = cwdOfSession(ctx, session)
    if (cwd) external.ensure(cwd, session.id)
  }
  /** @author ddj 2026年09月28号 @param exec Tool execution. @param result Tool result. */
  function onResult(exec: unknown, result: unknown): void {
    void captureToolResult(ctx, runtime.registry, exec, result)
  }
  /** @author ddj 2026年09月28号 @param session Disposed session. */
  function onDisposed(session: { id?: unknown }): void {
    const cwd = cwdOf(session)
    if (cwd) {
      external.dismiss(cwd)
      runtime.registry.delete(cwd)
      runtime.searcher.dispose(cwd)
      runtime.contentSearcher.dispose(cwd)
      disposeIndex(cwd)
    }
    if (typeof session.id === 'string') runtime.lspRpc.disposeSession(session.id)
  }
  /** @author ddj 2026年09月28号 Release every manager even if another cleanup rejects. */
  async function cleanup(): Promise<void> {
    await stopCapture()
    evidence.dispose()
    pending.dispose()
    external.dispose()
    clearNotes()
    sweep.dispose()
  loopWatch.dispose()
    windows.dispose()
    runtime.fileVersions.dispose()
    closeArchiveDbs()
    disposeAllServers()
    const tasks = [() => runtime.lspManager.disposeAll(), () => runtime.svnRpc.dispose(), () => runtime.dapRpc.dispose()]
    await Promise.allSettled(tasks.map((run) => Promise.resolve().then(run)))
  }
  ctx.on('tools/result', onResult)
  ctx.on('tools/execute', aroundToolWindow)
  ctx.on('session/created', onCreated)
  ctx.on('session/disposed', onDisposed)
  // 启动时给已有会话的工作区各开一份监听（会话内 cd 后由 session/created 与 ensure 幂等补齐）
  for (const session of ctx.get('sessions').list()) onCreated(session)
  ctx.effect(() => cleanup, 'vscode-mode:runtime')
  hookExitReclaim()
  return { external }
}

/**
 * Add user rules and bundled skills without requiring them on older Hosts.
 * @author ddj 2026年09月28号
 * @param ctx Host context.
 */
function installContent(ctx: Ctx): void {
  if (!installRulesSection(ctx)) log.warn('未检测到 systemPrompt 服务，规则仅可管理不注入')
  if (!installSkillGroup(ctx)) log.warn('技能组未调度，插件技能组不可用')
  if (!installHtmlPlanCommand(ctx)) log.warn('/html-plan 命令未调度（官方 /plan 不可用时该命令不可用）')
}
// #endregion

/**
 * Activate authenticated routes, scoped MCP, analysis submission and private file opens.
 * @author ddj 2026年09月28号
 * @param ctx Injected Host context.
 * @param config Validated live plugin configuration.
 * @returns Startup readiness; owned effects are released on activation failure or unload.
 */
export async function apply(ctx: Ctx, config?: unknown): Promise<void> {
  bindHostLog(ctx)
  const runtime = createRuntime(ctx, config)
  const warnings: string[] = []
  const capture = attachRuntime(ctx, runtime)
  installContent(ctx)
  /** 版本库写操作后的补扫串行链：并发 RPC 也不会叠出多次补扫。 */
  let alignChain: Promise<void> = Promise.resolve()
  /** @author ddj 2026年09月28号 @param method RPC name. @param args Typed request. @returns RPC result. */
  function dispatch<M extends RpcMethod>(method: M, args: RpcRequestMap[M]) {
    const { registry, searcher, contentSearcher, lspRpc, aiRpc, fileVersions, svnRpc, dapRpc } = runtime
    const pendingResult = handleRpc(ctx, registry, method, args, searcher, contentSearcher, lspRpc.handlers,
      aiRpc.handlers, fileVersions, svnRpc.handlers as Partial<RpcHandlerMap>, dapRpc.handlers)
    // 版本库写操作（提交/更新/还原/清理…）之后补扫一次：命令造成的成片变化要能进待审投影
    if (!VCS_WRITE_METHODS.has(method)) return pendingResult
    alignChain = alignChain.then(async () => {
      const cwd = await workspaceOfSession((args as { sessionId?: string } | undefined)?.sessionId)
      if (cwd) capture.external.requestAlign(cwd)
    }).catch(() => {})
    return pendingResult
  }
  /**
   * @author ddj 2026年11月24号
   * @description: 取 RPC 参数里的会话工作区；取不到就跳过补扫，绝不影响 RPC 本身。
   * @param sessionId 请求会话
   * @returns 工作区路径或 null
   */
  async function workspaceOfSession(sessionId: string | undefined): Promise<string | null> {
    try {
      if (!sessionId) return null
      const scope = await resolveScope(ctx, sessionId)
      return 'err' in scope ? null : scope.cwd
    } catch { return null }
  }
  /** @author ddj 2026年09月28号 @param warning Startup compatibility diagnostic. */
  function noteWarning(warning: string): void { warnings.push(warning) }
  /** @author ddj 2026年09月28号 @returns Private inbox disposer, or a reported disabled capability. */
  async function mountInbox(): Promise<() => void> {
    try { return await startOpenInbox(ctx) } catch (error) {
      noteWarning('外部打开通道未启用：' + String(error))
      return () => {}
    }
  }
  registerRoutes(ctx, config, dispatch, noteWarning)
  installIsolation(ctx)
  await installMcpRuntime(ctx)
  /** @author ddj 2026年09月28号 @param args Session-bound plan. @returns Validated inbox result. */
  function submitPlan(args: RpcRequestMap['svn.aiPlanSubmit']) { return dispatch('svn.aiPlanSubmit', args) }
  await installPlanTool(ctx, submitPlan)
  await installSvnTools(ctx, runtime.svnRpc.api)
  // 只读编辑说明：模型可以给文件留一句「为什么改」，只展示、不参与差异判定
  await installNoteTool(ctx, (session) => cwdOfSession(ctx, session as never))
  ctx.effect(mountInbox, 'vscode-mode:open-inbox')
  ctx.effect(() => shellMenuLifecycle(ctx), 'vscode-mode:integration')
  /** @author ddj 2026年10月12号 @returns Active-profile bridge disposer; failures never block boot. */
  async function provisionBridge(): Promise<() => void> {
    try { await ensureActiveBridge(ctx, await integrationBaseUrlOf(ctx)) }
    catch (error) { noteWarning('外部打开桥接未就绪：' + String(error)) }
    return () => {}
  }
  ctx.effect(provisionBridge, 'vscode-mode:bridge')
  void sweepTreeCache()
  await logCompatSummary(ctx, warnings)
  log.info('编辑差异审查已装配（认证路由、项目 MCP 作用域、SVN 方案工具与外部打开通道）')
}

/**
 * Log the actual compatibility report without turning a reporting failure into boot failure.
 * @author ddj 2026年09月28号
 * @param ctx Host context.
 * @param warnings Activation diagnostics.
 */
async function logCompatSummary(ctx: Ctx, warnings: string[]): Promise<void> {
  try {
    const report = await buildReport(ctx)
    report.warnings.push(...warnings)
    const dsh = report.dshVersion ? 'DSH ' + report.dshVersion : 'DSH 未探测'
    const head = '兼容性：' + dsh + ' · ' + report.external.length + ' 项外部适配 / ' + report.guards.length + ' 项护栏 / ' + (report.adapters?.length ?? 0) + ' 项版本适配'
    if (report.warnings.length) log.warn(head + '，警告 ' + report.warnings.length + ' 条：' + report.warnings.join('；'))
    else log.info(head + '，无警告')
  } catch (error) {
    log.warn('兼容性报告生成失败：' + String(error))
  }
}
