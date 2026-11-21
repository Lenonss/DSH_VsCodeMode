/**
 * dsh-vscode-mode client — 提交通道（计划 / 原生提交 / AI 提交信息）的 RPC 封装。
 *
 * 只做「调用 + 文案归一」，不持状态：勾选态与弹窗生命周期在 ui/SvnCommitDialog，
 * 纯投影规则在 ui/svnCommitModel（可单测）。
 * @author ddj 2026年11月15号
 */
import type { AiCommitStyle, SvnCommitPlan, SvnCommitResult } from '../shared/svn.js'
import { rpc } from './rpc.js'

/** 提交计划结果。 */
export interface SvnCommitPlanOutcome {
  /** 是否成功。 */
  ok: boolean
  /** 计划（ok 时存在）。 */
  plan?: SvnCommitPlan
  /** 反馈文案（失败含原因）。 */
  message: string
}

/** 提交结果。 */
export interface SvnCommitDoOutcome {
  /** 是否成功。 */
  ok: boolean
  /** 提交结果（ok 时存在；失败时也可能带 conflicts 等诊断）。 */
  result?: SvnCommitResult
  /** 反馈文案（失败含原因）。 */
  message: string
}

/** AI 提交信息结果。 */
export interface SvnAiCommitOutcome {
  /** 是否成功。 */
  ok: boolean
  /** 首行。 */
  subject?: string
  /** 正文。 */
  body?: string
  /** 完整提交信息（首行 + 空行 + 正文）。 */
  text?: string
  /** 实际使用的模型。 */
  model?: string
  /** 分析统计（文件数 / diff 字节 / 是否含 diff）。 */
  stats?: { files: number; diffBytes: number; diffIncluded: boolean }
  /** 反馈文案（失败含原因）。 */
  message: string
}

/**
 * 读取提交计划（变更清单 + changelist + 最近信息）。
 * @author ddj 2026年11月15号
 * @param sessionId 会话 id
 * @returns 计划或错误文案
 */
export async function svnCommitPlan(sessionId?: string): Promise<SvnCommitPlanOutcome> {
  try {
    const res = await rpc('svn.commitPlan', { sessionId })
    if (!res.ok) return { ok: false, message: '读取提交清单失败：' + res.error }
    return { ok: true, plan: res as unknown as SvnCommitPlan, message: '已读取提交清单' }
  } catch (error) {
    return { ok: false, message: '读取提交清单失败：' + String(error) }
  }
}

/**
 * 执行提交（host 会先 status 重查，再按开关自动整理）。
 * @author ddj 2026年11月15号
 * @param sessionId 会话 id
 * @param request 提交请求
 * @returns 提交结果或错误文案
 */
export async function svnCommitNow(
  sessionId: string | undefined,
  request: { paths: string[]; message: string; changelist?: string; keepLocks?: boolean; autoAdd?: boolean; autoDelete?: boolean },
): Promise<SvnCommitDoOutcome> {
  try {
    const res = await rpc('svn.commit', { sessionId, ...request })
    if (!res.ok) return { ok: false, message: '提交失败：' + res.error }
    return { ok: true, result: res as unknown as SvnCommitResult, message: res.summary ?? '提交完成' }
  } catch (error) {
    return { ok: false, message: '提交失败：' + String(error) }
  }
}

/**
 * 生成提交信息草稿（只分析给定路径，不提交）。
 * @author ddj 2026年11月15号
 * @param sessionId 会话 id
 * @param paths 提交范围
 * @param style 风格（缺省由 host 按设置决定）
 * @returns 草稿或错误文案
 */
export async function svnAiCommitMsg(sessionId: string | undefined, paths: string[], style?: AiCommitStyle): Promise<SvnAiCommitOutcome> {
  try {
    const res = await rpc('svn.aiCommitMsg', { sessionId, paths, ...(style ? { style } : {}) })
    if (!res.ok) return { ok: false, message: 'AI 生成提交信息失败：' + res.error }
    return {
      ok: true,
      subject: res.subject,
      body: res.body,
      text: res.message,
      model: res.model,
      stats: res.stats,
      message: '已生成提交信息（请确认后再提交）',
    }
  } catch (error) {
    return { ok: false, message: 'AI 生成提交信息失败：' + String(error) }
  }
}
