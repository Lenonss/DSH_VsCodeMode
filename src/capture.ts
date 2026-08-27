/**
 * dsh-vscode-mode host — 捕获层：监听 tools/result，把 edit/write 差异落成审查记录。
 * 迁移自原 src/index.ts 的 tools/result 处理，语义不改。
 * 作者 ddj 2026-08-20
 */
import type { DiffRecord, Hunk } from './shared/types.js'
import { annotateHunks, fingerprint } from './shared/diff.js'
import type { Ctx, Session } from './store.js'
import { loadBucket, saveBucket } from './store.js'
import { fileMaxBatch, prune } from './model.js'
import type { Registry } from './registry.js'
import { cwdOf } from './registry.js'
import { invalidateIndex } from './treeIndex.js'

/** 校验并提取工具 result meta 中的文件 hunk。 */
function validHunks(raw: unknown): Hunk[] {
  if (!Array.isArray(raw)) return []
  const hunks: Hunk[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const hunk = item as Record<string, unknown>
    if (typeof hunk.newText !== 'string') continue
    if (hunk.oldText !== null && typeof hunk.oldText !== 'string') continue
    hunks.push({ oldText: hunk.oldText as string | null, newText: hunk.newText })
  }
  return hunks
}

/** 已有文件 write 的元数据缺失时，用权威整文件快照保底。 */
function fallbackHunks(toolName: string, args: Record<string, unknown>, before: string | null, after: string | null, create: boolean): Hunk[] {
  if (create) return [{ oldText: null, newText: after ?? (typeof args.content === 'string' ? args.content : '') }]
  if (toolName === 'edit' && typeof args.old_string === 'string' && typeof args.new_string === 'string') {
    return [{ oldText: args.old_string, newText: args.new_string }]
  }
  if (toolName === 'write' && before !== null && after !== null && before !== after) {
    return [{ oldText: before, newText: after }]
  }
  if (toolName === 'write' && after !== null) return [{ oldText: null, newText: after }]
  return []
}

/**
 * 捕获一次工具执行结果（tools/result）：edit/write 成功时构造记录、
 * 递增文件批次、融合归档被后续修改取代的旧差异、落盘。
 * @author ddj 2026年08月20号
 * @param ctx DSH 上下文
 * @param registry 工作区记录桶注册表
 * @param exec 工具执行描述（name/arguments/callId/agent.session）
 * @param result 执行结果（value/meta/isError）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function captureToolResult(ctx: Ctx, registry: Registry, exec: any, result: any): Promise<void> {
  const session: Session | undefined = exec?.agent?.session
  if (!session || (exec?.name !== 'edit' && exec?.name !== 'write')) return
  if (result?.isError || !result?.value) return
  try {
    const cwd = cwdOf(session)
    if (!cwd) return
    const value = result.value
    const args = (exec.arguments || {}) as Record<string, unknown>
    const path = typeof value.path === 'string' ? value.path : args.file_path
    if (typeof path !== 'string' || !path) return
    const before = typeof value.before === 'string' ? value.before : null
    const after = typeof value.after === 'string' ? value.after : (typeof args.content === 'string' ? args.content : null)
    const create = exec.name === 'write' && value.before === null
    const callHunk = exec.name === 'edit' && typeof args.old_string === 'string' && typeof args.new_string === 'string'
      ? { oldText: args.old_string, newText: args.new_string }
      : null
    const metaHunks = validHunks(result.meta?.diffs)
    const rawHunks = metaHunks.length ? metaHunks : fallbackHunks(exec.name, args, before, after, create)
    const hunks = annotateHunks(rawHunks, before, after)
    if (!hunks.length || typeof exec.callId !== 'string') return
    const record: DiffRecord = {
      callId: exec.callId,
      toolName: exec.name,
      path,
      before,
      after,
      baseFingerprint: fingerprint(before),
      afterFingerprint: fingerprint(after),
      legacy: false,
      conflict: false,
      create,
      callHunk,
      hunks,
      decisions: { call: 'pending', perHunk: hunks.map(() => 'pending') },
      note: create ? '新建文件：全部拒绝将删除该文件' : before === null ? '未捕获修改前内容（大文件）' : null,
      superseded: false,
      archived: false,
      batch: 0,
      at: new Date().toISOString(),
    }
    let bucket = registry.get(cwd)
    if (!bucket) { bucket = await loadBucket(ctx, cwd); registry.set(cwd, bucket) }
    record.batch = fileMaxBatch(bucket, path) + 1
    bucket.set(exec.callId, record)
    // 同一文件的多次 edit/write 都保留为独立记录，便于逐条审查。
    // 旧实现按文件 batch 自动归档 prior，会导致界面看起来每个文件只剩一条差异。
    prune(bucket)
    await saveBucket(ctx, cwd, bucket, session)
    // agent 写盘后目录树可能变化（新建/删除文件/目录）：父目录+祖先进失效，后台自愈。
    invalidateIndex(ctx, cwd, path)
  } catch (error) {
    console.error('edrv capture failed', error)
  }
}
