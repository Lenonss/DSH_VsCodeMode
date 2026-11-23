/**
 * dsh-vscode-mode client — 非 UTF-8 文件的探测、只读预览、按推荐方式修复与撤销。
 * 面板只在读取失败后出现；写盘只发生在用户点「执行」之后（决策 1/2/3）。
 * 作者 ddj 2026-11-21
 */
import { rpc } from './rpc.js'
import type { EncodingKind, EncodingVerdict } from '../textEncoding.js'
import { kindLabelOf, refusalOf } from '../textEncoding.js'

/** 兼容面板的完整状态。 */
export interface TextCompatState {
  path: string
  sessionId: string
  verdict: EncodingVerdict
  /** 探测时的文件版本；修复与撤销都用它做版本守卫。 */
  version: string
  busy: boolean
  error: string | null
  /** 修复后的备份相对路径；null 表示尚未修复。 */
  backup: string | null
  /** 修复后的版本；撤销时回传。 */
  repairedVersion: string | null
}

/** 探测/预览/修复/撤销的失败形态。 */
export interface CompatFailure {
  ok: false
  error: string
  code?: string
}

/** @public @author ddj 2026年11月21号 @param verdict 判定 @returns 是否可按推荐方式写盘（只有整体 GB18030） */
export function canRepairOf(verdict: EncodingVerdict): boolean {
  return verdict.kind === 'gb18030'
}

/** @public @author ddj 2026年11月21号 @param verdict 判定 @returns 不可修复时的说明 */
export function refusalOfSel(verdict: EncodingVerdict): string {
  return refusalOf(verdict.kind)
}

/**
 * 一行诊断文案。
 * @public @author ddj 2026年11月21号
 * @param verdict 判定
 * @returns 面向用户的一句话
 */
export function summaryOf(verdict: EncodingVerdict): string {
  if (verdict.kind === 'gb18030') return '检测到 ' + kindLabelOf(verdict.kind) + ' 编码 · 整体可无损转成 UTF-8'
  if (verdict.kind === 'mixed') return '检测到 ' + verdict.badBytes + ' 处非法字节（' + linesOf(verdict) + '）'
  if (verdict.kind === 'binary') return '文件疑似二进制（含 NUL），不提供转码'
  return '文件是合法 UTF-8'
}

/** @private @author ddj 2026年11月21号 @param verdict 判定 @returns 行号列举（最多 8 行） */
function linesOf(verdict: EncodingVerdict): string {
  const lines = verdict.lines.slice(0, 8)
  const listed = lines.join('、')
  return lines.length < verdict.lines.length ? '第 ' + listed + ' 行等' : '第 ' + listed + ' 行'
}

/**
 * 探测目标文件的编码。
 * @public @author ddj 2026年11月21号
 * @param sessionId 会话 id @param path 目标相对路径
 * @returns 初始面板状态或失败原因
 */
export async function probeText(sessionId: string, path: string): Promise<{ ok: true; state: TextCompatState } | CompatFailure> {
  try {
    const result = await rpc('edrv.textCompat', { sessionId, path, mode: 'probe' })
    if (!result.ok) return { ok: false, error: result.error, code: result.code }
    if (result.mode !== 'probe') return { ok: false, error: '探测返回了非预期载荷' }

    return {
      ok: true,
      state: {
        path, sessionId, verdict: result.verdict, version: result.version,
        busy: false, error: null, backup: null, repairedVersion: null,
      },
    }
  } catch (error) { return { ok: false, error: String(error) } }
}

/**
 * 取只读预览（不写盘）。
 * @public @author ddj 2026年11月21号
 * @param sessionId 会话 id @param path 目标相对路径
 * @returns 预览文本与截断标记
 */
export async function previewText(sessionId: string, path: string): Promise<{ ok: true; text: string; truncated: boolean } | CompatFailure> {
  try {
    const result = await rpc('edrv.textCompat', { sessionId, path, mode: 'preview' })
    if (!result.ok) return { ok: false, error: result.error, code: result.code }
    if (result.mode !== 'preview') return { ok: false, error: '预览返回了非预期载荷' }

    return { ok: true, text: result.text, truncated: result.truncated }
  } catch (error) { return { ok: false, error: String(error) } }
}

/**
 * 按推荐方式把 GB18030 文件转成 UTF-8（先备份，再经版本守卫写入）。
 * @public @author ddj 2026年11月21号
 * @param sessionId 会话 id @param path 目标相对路径 @param rev 探测时的版本
 * @returns 修复后的版本与备份路径
 */
export async function repairText(sessionId: string, path: string, rev: string): Promise<{ ok: true; version: string; backup: string } | CompatFailure> {
  try {
    const result = await rpc('edrv.textCompat', { sessionId, path, mode: 'repair', rev })
    if (!result.ok) return { ok: false, error: result.error, code: result.code }
    if (result.mode !== 'repair') return { ok: false, error: '修复返回了非预期载荷' }

    return { ok: true, version: result.version, backup: result.backup }
  } catch (error) { return { ok: false, error: String(error) } }
}


/**
 * 保存编辑后的 UTF-8 正文（先备份原字节，再按读取时的版本守卫写入）。
 * @public @author ddj 2026年11月21号
 * @param sessionId 会话 id @param path 目标相对路径 @param rev 读取时的版本 @param text 待保存正文
 * @returns 新版本与备份路径；仍含乱码占位时拒绝
 */
export async function commitText(sessionId: string, path: string, rev: string, text: string): Promise<{ ok: true; version: string; backup: string } | CompatFailure> {
  try {
    const result = await rpc('edrv.textCompat', { sessionId, path, mode: 'commit', rev, text })
    if (!result.ok) return { ok: false, error: result.error, code: result.code }
    if (result.mode !== 'commit') return { ok: false, error: '保存返回了非预期载荷' }

    return { ok: true, version: result.version, backup: result.backup }
  } catch (error) { return { ok: false, error: String(error) } }
}

/**
 * 撤销本次修复：把备份字节还原回文件。
 * @public @author ddj 2026年11月21号
 * @param sessionId 会话 id @param path 目标相对路径 @param rev 修复后的版本
 * @returns 成功标记
 */
export async function undoRepair(sessionId: string, path: string, rev: string): Promise<{ ok: true } | CompatFailure> {
  try {
    const result = await rpc('edrv.textCompat', { sessionId, path, mode: 'undo', rev })
    if (!result.ok) return { ok: false, error: result.error, code: result.code }
    return { ok: true }
  } catch (error) { return { ok: false, error: String(error) } }
}

/** @public @author ddj 2026年11月21号 @param kind 判定类别 @returns 面板标签 */
export function labelOf(kind: EncodingKind): string {
  return kindLabelOf(kind)
}
