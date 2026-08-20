/**
 * dsh-vscode-mode client — 跨组件/跨 slot 的窗口事件助手。
 * 迁移自原 src/client/index.ts 的 openEditorView 与事件派发，语义不改。
 * 作者 ddj 2026-08-20
 */

/**
 * 打开中央「文件编辑」页签：点击 shell 会话头部的视图页签（DOM 级，无需 store actions）。
 * @author ddj 2026年08月20号
 * @param path 要打开的路径（可空）
 */
export function openEditorView(path: string | null): void {
  const tabs = Array.from(document.querySelectorAll('div[role="tablist"] button[role="tab"]'))
  for (const b of tabs) {
    if (b.textContent && b.textContent.includes('文件编辑')) { (b as HTMLButtonElement).click(); break }
  }
  const p = path ?? null
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('edrv:open-editor', { detail: { path: p } }))
  }, 80)
}

/** 差异状态变化：触发角标/DiffBox 重拉。 */
export function emitRefresh(): void {
  window.dispatchEvent(new CustomEvent('edrv:refresh'))
}

/** 打开指定路径到编辑区页签。 */
export function emitOpenEditor(path: string): void {
  window.dispatchEvent(new CustomEvent('edrv:open-editor', { detail: { path } }))
}

/** 拉起 DiffLauncher。 */
export function emitShowLauncher(): void {
  window.dispatchEvent(new CustomEvent('edrv:show-launcher'))
}
