import ExcelJS from 'exceljs'
import { Unzip, UnzipInflate, strFromU8, strToU8, zipSync } from 'fflate/browser'
import { xmlGate, parseXml, basicXml } from './xmlGate.js'
import { DateSystem, LocaleType, type IWorkbookData, type IStyleData, type ICellData } from '@univerjs/presets'
import { basicFormula, EXCEL_LIMITS, type ExcelDocument } from './model.js'

const PARTS = /^(?:\[Content_Types\]\.xml|_rels\/\.rels|docProps\/(?:app|core)\.xml|xl\/(?:workbook\.xml|styles\.xml|sharedStrings\.xml|theme\/theme\d+\.xml|_rels\/workbook\.xml\.rels|worksheets\/sheet\d+\.xml))$/
const RELATIONS = new Set(['officeDocument', 'metadata/core-properties', 'extended-properties', 'worksheet', 'styles', 'sharedStrings', 'theme'])
const BORDER_NAMES = ['', 'thin', 'hair', 'dotted', 'dashed', 'dashDot', 'dashDotDot', 'double', 'medium', 'mediumDashed', 'mediumDashDot', 'mediumDashDotDot', 'slantDashDot', 'thick']
const HORIZONTAL = ['', 'left', 'center', 'right', 'justify', 'justify', 'distributed']
const VERTICAL = ['', 'top', 'middle', 'bottom']
const THEME = ['#FFFFFF', '#000000', '#E7E6E6', '#44546A', '#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47', '#0563C1', '#954F72']

/** @private @author ddj 2026年10月28号 @param bytes ZIP bytes. @returns Bounded XML entries; throws before exceeding an inflation budget. */
export function inspectZip(bytes: Uint8Array): Map<string, string> {
  if (bytes.byteLength > EXCEL_LIMITS.compressed) throw new Error('Excel 压缩文件超过 20MiB')
  if (bytes[0] !== 80 || bytes[1] !== 75) throw new Error('Excel 已加密或不是有效的 XLSX ZIP')
  const parts = new Map<string, string>()
  const checksums = zipDirectory(bytes)
  let total = 0
  let entries = 0
  let failure: Error | undefined
  const unzip = new Unzip((entry) => {
    if (++entries > EXCEL_LIMITS.entries || parts.has(entry.name)) throw new Error('Excel ZIP 条目过多或存在重复部件')
    const chunks: Uint8Array[] = []
    let size = 0
    parts.set(entry.name, '')
    entry.ondata = (error, chunk, final) => {
      if (error) { failure = error; return }
      size += chunk.byteLength
      total += chunk.byteLength
      if (size > EXCEL_LIMITS.part || total > EXCEL_LIMITS.expanded) throw new Error('Excel 解压超过单部件 32MiB 或累计 100MiB 限制')
      chunks.push(chunk)
      if (!final) return
      const joined = new Uint8Array(size)
      let offset = 0
      for (const item of chunks) { joined.set(item, offset); offset += item.byteLength }
      const expected = checksums.get(entry.name)
      if (!expected || expected.size !== size || expected.crc !== crc32(joined)) throw new Error('Excel ZIP CRC/目录大小不一致或已损坏')
      parts.set(entry.name, strFromU8(joined))
    }
    entry.start()
  })
  unzip.register(UnzipInflate)
  // Feed bounded chunks so inflation cannot allocate the whole archive before accounting.
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    unzip.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length)
    if (failure) throw failure
  }
  if (parts.size !== checksums.size) throw new Error('Excel ZIP 本地条目与中央目录不一致')
  if (!parts.has('xl/workbook.xml') || !parts.has('[Content_Types].xml')) throw new Error('Excel 工作簿部件缺失或文件损坏')
  return parts
}

