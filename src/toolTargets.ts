/** Optional Host patch target extraction; results never substitute raw preimages. @author ddj 2026年11月04号 */
import { loadHostModule } from './hostImport.js'

export interface ToolCall {
  name?: string
  id?: string
  arguments?: { file_path?: unknown; path?: unknown; to?: unknown; input?: unknown }
}
interface PatchTarget { path: string; moveTo?: string }

/** dsh-ops 工具名前缀（对应 dsh-ops 的 TOOL_PREFIX）。 */
export const OPS_PREFIX = 'ops_'

/** @public @author ddj 2026年11月04号 @param result Untrusted tool envelope. @returns Diagnostic-only status; never writable preimages. */
export function patchDiagnostics(result: unknown): string[] {
  const envelope = result as { value?: unknown } | null
  const payload = (envelope?.value ?? result) as { phase?: unknown; operations?: unknown } | null
  if (payload?.phase !== 'commit' || !Array.isArray(payload.operations)) return ['apply_patch result unavailable or malformed']
  const diagnostics: string[] = []
  for (const operation of payload.operations) {
    if (!operation || typeof operation.path !== 'string' || !['add', 'update', 'delete', 'move'].includes(operation.kind)
      || !['completed', 'failed', 'unknown', 'skipped'].includes(operation.status)) {
      diagnostics.push('apply_patch operation malformed'); continue
    }
    if (operation.status !== 'completed') diagnostics.push(operation.path + ': ' + operation.status)
    if (operation.changes !== undefined && (!Array.isArray(operation.changes) || operation.changes.some((change: any) =>
      !change || typeof change.path !== 'string' || !(change.before === null || typeof change.before === 'string') || !(change.after === null || typeof change.after === 'string')))) {
      diagnostics.push(operation.path + ': changes malformed')
    }
  }
  return diagnostics
}
export type PatchParser = (input: string) => PatchTarget[]
let parserLoad: Promise<PatchParser | null> | undefined

/** @public @author ddj 2026年11月04号 @returns Optional official parser; missing capabilities remain retryable. */
export async function patchParser(): Promise<PatchParser | null> {
  if (!parserLoad) {
    parserLoad = loadHostModule('@deepseek-ai/dsh-fs-patch').then((module) => {
      const parser = (module as { parsePatch?: PatchParser }).parsePatch
      return typeof parser === 'function' ? parser : null
    }).catch(() => null)
  }
  const parser = await parserLoad
  if (!parser) parserLoad = undefined
  return parser
}

/** dsh-ops 单目标写工具后缀：目标只来自 arguments.path。 */
const OPS_SINGLE = new Set(['edit_file', 'write_file', 'remove'])
/** dsh-ops 成对写工具后缀：源为 arguments.path，目标为 arguments.to。 */
const OPS_PAIR = new Set(['copy', 'move'])

/**
 * @private
 * @author ddj 2026年11月09号
 * @description: dsh-ops 写工具的真实落盘目标；未知 ops 工具保守返回空，不猜测路径。
 * @param call 工具身份与调用参数
 * @returns 去重后的目标路径；无目标时为空数组
 */
function opsTargets(call: ToolCall): string[] {
  const suffix = String(call.name).slice(OPS_PREFIX.length)
  const single = OPS_SINGLE.has(suffix) || OPS_PAIR.has(suffix)
  const source = single ? call.arguments?.path : undefined
  const destination = OPS_PAIR.has(suffix) ? call.arguments?.to : undefined
  const paths: string[] = []
  if (typeof source === 'string' && source) {
    paths.push(source)
  }
  if (typeof destination === 'string' && destination && destination !== source) {
    paths.push(destination)
  }
  return paths
}

/** @public @author ddj 2026年11月04号 @param call Tool identity and arguments. @param parser Optional injectable official parser. @returns Unique unresolved source/destination paths. @throws Unsupported parser or malformed patch. */
export async function toolTargets(call: ToolCall, parser?: PatchParser | null): Promise<string[]> {
  if (String(call.name).startsWith(OPS_PREFIX)) {
    return opsTargets(call)
  }
  if (['edit', 'write', 'str_replace_editor'].includes(String(call.name))) {
    const path = call.arguments?.file_path ?? call.arguments?.path
    return typeof path === 'string' && path ? [path] : []
  }
  if (call.name !== 'apply_patch') return []
  if (typeof call.arguments?.input !== 'string') throw new Error('apply_patch input unavailable')
  const parse = parser === undefined ? await patchParser() : parser
  if (!parse) throw new Error('Host patch parser unavailable')
  const paths = new Set<string>()
  for (const operation of parse(call.arguments.input)) {
    if (typeof operation.path !== 'string' || !operation.path) throw new Error('Invalid patch target')
    paths.add(operation.path)
    if (operation.moveTo) paths.add(operation.moveTo)
  }
  return [...paths]
}
