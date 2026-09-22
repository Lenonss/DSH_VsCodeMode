/**
 * dsh-vscode-mode client — 前端导出工具（W1-4：变更列表/日志列表 → CSV/HTML 文件下载）。
 *
 * 纯前端拼装：Blob + 隐式 `<a download>` 触发，不经 host、不写工作副本；
 * CSV 前置 UTF-8 BOM 保证 Excel 直开中文不乱码；导出物只在本地，不含凭据、不外发。
 * 下载失败（无 Blob/下载权限等）静默返回 false，由调用方决定是否提示。
 * 作者 ddj 2026年09月20号
 */

/**
 * 二维表 → CSV 文本（RFC 4180：含逗号/引号/换行的字段加引号包裹、内部引号翻倍；行尾 CRLF）。
 * @author ddj 2026年09月20号
 * @param rows 二维字符串表（表头行由调用方一并传入）
 * @returns CSV 文本（前置 UTF-8 BOM）
 */
export function csvOf(rows: unknown[][]): string {
  const esc = (cell: unknown): string => {
    const text = String(cell ?? '')
    return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text
  }
  const body = (rows || []).map((row) => (row || []).map(esc).join(',')).join('\r\n')
  return '\uFEFF' + body + '\r\n'
}

/**
 * 二维表 → 简单 HTML 报表（W1-4；全部经 HTML 转义防注入，UTF-8 声明 + 内联样式）。
 * @author ddj 2026年09月20号
 * @param headers 表头字符串数组
 * @param rows 二维字符串表
 * @param caption 页面标题（可空）
 * @returns 完整 HTML 文档文本
 */
export function htmlTableOf(headers: unknown[], rows: unknown[][], caption?: string): string {
  const esc = (value: unknown): string => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  const head = '<tr>' + (headers || []).map((cell) => '<th>' + esc(cell) + '</th>').join('') + '</tr>'
  const body = (rows || []).map((row) => '<tr>' + (row || []).map((cell) => '<td>' + esc(cell) + '</td>').join('') + '</tr>').join('')
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(caption || '导出') + '</title>'
    + '<style>body{font-family:system-ui,sans-serif;font-size:13px;color:#1f2933;margin:16px}'
    + 'table{border-collapse:collapse}th,td{border:1px solid #d5dbdb;padding:2px 8px;text-align:left;vertical-align:top}'
    + 'th{background:#f0f4f4}h3{margin:0 0 10px}</style>'
    + '</head><body><h3>' + esc(caption || '') + '</h3><table>' + head + body + '</table></body></html>'
}

/**
 * 文本下载（Blob + `a[download]` 一次点击；异步 revoke 免内存泄漏）。
 * @author ddj 2026年09月20号
 * @param filename 下载文件名（建议带扩展名）
 * @param text 文件内容（文本直接写入，CSV 已含 BOM 由 csvOf 负责）
 * @param mime MIME 类型（不带 charset，函数内补 utf-8）
 * @returns 是否触发成功（false = 浏览器能力缺失，调用方可提示）
 */
export function downloadText(filename: string, text: string, mime: string): boolean {
  try {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return true
  } catch (error) {
    return false
  }
}
