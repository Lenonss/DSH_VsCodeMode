/** Optional Host patch target extraction; results never substitute raw preimages. @author ddj 2026年11月04号 */
import { loadHostModule } from './hostImport.js'

export interface ToolCall {
  name?: string
  id?: string
  arguments?: { file_path?: unknown; path?: unknown; input?: unknown }
}
interface PatchTarget { path: string; moveTo?: string }

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

/** @public @author ddj 2026年11月04号 @param call Tool identity and arguments. @param parser Optional injectable official parser. @returns Unique unresolved source/destination paths. @throws Unsupported parser or malformed patch. */
export async function toolTargets(call: ToolCall, parser?: PatchParser | null): Promise<string[]> {
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
