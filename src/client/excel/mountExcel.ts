/** Mounts the shared Excel engine panel without ever duplicating an engine. @author ddj 2026年11月10号 */
import type { ExcelState } from './controller.js'
import { loadChunk } from '../lazyPanel.js'

const FILE = './client.excel.js'
type ExcelPanel = (state: ExcelState, path: string, cwd?: string) => HTMLElement
type ExcelPanelLoader = () => Promise<ExcelPanel>

/** @private @author ddj 2026年11月10号 @returns The engine chunk's panel factory. @throws Incomplete chunk export. */
function loadExcelPanel(): Promise<ExcelPanel> {
  return loadChunk(FILE).then((exports) => {
    const { excelPanel } = exports
    if (typeof excelPanel !== 'function') throw new Error('表格脚本缺少面板导出')
    return excelPanel as ExcelPanel
  })
}

/** @public @author ddj 2026年11月10号 @param host Mount point owned by the current view. @param state Shared per-file controller. @param path Original file path. @param cwd Owning workspace for native path resolution. @param load Test-injected engine loader. @sideEffects Downloads the engine chunk only when no shared node exists yet. */
export async function mountExcel(host: HTMLElement, state: ExcelState, path: string, cwd?: string, load: ExcelPanelLoader = loadExcelPanel): Promise<void> {
  if (state.node) {
    if (state.node.parentNode !== host) host.appendChild(state.node)
    return
  }

  const excelPanel = await load()
  if (!host.isConnected) return

  const node = state.node ?? excelPanel(state, path, cwd)
  if (node.parentNode !== host) host.appendChild(node)
}