/** @private @author ddj 2026年10月28号 @param bytes Original entry. @returns ZIP CRC32. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** @private @author ddj 2026年10月28号 @param bytes Original archive. @returns Bounded central-directory CRC/size map; encrypted, ZIP64 and ambiguous entries fail closed. */
function zipDirectory(bytes: Uint8Array): Map<string, { crc: number; size: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = bytes.length - 22
  for (; eocd >= Math.max(0, bytes.length - 65557); eocd--) if (view.getUint32(eocd, true) === 0x06054b50) break
  if (eocd < 0 || eocd + 22 > bytes.length) throw new Error('Excel ZIP 中央目录缺失')
  const count = view.getUint16(eocd + 10, true)
  const size = view.getUint32(eocd + 12, true)
  const offset = view.getUint32(eocd + 16, true)
  if (view.getUint16(eocd + 4, true) || view.getUint16(eocd + 6, true) || count > EXCEL_LIMITS.entries || offset + size !== eocd) throw new Error('Excel 不支持分卷、ZIP64 或无效目录')
  const result = new Map<string, { crc: number; size: number }>()
  let cursor = offset
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Excel ZIP 条目目录损坏')
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const expanded = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extra = view.getUint16(cursor + 30, true)
    const comment = view.getUint16(cursor + 32, true)
    if ((flags & 1) || ![0, 8].includes(method) || expanded > EXCEL_LIMITS.part) throw new Error('Excel ZIP 已加密、压缩方式不支持或单部件超限')
    const name = strFromU8(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    if (result.has(name) || /(?:^|\/)\.\.(?:\/|$)|\\/.test(name) || name.startsWith('/')) throw new Error('Excel ZIP 重复/越界部件名')
    result.set(name, { crc: view.getUint32(cursor + 16, true), size: expanded })
    cursor += 46 + nameLength + extra + comment
  }
  if (cursor !== eocd) throw new Error('Excel ZIP 目录长度不一致')
  return result
}

