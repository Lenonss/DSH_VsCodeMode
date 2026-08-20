/**
 * dsh-vscode-mode host — 捕获层：监听 tools/result，把 edit/write 差异落成审查记录。
 * 迁移自原 src/index.ts 的 tools/result 处理，语义不改。
 * 作者 ddj 2026-08-20
 */
import type { DiffRecord } from './shared/types.js'
import type { Ctx, Session } from './store.js'
import { archiveRecords, loadBucket, saveBucket } from './store.js'
import { fileMaxBatch, prune, recordResolved } from './model.js'
import type { Registry } from './registry.js'
import { cwdOf } from './registry.js'

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
    const args = exec.arguments || {}
    const path = typeof value.path === 'string' ? value.path : args.file_path
    if (!path) return
    const metaDiffs: DiffRecord['hunks'] = Array.isArray(result.meta?.diffs) ? result.meta.diffs : []
    const before = typeof value.before === 'string' ? value.before : null
    const create = exec.name === 'write' && value.before === null
    const callHunk = exec.name === 'edit' && typeof args.old_string === 'string' ? { oldText: args.old_string, newText: args.new_string } : null
    const synthHunk = create ? { oldText: null as string | null, newText: typeof args.content === 'string' ? args.content : (typeof value.after === 'string' ? value.after : '') } : null
    const hunks = metaDiffs.length ? metaDiffs : (synthHunk ? [synthHunk] : (callHunk ? [callHunk] : []))
    if (!hunks.length) return
    const record: DiffRecord = {
      callId: exec.callId,
      toolName: exec.name,
      path,
      before,
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
    // 融合：文件被再次修改（batch 递增）时，早于最新批次的未归档差异一律归档（内容已含其效果/被取代）
    const prior: DiffRecord[] = []
    for (const r of bucket.values()) {
      if (r.path === path && r.callId !== exec.callId && !r.archived && (r.batch ?? 0) < record.batch) prior.push(r)
    }
    if (prior.length) {
      await archiveRecords(ctx, session, cwd, bucket, prior, prior.every(recordResolved) ? '已处理且被后续修改取代' : '被后续修改融合（内容已含其效果）')
    }
    prune(bucket)
    await saveBucket(ctx, cwd, bucket, session)
  } catch (error) {
    console.error('edrv capture failed', error)
  }
}
