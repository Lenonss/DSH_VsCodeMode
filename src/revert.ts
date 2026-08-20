/**
 * dsh-vscode-mode host — 回滚/删除（fs + subprocess 操作）。
 * 迁移自原 src/index.ts 的 revertCall/revertHunk/deleteCreated/restoreFile，语义不改。
 * 作者 ddj 2026-08-20
 */
import type { DiffRecord } from './shared/types.js'
import type { Ctx, Session } from './store.js'
import { policyOf, resolveTarget } from './store.js'

export type Result = { ok: true } | { ok: false; error: string }

/**
 * 删除新建文件（拒绝创建时）：subprocess 删除，路径先经 fs.contains 校验工作区边界。
 * @author ddj 2026年08月20号
 * @returns 成功或失败原因
 */
export async function deleteCreated(ctx: Ctx, session: Session, record: DiffRecord): Promise<Result> {
  const sub = ctx.get('subprocess')
  const fs = ctx.get('fs')
  if (!sub || !fs) return { ok: false, error: '回滚不可用：缺少 subprocess/fs' }
  const policy = policyOf(ctx, session)
  const rootTarget = await fs.resolve(policy?.workspaceRoot ?? '.', {})
  const target = await resolveTarget(ctx, session, record.path)
  if (!fs.contains(rootTarget, target)) return { ok: false, error: '拒绝删除：目标不在会话工作区内' }
  const p = fs.processPath(target)
  // subprocess 契约：spawn({ argv, stdio, graceMs })，done → { exitCode }，输出走 handle.collected
  const attempt = async (argv: string[]): Promise<void> => {
    const handle = sub.spawn({
      argv,
      stdio: { stdout: { maxBytes: 1 << 16 }, stderr: { maxBytes: 1 << 16 }, stdin: 'ignore' },
      graceMs: 10000,
    })
    const outcome = await handle.done
    const code = outcome?.exitCode ?? outcome?.code
    if (code !== 0) {
      const err = handle.collected?.stderr?.readFrom(0).text ?? ''
      throw new Error('exit ' + code + ' ' + err)
    }
  }
  try {
    await attempt(['powershell', '-NoProfile', '-NonInteractive', '-Command', 'Remove-Item -LiteralPath "' + p + '" -Force'])
    return { ok: true }
  } catch (error) {
    try {
      await attempt(['/bin/rm', '-f', '--', p])
      return { ok: true }
    } catch (error2) {
      return { ok: false, error: '删除失败（文件仍存在）：' + String(error) + ' / ' + String(error2) }
    }
  }
}

/** 整调用回滚：write/编辑用 before 整文件恢复；新建文件转 deleteCreated。 */
export async function revertCall(ctx: Ctx, session: Session, record: DiffRecord): Promise<Result> {
  const fs = ctx.get('fs')
  if (!fs) return { ok: false, error: '回滚不可用：缺少 fs' }
  if (record.before === null) {
    if (!record.create) return { ok: false, error: '无法回滚：缺少修改前内容（大文件或旧记录）' }
    return deleteCreated(ctx, session, record)
  }
  try {
    const target = await resolveTarget(ctx, session, record.path)
    await fs.writeText(target, record.before, void 0, void 0, policyOf(ctx, session))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: '回滚失败：' + String(error) }
  }
}

/** 单 hunk 回滚：用 callHunk（edit 单 hunk 精确串）经 fs.editText 反替换。 */
export async function revertHunk(ctx: Ctx, session: Session, record: DiffRecord, idx: number): Promise<Result> {
  const fs = ctx.get('fs')
  if (!fs) return { ok: false, error: '回滚不可用：缺少 fs' }
  const hunk = record.hunks[idx]
  const precise = record.toolName === 'edit' && record.hunks.length <= 1 && record.callHunk ? record.callHunk : hunk
  if (!precise) return { ok: false, error: '找不到该差异块' }
  try {
    const target = await resolveTarget(ctx, session, record.path)
    await fs.editText(target, { oldString: precise.newText, newString: precise.oldText === null ? '' : precise.oldText }, void 0, void 0, policyOf(ctx, session))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: '回滚失败：该区域可能已被后续修改影响（' + String(error) + '）' }
  }
}

/**
 * 恢复文件到记录对应状态（批次回滚用）：返回错误文案或 null（成功）。
 * @author ddj 2026年08月20号
 */
export async function restoreFile(ctx: Ctx, session: Session, rec: DiffRecord): Promise<string | null> {
  const fs = ctx.get('fs')
  if (!fs) return '缺少 fs'
  if (rec.before === null || rec.before === undefined) {
    if (rec.create === true) {
      const out = await deleteCreated(ctx, session, rec)
      return out.ok ? null : out.error
    }
    return '缺少修改前内容（大文件或旧记录），无法回滚'
  }
  try {
    const target = await resolveTarget(ctx, session, rec.path)
    await fs.writeText(target, rec.before, void 0, void 0, policyOf(ctx, session))
    return null
  } catch (error) {
    return '回滚失败：' + String(error)
  }
}
