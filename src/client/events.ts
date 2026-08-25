/**
 * dsh-vscode-mode client — 跨组件/跨 slot 的窗口事件助手。
 * 迁移自原 src/client/index.ts 的 openEditorView 与事件派发，语义不改；
 * 侧边栏形态（sidebarBridge 已注册路由）优先，否则回退 DOM 页签点击。
 * 作者 ddj 2026-08-20
 */
import { routeSideEditor } from './sidebarBridge.js'

/**
 * 选择中央「文件编辑」页签（DOM 级，无需 store actions）。仅旧页签形态使用。
 * @author ddj 2026年08月26号
 */
function selectEditorTab(): void {
  const tabs = Array.from(document.querySelectorAll('div[role="tablist"] button[role="tab"]'))
  for (const tab of tabs) {
    if (tab.textContent && tab.textContent.includes('文件编辑')) {
      (tab as HTMLButtonElement).click()
      break
    }
  }
}

/**
 * 打开「文件编辑」：侧边栏形态路由优先，旧形态回退中央页签。
 * @author ddj 2026年08月26号
 * @param path 要打开的路径（可空）
 */
export function openEditorView(path: string | null): void {
  if (routeSideEditor(path ?? null, false)) return
  selectEditorTab()
  const target = path ?? null
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('edrv:open-editor', { detail: { path: target } }))
  }, 80)
}

/**
 * 打开文件编辑页并聚焦指定文件的首个差异（侧边栏形态自动展开面板）。
 * @author ddj 2026年08月26号
 * @param path 待聚焦的差异文件路径
 */
export function openDiffView(path: string): void {
  if (routeSideEditor(path, true)) return
  selectEditorTab()
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('edrv:open-editor', {
      detail: { path, focusDiff: true },
    }))
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

/**
 * 拉起 DiffLauncher。
 * @author ddj 2026年08月26号
 * @param tab 可选的目标页签
 */
export function emitShowLauncher(tab?: 'pending' | 'archive'): void {
  window.dispatchEvent(new CustomEvent('edrv:show-launcher', { detail: { tab } }))
}