/** @private @author ddj 2026年10月28号 @param parts Original OOXML entries. @returns Reasons that prevent loss-safe conversion, before ExcelJS drops unknown data. */
export function rawGate(parts: Map<string, string>): string[] {
  const reasons = new Set<string>()
  for (const [name, xml] of parts) {
    if (name.endsWith('/')) continue
    if (!PARTS.test(name)) reasons.add('不支持的 OOXML 部件：' + name)
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Excel XML 包含不安全的实体定义')
    if (name.endsWith('.rels')) {
      for (const tag of xml.matchAll(/<Relationship\b[^>]*>/g)) {
        const relation = /\bType=["']([^"']+)["']/.exec(tag[0])?.[1] || ''
        const suffix = relation.replace(/^https?:\/\/schemas\.openxmlformats\.org\/(?:officeDocument\/2006|package\/2006)\/relationships\//, '')
        if (!RELATIONS.has(suffix) || /TargetMode=["']External/i.test(tag[0])) reasons.add('外部或未知关系：' + relation)
      }
    }
    if (!/^xl\/(?:worksheets\/sheet\d+|workbook|styles|sharedStrings)\.xml$/.test(name)) continue
    if (/<(?:\w+:)?(?:drawing|legacyDrawing|picture|pivotTable|tableParts|extLst|sheetProtection|workbookProtection|conditionalFormatting|dataValidations|hyperlink|definedName|autoFilter|controls|oleObjects|rPh|phoneticPr|r)(?:\s|>)/.test(basicXml(name, xml))) reasons.add('包含高级对象、保护、富文本、筛选或扩展：' + name)
    for (const formula of xml.matchAll(/<(?:\w+:)?f\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?f>/g)) {
      if (formula[1].trim() || !basicFormula(xmlText(formula[2]))) reasons.add('不支持的复杂/共享/数组公式：' + name)
    }
    if (/<(?:\w+:)?f\b[^>]*\/>/.test(xml)) reasons.add('共享或空公式：' + name)
  }
  return [...reasons]
}

/** @private @author ddj 2026年10月28号 @param text XML text. @returns Decoded predefined XML entities. */
function xmlText(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity]!)
}

/** @private @author ddj 2026年10月28号 @param color Excel color. @returns RGB resolved for common default theme colors. */
function colorOf(color?: Partial<ExcelJS.Color>, palette = THEME): { rgb: string } | undefined {
  if (!color) return undefined
  if (color.argb) return { rgb: '#' + color.argb.slice(-6) }
  if (color.theme !== undefined) return { rgb: palette[color.theme] || '#000000' }
  return undefined
}

/** @private @author ddj 2026年10月28号 @param parts Original theme parts. @returns Actual theme palette, not hard-coded Office assumptions. */
function themePalette(parts: Map<string, string>): string[] {
  const palette = [...THEME]
  const order = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']
  let index = -1
  const xml = [...parts].find(([name]) => /^xl\/theme\/theme\d+\.xml$/.test(name))?.[1]
  if (!xml) return palette
  parseXml(xml, (tag) => {
    if (order.includes(tag.local)) index = order.indexOf(tag.local)
    if (index < 0 || !['srgbClr', 'sysClr'].includes(tag.local)) return
    const attributes = Object.values(tag.attributes)
    const rgb = attributes.find((entry) => entry.local === (tag.local === 'sysClr' ? 'lastClr' : 'val'))?.value
    if (rgb && /^[a-f\d]{6}$/i.test(rgb)) palette[index] = '#' + rgb
    index = -1
  })
  return palette
}

/** @private @author ddj 2026年10月28号 @param style ExcelJS style. @returns Explicit supported Univer style. */
function importStyle(style: Partial<ExcelJS.Style>, palette: string[]): IStyleData {
  const font = style.font || {}
  const alignment = style.alignment || {}
  const result: IStyleData = { ff: font.name, fs: font.size, bl: font.bold ? 1 : 0, it: font.italic ? 1 : 0, cl: colorOf(font.color, palette), ul: { s: font.underline ? 1 : 0 }, st: { s: font.strike ? 1 : 0 }, n: { pattern: style.numFmt || 'General' } }
  if (style.fill?.type === 'pattern' && style.fill.pattern === 'solid') result.bg = colorOf(style.fill.fgColor, palette)
  result.ht = Math.max(0, HORIZONTAL.indexOf(alignment.horizontal || ''))
  result.vt = Math.max(0, VERTICAL.indexOf(alignment.vertical || ''))
  result.tb = alignment.wrapText ? 3 : 1
  result.bd = {}
  for (const [edge, key] of [['top', 't'], ['bottom', 'b'], ['left', 'l'], ['right', 'r']] as const) {
    const border = style.border?.[edge]
    if (border?.style) result.bd[key] = { s: BORDER_NAMES.indexOf(border.style), cl: colorOf(border.color, palette) || { rgb: '#000000' } }
  }
  return result
}

/** @private @author ddj 2026年10月28号 @param workbook Parsed workbook. @returns Independent model-level refusal reasons and resource validation. */
function modelGate(workbook: ExcelJS.Workbook): string[] {
  if (workbook.worksheets.length > EXCEL_LIMITS.sheets) throw new Error('Excel 超过 50 个工作表')
  const reasons = new Set<string>()
  let count = 0
  for (const sheet of workbook.worksheets) {
    if (sheet.state !== 'visible' || sheet.getImages().length || (sheet.model as ExcelJS.WorksheetModel & { sheetProtection?: unknown }).sheetProtection) reasons.add('隐藏工作表、图片或保护：' + sheet.name)
    sheet.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (cell) => {
      if (++count > EXCEL_LIMITS.cells) throw new Error('Excel 已用单元格超过 200000')
      if (cell.formula && (!basicFormula(cell.formula) || cell.formulaType !== ExcelJS.FormulaType.Master)) reasons.add('复杂公式：' + sheet.name + '!' + cell.address)
      if (cell.type === ExcelJS.ValueType.RichText || cell.type === ExcelJS.ValueType.Hyperlink || cell.type === ExcelJS.ValueType.Error) reasons.add('富文本、超链接或错误值：' + sheet.name + '!' + cell.address)
      if (cell.fill?.type === 'gradient' || (cell.fill?.type === 'pattern' && !['none', 'solid'].includes(cell.fill.pattern))) reasons.add('不支持的填充：' + cell.address)
      if (cell.alignment?.textRotation || cell.alignment?.indent || cell.alignment?.shrinkToFit || cell.border?.diagonal || cell.font?.vertAlign) reasons.add('高级样式：' + cell.address)
    }))
  }
  return [...reasons]
}

