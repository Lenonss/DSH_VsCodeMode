/**
 * dsh-vscode-mode client — 会话缺失错误识别与友好文案。
 * 跨端场景：桌面端与 Web 端各自运行独立 DSH 实例，会话列表跨实例可见，
 * 但会话仅在一端激活；另一端发起的 edrv.* RPC 会被 host requireSession
 * 以「会话不存在」拒绝。此处把该错误归类为终态提示（非反复重试可解），
 * 并给出引导文案，替代裸错误卡死观感。
 * 作者 ddj 2026年10月16号
 */
import { SESSION_MISSING_ERROR } from '../shared/rpc.js'

/**
 * 判断错误文案是否为「会话不存在」类错误。
 * @author ddj 2026年10月16号
 * @param text 任意错误文本（host 业务 error、异常 message 等原始形态）
 * @returns 命中规范文案（含拼接形态，如「会话不存在：路径」）返回 true；空值安全
 */
export function isSessionMissingError(text: unknown): boolean {
  return String(text ?? '').includes(SESSION_MISSING_ERROR)
}

/**
 * 会话缺失提示标题（编辑区终态面板与侧栏红条共用）。
 * @author ddj 2026年10月16号
 * @returns 简短标题文案
 */
export function sessionMissingTitle(): string {
  return '会话在当前端不可用'
}

/**
 * 会话缺失提示详情：说明成因并给出引导（去持有端查看，或在本端打开会话后重试）。
 * @author ddj 2026年10月16号
 * @returns 多句详情文案
 */
export function sessionMissingDetail(): string {
  return '该会话可能正被其他 DSH 实例（桌面端 / Web 端）占用，或尚未在当前实例激活。' +
    '请在持有该会话的一端查看，或在本端打开该会话后重试。'
}
