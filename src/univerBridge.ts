/** Optional 0.4.x Host adapter; never imports private Gateway modules. @author ddj 2026年11月12号 */
import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { canImportOffice, isUniverPath } from './shared/univer.js'
import type { UniverImportResult } from './shared/univer.js'

interface Operation {
  ok: boolean
  result?: Record<string, unknown>
}

export interface UniverService {
  newFile(request: { workspace: string; file: string }): Promise<Operation>
  worktree(request: { workspace: string; file: string; action: 'create'; name: string }): Promise<Operation>
  importUnitContent(request: { workspace: string; file: string; sourceWorkspace: string; source: string; worktreeId: string; name: string; docType?: 'traditional' }): Promise<Operation>
  gatewayStatus(): { phase?: string } | Promise<{ phase?: string }>
}

export interface ImportPaths {
  workspace: string
  source: string
  file: string
}

/** @public @author ddj 2026年11月12号 @param candidate Optional Cordis service. @returns Verified adapter or null. */
export function univerService(candidate: unknown): UniverService | null {
  if (!candidate || typeof candidate !== 'object') return null
  const service = candidate as Record<string, unknown>
  const methods = ['newFile', 'worktree', 'importUnitContent', 'gatewayStatus']
  return methods.every((method) => typeof service[method] === 'function') ? candidate as UniverService : null
}

/** @public @author ddj 2026年11月12号 @param root Canonical root. @param target Canonical target. @returns Whether target stays below root. */
export function insideRoot(root: string, target: string): boolean {
  const child = relative(root, target)
  return child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)
}

/** @public @author ddj 2026年11月12号 @param workspace Session root. @param source Office path. @param target New container. @returns Canonical authorized paths. @throws Invalid format, escape, missing source or existing target. */
export async function importPaths(workspace: string, source: string, target: string): Promise<ImportPaths> {
  if (!canImportOffice(source) || !isUniverPath(target)) throw new Error('不支持的导入格式或目标扩展名')
  const root = await realpath(workspace)
  const original = await realpath(resolve(root, source))
  const output = resolve(root, target)
  const parent = await realpath(dirname(output))
  const file = resolve(parent, basename(output))
  if (!insideRoot(root, original) || !insideRoot(root, file)) throw new Error('文件超出会话工作区')
  if (!(await stat(original)).isFile()) throw new Error('源文件不是普通文件')
  try {
    await lstat(output)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { workspace: root, source: original, file }
    throw error
  }
  throw new Error('目标副本已存在，请打开已有副本或修改名称')
}

/** @private @author ddj 2026年11月12号 @param operation Upstream operation. @returns Checked payload. @throws Failed or malformed upstream response. */
function checkedResult(operation: Operation): Record<string, unknown> {
  if (operation?.ok !== true) throw new Error('Univer 操作失败，未自动重试')
  return operation.result ?? {}
}

/** @public @author ddj 2026年11月12号 @param service Verified optional service. @param paths Canonical paths. @returns Completion or identifiable partial result; never rolls back user content. */
export async function importCopy(service: UniverService, paths: ImportPaths): Promise<UniverImportResult> {
  const result: UniverImportResult = { success: false, stage: 'create', file: paths.file }
  try {
    checkedResult(await service.newFile({ workspace: paths.workspace, file: paths.file }))
    result.stage = 'draft'
    const draft = checkedResult(await service.worktree({ workspace: paths.workspace, file: paths.file, action: 'create', name: basename(paths.source) }))
    if (typeof draft.worktreeId !== 'string' || !draft.worktreeId) throw new Error('Univer 未返回草稿标识')
    result.worktreeId = draft.worktreeId

    result.stage = 'import'
    const imported = checkedResult(await service.importUnitContent({ workspace: paths.workspace, file: paths.file, sourceWorkspace: paths.workspace, source: paths.source, worktreeId: draft.worktreeId, name: basename(paths.source), ...(/\.docx$/i.test(paths.source) ? { docType: 'traditional' as const } : {}) }))
    if (typeof imported.unitId === 'string') result.unitId = imported.unitId
    result.stage = 'complete'
    result.success = true
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }
  return result
}