/** @public @author ddj 2026年10月28号 @param bytes Original XLSX. @returns Guarded multi-sheet snapshot; unsupported files are data-only previews. @throws Corrupt/encrypted or budget-exceeding files. */
export async function decodeExcel(bytes: Uint8Array): Promise<ExcelDocument> {
  const parts = inspectZip(bytes)
  const reasons = [...rawGate(parts), ...xmlGate(parts)]
  const workbook = new ExcelJS.Workbook()
  // ExcelJS receives a new unambiguous archive, not a second interpretation of untrusted local/central headers.
  const safeEntries = Object.fromEntries([...parts].filter(([name]) => PARTS.test(name)).map(([name, xml]) => [name, strToU8(xml)]))
  await workbook.xlsx.load(zipSync(safeEntries) as never)
  reasons.push(...modelGate(workbook))
  const snapshot: IWorkbookData = { id: 'excel-' + crypto.randomUUID(), name: 'Workbook', appVersion: '1.2.0', locale: LocaleType.ZH_CN, styles: {}, sheetOrder: [], sheets: {} }
  if (workbook.properties.date1904) snapshot.dateSystem = DateSystem.Date1904
  const palette = themePalette(parts)
  for (const sheet of workbook.worksheets) importSheet(snapshot, sheet, workbook.properties.date1904 === true, palette)
  return { snapshot, reasons: [...new Set(reasons)] }
}

/** @private @author ddj 2026年10月28号 @param snapshot Destination snapshot. @param sheet Parsed sheet. @param date1904 Date epoch. @sideEffects Adds one bounded sheet. */
function importSheet(snapshot: IWorkbookData, sheet: ExcelJS.Worksheet, date1904: boolean, palette: string[]): void {
  const id = String(sheet.id)
  const cellData: Record<number, Record<number, ICellData>> = {}
  const rowData: Record<number, { h?: number }> = {}
  const columnData: Record<number, { w?: number }> = {}
  sheet.eachRow({ includeEmpty: false }, (row, rowIndex) => {
    if (row.height) rowData[rowIndex - 1] = { h: row.height * 4 / 3 }
    row.eachCell({ includeEmpty: false }, (cell, column) => {
      if (cell.isMerged && cell.master.address !== cell.address) return
      const target: ICellData = { s: importStyle(cell.style, palette) }
      const value = cell.value
      if (cell.formula) target.f = '=' + cell.formula
      let scalar = cell.formula ? cell.result : value
      if (scalar instanceof Date) scalar = scalar.getTime() / 86400000 + (date1904 ? 24107 : 25569)
      if (typeof scalar === 'string' || typeof scalar === 'number' || typeof scalar === 'boolean') {
        target.v = scalar
        target.t = typeof scalar === 'boolean' ? 3 : typeof scalar === 'number' ? 2 : 4
      }
      else if (value !== null && !cell.formula) target.v = cell.text
      if (!cellData[rowIndex - 1]) cellData[rowIndex - 1] = {}
      cellData[rowIndex - 1][column - 1] = target
    })
  })
  sheet.columns.forEach((column, index) => { if (column.width) columnData[index] = { w: column.width * 7 + 5 } })
  const mergeData = (sheet.model.merges || []).map((range) => {
    const decoded = sheet.getCell(range.split(':')[0])
    const end = sheet.getCell(range.split(':')[1] || range)
    return { startRow: Number(decoded.row) - 1, startColumn: Number(decoded.col) - 1, endRow: Number(end.row) - 1, endColumn: Number(end.col) - 1 }
  })
  snapshot.sheetOrder.push(id)
  snapshot.sheets[id] = { id, name: sheet.name, rowCount: Math.max(sheet.rowCount + 100, 1000), columnCount: Math.max(sheet.columnCount + 20, 26), cellData, rowData, columnData, mergeData, defaultRowHeight: 20, defaultColumnWidth: 80 }
}

