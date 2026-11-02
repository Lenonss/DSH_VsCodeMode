/**
 * dsh-vscode-mode client — 加载失败诊断（把「加载失败」拆成可定位的四类原因）。
 *
 * 为什么需要：宿主对非 loopback/bind/trustedHosts 的 Host 一律回 403（Host 围栏），
 * 认证失效回 401，路由或资源缺失回 404，另有纯网络失败。此前 Monaco/pdf.js 的失败面板
 * 一律提示「检查资源是否完整」，远程访问时会把 403 误报成资源缺失，误导排查方向。
 *
 * 文案只输出 pathname 与状态码，不含 origin、查询串、cookie 或任何凭据。
 * @author ddj 2026年11月02号
 */

/** 状态码 0：请求未完成（网络错误 / 被拦截 / 离线）。 */
const NETWORK_FAILED = 0

/**
 * 探测资源地址的真实响应状态。
 * @author ddj 2026年11月02号
 * @param url 已解析的绝对或根路径地址
 * @returns HTTP 状态码；请求未完成时返回 0
 */
export async function probeStatus(url: string): Promise<number> {
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'same-origin' })
    return res.status
  } catch (e) {
    return NETWORK_FAILED
  }
}

/**
 * 取地址的 pathname（只用于诊断文案，避免暴露 origin 与查询串）。
 * @author ddj 2026年11月02号
 * @param url 绝对或根路径地址
 * @returns pathname；无法解析时原样返回
 */
function pathOf(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname
  } catch (e) {
    return url
  }
}

/**
 * 状态码 → 可操作的原因说明（四类互不相同）。
 * @author ddj 2026年11月02号
 * @param status HTTP 状态码，0 表示请求未完成
 * @returns 原因说明
 */
export function statusHint(status: number): string {
  if (status === NETWORK_FAILED) return '请求未到达宿主（网络不可达、被浏览器或代理拦截、或宿主已停止）'
  if (status === 403) return '宿主拒绝了当前页面（Host/Origin 校验未通过；远程访问需经远程访问插件的通道）'
  if (status === 401) return '宿主登录态失效，请重新打开已登录的应用页面'
  if (status === 404) return '路由或资源不存在（插件资源缺失或插件版本与宿主不匹配）'
  return '宿主返回了非预期状态'
}

/**
 * 组装加载失败文案：标签 + 资源路径 + 状态 + 原因。
 * @author ddj 2026年11月02号
 * @param label 失败对象（如 'Monaco loader 加载失败'）
 * @param url 加载地址
 * @param status 探测到的状态码（0=网络错误）
 * @returns 用户可读的诊断文案
 */
export function loadFailureText(label: string, url: string, status: number): string {
  const outcome = status === NETWORK_FAILED ? '请求未完成' : '返回 HTTP ' + status
  return label + '：' + pathOf(url) + ' ' + outcome + '；' + statusHint(status)
}

/**
 * Monaco 失败面板提示：按错误内容给出对应排查方向（不再一律提示「检查资源是否完整」）。
 * @author ddj 2026年11月02号
 * @param message 编辑器记录的失败原因
 * @returns 排查建议
 */
export function monacoHint(message: string): string {
  const text = String(message ?? '')
  if (/403/.test(text)) return '宿主拒绝了本次请求：远程访问需经远程访问插件的通道（本页已自动接入）；本机访问请用 127.0.0.1 或 localhost 打开。'
  if (/401/.test(text)) return '宿主登录态失效：请重新打开已登录的应用页面后再试。'
  if (/404/.test(text)) return 'Monaco 静态资源未找到：插件包 assets/vendor/monaco 可能不完整，或插件版本与宿主不匹配。'
  if (/请求未完成|Failed to fetch|NetworkError/i.test(text)) return '请求未能到达宿主：请检查网络、代理与宿主进程状态。'
  return '请展开下方详情，并在浏览器控制台确认失败请求的地址与状态码。'
}
