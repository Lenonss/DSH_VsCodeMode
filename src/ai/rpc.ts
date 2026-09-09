/**
 * dsh-vscode-mode host — edrv.ai.* RPC handlers。
 * inline：AI 内联补全（一次调用一次结果，无状态）；models：模型目录（缓存）；
 * configGet/configUpdate：settings section 的 AI 字段读写。
 * 作者 ddj
 */
import type { RpcHandlerMap } from '../shared/rpc.js'
import type { FileOpenSettingsState } from '../fileOpenSettings.js'
import type { AiConfigView } from '../shared/ai.js'
import { aiInlineComplete, aiModels, type AiInlineDeps } from './inline.js'

/** AI RPC 依赖（settings 状态由 index.ts 装配时桥接）。 */
export interface AiRpcDeps {
  ctx: AiInlineDeps['ctx']
  settings: FileOpenSettingsState & {
    ai: () => AiConfigView
    aiUpdate: (patch: import('../shared/ai.js').AiConfigPatch, expectedRevision?: number) => Promise<AiConfigView>
  }
}

/**
 * 构造 edrv.ai.* handlers（一次性创建，无跨请求状态——目录缓存在 inline.ts 模块级）。
 * @author ddj
 * @param deps 依赖（ctx/settings）
 * @returns handlers
 */
export function createAiRpc(deps: AiRpcDeps): { handlers: Partial<RpcHandlerMap> } {
  const handlers: Partial<RpcHandlerMap> = {
    'edrv.ai.inline': async (args) => ({ ok: true, ...(await aiInlineComplete({ ctx: deps.ctx, config: { get: () => deps.settings.ai() } }, args)) }),
    'edrv.ai.models': async (args) => ({ ok: true, ...(await aiModels(deps.ctx, args?.force === true)) }),
    'edrv.ai.configGet': async () => ({ ok: true, ...deps.settings.ai() }),
    'edrv.ai.configUpdate': async (args) => ({ ok: true, ...(await deps.settings.aiUpdate(args)) }),
  }
  return { handlers }
}