/** @private @author ddj 2026年10月28号 @param style Supported Univer style. @returns Basic ExcelJS style for a new workbook, never an original-file write. */
function exportStyle(style: IStyleData): Partial<ExcelJS.Style> {
  const color = (rgb?: string | null | void): Partial<ExcelJS.Color> | undefined => rgb ? { argb: 'FF' + rgb.replace('#', '') } : undefined
  const result: Partial<ExcelJS.Style> = {
    font: { name: style.ff || undefined, size: style.fs || undefined, bold: style.bl === 1, italic: style.it === 1, strike: style.st?.s === 1, underline: style.ul?.s === 1, color: color(style.cl?.rgb) },
    alignment: { horizontal: HORIZONTAL[style.ht || 0] as ExcelJS.Alignment['horizontal'] || undefined, vertical: VERTICAL[style.vt || 0] as ExcelJS.Alignment['vertical'] || undefined, wrapText: style.tb === 3 },
    numFmt: style.n?.pattern || 'General', border: {},
  }
  if (style.bg?.rgb) result.fill = { type: 'pattern', pattern: 'solid', fgColor: color(style.bg.rgb) }
  for (const [edge, key] of [['top', 't'], ['bottom', 'b'], ['left', 'l'], ['right', 'r']] as const) {
    const border = style.bd?.[key]
    if (border) result.border![edge] = { style: BORDER_NAMES[border.s] as ExcelJS.BorderStyle, color: color(border.cl?.rgb) }
  }
  return result
}

/** @private @author ddj 2026年10月28号 @param index Zero-based coordinate. @param limit Exclusive dimension limit. @sideEffects Rejects invalid coordinates before ExcelJS allocates rows or merges. */
function checkIndex(index: number, limit: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= limit) throw new Error('Excel 导出坐标越界')
}

/** @private @author ddj 2026年10月28号 @param snapshot Captured edit. @sideEffects Rejects unsupported editing metadata and validates cumulative merge allocations before creating any ExcelJS worksheet. */
function checkSnapshot(snapshot: IWorkbookData): void {
  let merged = 0
  const allowed = new Set(['id', 'name', 'rowCount', 'columnCount', 'cellData', 'rowData', 'columnData', 'mergeData', 'defaultRowHeight', 'defaultColumnWidth', 'hidden', 'freeze', 'zoomRatio', 'scrollTop', 'scrollLeft', 'rowHeader', 'columnHeader', 'showGridlines', 'rightToLeft', 'tabColor', 'status'])
  for (const id of snapshot.sheetOrder) {
    const sheet = snapshot.sheets[id]
    if (!sheet) throw new Error('工作表快照缺失')
    const metadata = sheet as unknown as Record<string, unknown>
    for (const [key, entry] of Object.entries(metadata)) {
      if (!allowed.has(key) && entry != null) throw new Error('不支持的工作表编辑字段：' + key)
    }
    if (sheet.hidden || sheet.rightToLeft || sheet.tabColor) throw new Error('导出不支持隐藏工作表、从右向左或工作表颜色')
    if (sheet.freeze && Object.entries(sheet.freeze).some(([key, entry]) => Number(entry) !== (key.startsWith('start') ? -1 : 0))) throw new Error('导出不支持冻结窗格')
    for (const [row, cells] of Object.entries(sheet.cellData || {})) {
      checkIndex(Number(row), 1048576)
      for (const [col, cell] of Object.entries(cells || {})) {
        checkIndex(Number(col), 16384)
        if (cell) checkCell(cell, snapshot)
      }
    }
    checkDimensions(sheet.rowData, 1048576, ['h', 'ah'])
    checkDimensions(sheet.columnData, 16384, ['w'])
    for (const range of sheet.mergeData || []) {
      checkIndex(range.startRow, 1048576); checkIndex(range.endRow, 1048576)
      checkIndex(range.startColumn, 16384); checkIndex(range.endColumn, 16384)
      if (range.endRow < range.startRow || range.endColumn < range.startColumn) throw new Error('Excel 合并范围倒置')
      merged += (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1)
      if (merged > EXCEL_LIMITS.cells) throw new Error('Excel 累计合并范围超过 200000 单元格')
    }
  }
}

