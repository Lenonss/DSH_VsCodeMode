import { encodeExcel } from './codec.js'
import type { IWorkbookData } from '@univerjs/presets'

/** @public @author ddj 2026年10月28号 @param snapshot Immutable revision snapshot. @param path Source name only. @sideEffects Starts a browser download, never a Host save or original-file handoff. */
export async function downloadExcel(snapshot: IWorkbookData, path: string, live: () => boolean = () => true): Promise<void> {
  const bytes = await encodeExcel(snapshot)
  if (!live()) throw new Error('Excel 导出已取消，文档已关闭或重新加载')
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = (path.split(/[\\/]/).pop() || 'Workbook.xlsx').replace(/\.xlsx$/i, '') + '-副本.xlsx'
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}
