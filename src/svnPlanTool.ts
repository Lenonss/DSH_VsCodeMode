/** Session-bound SVN analysis result delivery. @author ddj 2026年09月28号 */
import { loadHostModule } from './hostImport.js'
import type { Ctx } from './store.js'
import type { RpcHandler, RpcResult } from './shared/rpc.js'

interface PlanArgs { plan: unknown }
interface PlanExec { agent?: { session?: { id?: string } }; signal?: AbortSignal }
type Submit = RpcHandler<'svn.aiPlanSubmit'>

/**
 * Build a result-only tool that derives ownership from the executing session.
 * It cannot revert, commit, ignore, or select another session.
 * @author ddj 2026年09月28号
 * @param submit Existing validated plan inbox handler.
 * @returns Definition options for the running Host's defineTool API.
 */
export function planToolOptions(submit: Submit) {
  /** @author ddj 2026年09月28号 @param args Model plan. @param exec Owning execution context. @returns Validated inbox result. */
  async function execute(args: PlanArgs, exec: PlanExec): Promise<RpcResult<'svn.aiPlanSubmit'>> {
    const sessionId = exec.agent?.session?.id
    if (!sessionId) return { ok: false, error: 'SVN 方案投递需要所属会话' }
    if (exec.signal?.aborted) return { ok: false, error: 'SVN 方案投递已取消' }
    return submit({ sessionId, plan: args.plan })
  }
  /** @author ddj 2026年09月28号 @param _args Request. @param result Inbox result. @returns Model-visible result. */
  function render(_args: PlanArgs, result: RpcResult<'svn.aiPlanSubmit'>) {
    return [{ type: 'text', text: JSON.stringify(result) }]
  }
  return {
    name: 'svn_plan_submit',
    description: 'Submit an SVN change-analysis plan to the current workspace review inbox. This only records the proposal; the user must confirm changes in VSCodeMode. It does not modify or commit files.',
    parameters: { plan: { type: 'json', required: true, description: 'Analysis proposal with groups, reverts and ignores arrays, using paths from the current SVN working-copy status.' } },
    output: { schema: { type: 'json' }, render },
    isConcurrencySafe: false,
    execute,
  }
}

/**
 * Register the SVN submission tool using the running Host API and lifecycle owner.
 * @author ddj 2026年09月28号
 * @param ctx Host plugin context owning the registration.
 * @param submit Validated SVN inbox handler.
 */
export async function installPlanTool(ctx: Ctx, submit: Submit): Promise<void> {
  const module = await loadHostModule('@deepseek-ai/dsh-tools') as { defineTool: (options: unknown) => unknown }
  const definition = module.defineTool(planToolOptions(submit))
  /** @author ddj 2026年09月28号 @returns Registration disposer owned by this plugin. */
  function install(): () => void { return ctx.get('tools').register(definition) }
  ctx.effect(install, 'vscode-mode:svn-plan-submit')
}