/** @private @author ddj 2026年10月28号 @param cell Edited cell. @param snapshot Style dictionary. @sideEffects Rejects unsupported cell/style fields rather than silently stripping newly edited content. */
function checkCell(cell: ICellData, snapshot: IWorkbookData): void {
  for (const [key, entry] of Object.entries(cell)) {
    if (entry != null && !['v', 't', 'f', 's'].includes(key)) throw new Error('不支持的单元格编辑字段：' + key)
  }
  const style = typeof cell.s === 'string' ? snapshot.styles[cell.s] : cell.s
  if (!style) return
  for (const [key, entry] of Object.entries(style)) {
    if (entry != null && !['ff', 'fs', 'bl', 'it', 'st', 'ul', 'cl', 'bg', 'ht', 'vt', 'tb', 'n', 'bd'].includes(key)) throw new Error('不支持的样式编辑字段：' + key)
  }
  checkStyle(style)
}

/** @private @author ddj 2026年10月28号 @param object Nested style object. @param allowed Supported non-null keys. @sideEffects Rejects nested data that the converter cannot preserve. */
function checkKeys(object: object, allowed: string[]): void {
  const unknown = Object.entries(object).filter(([key, entry]) => entry != null && !allowed.includes(key)).map(([key]) => key)
  if (unknown.length) throw new Error('不支持的嵌套样式字段：' + unknown.join(', '))
}

