/** Lazily materialized Excel codec; the root bundle never carries exceljs/fflate/saxes. @author ddj 2026年11月10号 */
import type { IWorkbookData } from '@univerjs/presets'
import { loadChunk } from '../lazyPanel.js'
import type { ExcelDocument } from './model.js'

export interface ExcelCodec {
  decodeExcel: (bytes: Uint8Array) => Promise<ExcelDocument>
  downloadExcel: (snapshot: IWorkbookData, path: string, live?: () => boolean) => Promise<void>
}

const FILE = './client.excelcodec.js'
let factory: (() => Promise<ExcelCodec>) | undefined

/** @public @author ddj 2026年11月10号 @param next Test-injected loader; omit to restore the on-demand chunk transport. */
export function setExcelCodec(next?: () => Promise<ExcelCodec>): void {
  factory = next
}

/** @private @author ddj 2026年11月10号 @param exports Raw codec chunk exports. @returns Validated codec functions. @throws Incomplete chunk export. */
function pickCodec(exports: Record<string, unknown>): ExcelCodec {
  const { decodeExcel, downloadExcel } = exports
  if (typeof decodeExcel !== 'function' || typeof downloadExcel !== 'function') throw new Error('表格编解码脚本缺少导出')
  return { decodeExcel, downloadExcel } as ExcelCodec
}

/** @public @author ddj 2026年11月10号 @returns Codec functions from the injected loader or the shared on-demand chunk. */
export function loadExcelCodec(): Promise<ExcelCodec> {
  if (factory) return factory()
  return loadChunk(FILE).then(pickCodec)
}
