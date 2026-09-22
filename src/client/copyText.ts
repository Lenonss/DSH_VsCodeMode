/**
 * dsh-vscode-mode client — 剪贴板写入 + 反馈（页签菜单与文件树菜单共用）。
 * 提取自 EditorView 的 copyText 闭包：无剪贴板 API 或写入失败时降级提示、不抛错。
 * 作者 ddj 2026年09月22号
 */

/**
 * 写入文本到系统剪贴板并给出反馈。
 * @author ddj 2026年09月22号
 * @param value 待复制文本
 * @param okText 成功反馈文案
 * @param notify 反馈通道（缺省不反馈）
 * @returns 是否复制成功
 */
export async function copyText(value: string, okText: string, notify?: (message: string) => void): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    notify?.('剪贴板不可用')
    return false
  }
  try {
    await navigator.clipboard.writeText(value)
    notify?.(okText)
    return true
  } catch {
    notify?.('剪贴板写入失败')
    return false
  }
}