/** @private @author ddj 2026年10月28号 @param color Supported RGB color. @sideEffects Rejects theme references, alpha and non-RGB edited color representations. */
function checkColor(color: object): void {
  checkKeys(color, ['rgb'])
  if (!/^#[a-f\d]{6}$/i.test((color as { rgb?: string }).rgb || '')) throw new Error('不支持的样式颜色')
}

/** @private @author ddj 2026年10月28号 @param style Edited style. @sideEffects Validates exact conversion enums and every nested style object before encoding. */
function checkStyle(style: IStyleData): void {
  const enums: Record<string, number[]> = { bl: [0, 1], it: [0, 1], ht: [0, 1, 2, 3, 4, 6], vt: [0, 1, 2, 3], tb: [1, 3] }
  for (const [key, allowed] of Object.entries(enums)) {
    const entry = (style as Record<string, unknown>)[key]
    if (entry != null && !allowed.includes(entry as number)) throw new Error('不支持的样式枚举：' + key)
  }
  if (style.ff != null && typeof style.ff !== 'string') throw new Error('字体名称无效')
  if (style.fs != null && (!Number.isFinite(style.fs) || style.fs <= 0)) throw new Error('字体大小无效')
  for (const decoration of [style.ul, style.st]) {
    if (!decoration) continue
    // Univer copies font color into disabled decorations after editing. It has no visible effect.
    checkKeys(decoration, decoration.s === 0 ? ['s', 'cl'] : ['s'])
    if (decoration.cl) checkColor(decoration.cl)
    if (decoration.s != null && ![0, 1].includes(decoration.s)) throw new Error('不支持的下划线/删除线样式')
  }
  for (const color of [style.cl, style.bg]) if (color) checkColor(color)
  if (style.n) { checkKeys(style.n, ['pattern']); if (typeof style.n.pattern !== 'string') throw new Error('数字格式无效') }
  if (!style.bd) return
  checkKeys(style.bd, ['t', 'b', 'l', 'r'])
  for (const border of Object.values(style.bd)) {
    if (!border) continue
    checkKeys(border, ['s', 'cl'])
    if (!Number.isInteger(border.s) || border.s < 1 || border.s >= BORDER_NAMES.length) throw new Error('不支持的边框样式')
    if (border.cl) checkColor(border.cl)
  }
}

/** @private @author ddj 2026年10月28号 @param dimensions Row or column metadata. @param limit Coordinate limit. @param allowed Supported dimension keys. @sideEffects Rejects hidden/grouped/custom dimensions rather than silently dropping edits. */
function checkDimensions(dimensions: unknown, limit: number, allowed: string[]): void {
  for (const [index, dimension] of Object.entries((dimensions || {}) as Record<string, Record<string, unknown>>)) {
    checkIndex(Number(index), limit)
    if (!dimension) continue
    for (const [key, entry] of Object.entries(dimension)) {
      if (allowed.includes(key)) {
        if (typeof entry !== 'number' || !Number.isFinite(entry) || entry <= 0) throw new Error('Excel 行高列宽无效')
      } else if (entry != null && entry !== 0 && entry !== false) throw new Error('不支持的行列编辑字段：' + key)
    }
  }
}

/** @public @author ddj 2026年10月28号 @param snapshot Captured editing revision. @returns Browser-copy XLSX bytes after revalidating edits against the whitelist. */
export async function encodeExcel(snapshot: IWorkbookData): Promise<Uint8Array> {
  if (snapshot.sheetOrder.length > EXCEL_LIMITS.sheets) throw new Error('Excel 超过 50 个工作表')
  checkSnapshot(snapshot)
  const workbook = new ExcelJS.Workbook()
  workbook.calcProperties.fullCalcOnLoad = true
  workbook.properties.date1904 = snapshot.dateSystem === (DateSystem.Date1904)
  let count = 0
  for (const id of snapshot.sheetOrder) {
    const sheet = snapshot.sheets[id]
    if (!sheet) throw new Error('工作表快照缺失')
    const output = workbook.addWorksheet(sheet.name || 'Sheet')
    for (const [rowKey, cells] of Object.entries(sheet.cellData || {})) {
      for (const [columnKey, cell] of Object.entries(cells || {}) as [string, ICellData][]) {
        if (!cell) continue
        if (++count > EXCEL_LIMITS.cells) throw new Error('Excel 已用单元格超过 200000')
        if (cell.p || cell.si || cell.custom) throw new Error('编辑产生了不支持的富文本、共享公式或自定义数据')
        if (cell.f && !basicFormula(cell.f)) throw new Error('导出仅支持 SUM/AVERAGE/MIN/MAX/COUNT 和普通引用')
        const target = output.getCell(Number(rowKey) + 1, Number(columnKey) + 1)
        if (cell.f) target.value = { formula: cell.f.replace(/^=/, '') }
        else target.value = cell.v ?? null
        const style = typeof cell.s === 'string' ? snapshot.styles[cell.s] : cell.s
        if (style) target.style = exportStyle(style)
      }
    }
    for (const [row, dimension] of Object.entries(sheet.rowData || {})) if (dimension?.h) output.getRow(Number(row) + 1).height = dimension.h * 3 / 4
    for (const [col, dimension] of Object.entries(sheet.columnData || {})) if (dimension?.w) output.getColumn(Number(col) + 1).width = Math.max(0, (dimension.w - 5) / 7)
    for (const range of sheet.mergeData || []) output.mergeCells(range.startRow + 1, range.startColumn + 1, range.endRow + 1, range.endColumn + 1)
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}
