/**
 * dsh-vscode-mode host — 回滚/删除（fs + subprocess 操作）。
 * 迁移自原 src/index.ts 的 revertCall/revertHunk/deleteCreated/restoreFile，语义不改。
 * 作者 ddj 2026-08-20
 */
import type { DiffRecord } from './shared/types.js'
import type { Ctx, Session } from './store.js'
import { policyOf, resolveTarget } from './store.js'
import { applyLocations, locateHunks, preciseHunk } from './shared/diff.js'
import { debugRecord } from './debugLog.js'

/** 回滚结果；stale=true 表示该 hunk 的新文本已不在文件中（无可回滚内容，不算失败）。 */
export type Result = { ok: true } | { ok: false; error: string; stale?: boolean }

/**
 * 删除单文件的 argv（纯函数，platform 可注入便于单测）。
 * Windows 走 PowerShell Remove-Item；其余平台走 /bin/rm。
 * 原先无条件先发 powershell：macOS/Linux 上必然 spawn 失败后才回落，
 * 每删一个文件多一次无谓 spawn 与失败噪声。
 * @author ddj 2026年09月18号
 * @param absPath 绝对路径
 * @param platform 目标平台（缺省当前进程平台）
 * @returns 删除命令 argv
 */
export function removeFileArgv(absPath: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    return ['powershell', '-NoProfile', '-NonInteractive', '-Command', 'Remove-Item -LiteralPath "' + absPath + '" -Force']
  }
  return ['/bin/rm', '-f', '--', absPath]
}

/**
 * 删除新建文件（拒绝创建时）：subprocess 删除，路径先经 fs.contains 校验工作区边界。
 * @author ddj 2026年08月20号 / 2026年09月18号
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
    await attempt(removeFileArgv(p))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: '删除失败（文件仍存在）：' + String(error) }
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
export async function revertHunk(ctx: Ctx, session: Session, record: DiffRecord, idx: number, traceId?: string): Promise<Result> {
  const fs = ctx.get('fs')
  if (!fs) return { ok: false, error: '回滚不可用：缺少 fs' }
  const precise = preciseHunk(record, idx)
  if (!precise) return { ok: false, error: '找不到该差异块' }
  // #region debug log
  const started = traceId ? performance.now() : 0
  let readMs = 0
  let locateMs = 0
  let stage = 'resolve'
  // #endregion
  try {
    const target = await resolveTarget(ctx, session, record.path)
    stage = 'stat'
    const info = await fs.stat(target)
    if (!info || info.type !== 'file') return { ok: false, error: '回滚失败：文件不存在' }
    if ((info.size ?? 0) > 8 * 1024 * 1024) return { ok: false, error: '回滚失败：文件过大，无法安全定位' }
    stage = 'read'
    const content = await fs.readText(target)
    // #region debug log
    if (traceId) readMs = performance.now() - started
    const locateStart = traceId ? performance.now() : 0
    // #endregion
    stage = 'locate'
    const location = locateHunks(content, [precise])[0]
    // #region debug log
    if (traceId) locateMs = performance.now() - locateStart
    // #endregion
    // 新文本已不在文件中（被后续修改覆盖/撤销）：不采纳的目标已达成，标记 stale 供调用方按"已回滚"记录决策
    if (!location?.matched) return { ok: false, stale: true, error: '回滚失败：该区域在文件中已不存在（可能已被后续修改覆盖）' }
    const result = applyLocations(content, [location], true)
    stage = 'write'
    await fs.writeText(target, result.content, void 0, void 0, policyOf(ctx, session))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: '回滚失败：该区域可能已被后续修改影响（' + String(error) + '）' }
  } finally {
    // #region debug log
    if (traceId) {
      try { debugRecord(ctx, session.header?.cwd ?? '', `[DEBUG diffRevert] trace=${traceId} mode=single stage=${stage} readMs=${readMs.toFixed(1)} locateMs=${locateMs.toFixed(1)} totalMs=${(performance.now() - started).toFixed(1)}`) } catch { /* 诊断不可影响回滚 */ }
    }
    // #endregion
  }
}

/**
 * 同一记录的连续 hunk 在内存里逐项回滚，只对文件读写各一次。
 * 不替代单条回滚；调用方只传确定同路径且非远端的连续项。
 * @author ddj 2026年09月29号
 * @param ctx DSH 上下文
 * @param session 会话
 * @param record 差异记录
 * @param indices 按决策顺序排列的 hunk 索引
 * @param traceId 可选的诊断追踪号，仅开启诊断时传入
 * @returns 每个 hunk 对应的独立执行结果
 */
export async function revertHunks(ctx: Ctx, session: Session, record: DiffRecord, indices: number[], traceId?: string): Promise<Result[]> {
  const fs = ctx.get('fs')
  if (!fs) return indices.map(() => ({ ok: false, error: '回滚不可用：缺少 fs' }))
  const failAll = (error: string): Result[] => indices.map((idx) => preciseHunk(record, idx)
    ? { ok: false, error } : { ok: false, error: '找不到该差异块' })
  try {
    // #region debug log
    const started = traceId ? performance.now() : 0
    // #endregion
    const target = await resolveTarget(ctx, session, record.path)
    const info = await fs.stat(target)
    if (!info || info.type !== 'file') return failAll('回滚失败：文件不存在')
    if ((info.size ?? 0) > 8 * 1024 * 1024) return failAll('回滚失败：文件过大，无法安全定位')
    let content = await fs.readText(target)
    // #region debug log
    const readMs = traceId ? performance.now() - started : 0
    const locateStart = traceId ? performance.now() : 0
    // #endregion
    let size = info.size ?? Buffer.byteLength(content)
    const results: Result[] = []
    for (const idx of indices) {
      const hunk = preciseHunk(record, idx)
      if (!hunk) { results.push({ ok: false, error: '找不到该差异块' }); continue }
      if (size > 8 * 1024 * 1024) {
        results.push({ ok: false, error: '回滚失败：文件过大，无法安全定位' })
        continue
      }
      const location = locateHunks(content, [hunk])[0]
      if (!location?.matched) {
        results.push({ ok: false, stale: true, error: '回滚失败：该区域在文件中已不存在（可能已被后续修改覆盖）' })
        continue
      }
      size += Buffer.byteLength(hunk.oldText ?? '') - Buffer.byteLength(content.slice(location.start, location.end))
      content = applyLocations(content, [location], true).content
      results.push({ ok: true })
    }
    // #region debug log
    const locateMs = traceId ? performance.now() - locateStart : 0
    const writeStart = traceId ? performance.now() : 0
    // #endregion
    if (results.some((result) => result.ok)) {
      await fs.writeText(target, content, void 0, void 0, policyOf(ctx, session))
    }
    // #region debug log
    try {
      if (traceId) {
        const totalMs = performance.now() - started
        debugRecord(ctx, session.header?.cwd ?? '', `[DEBUG diffRevert] trace=${traceId} mode=batch hunks=${indices.length} bytes=${info.size ?? 0} readMs=${readMs.toFixed(1)} locateMs=${locateMs.toFixed(1)} writeMs=${(performance.now() - writeStart).toFixed(1)} totalMs=${totalMs.toFixed(1)}`)
      }
    } catch { /* 诊断不可影响回滚 */ }
    // #endregion
    return results
  } catch (error) {
    return failAll('回滚失败：该区域可能已被后续修改影响（' + String(error) + '）')
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
