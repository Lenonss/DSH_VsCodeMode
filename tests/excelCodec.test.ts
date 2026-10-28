import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { zipSync, strToU8 } from 'fflate/browser'
import { decodeExcel, encodeExcel, inspectZip, rawGate } from '../src/client/excel/codec.js'
import { basicFormula, isExcelPath } from '../src/client/excel/model.js'
import { xmlGate } from '../src/client/excel/xmlGate.js'

/** @private @author ddj 2026年10月28号 @returns In-memory basic fixture; no workspace or original-file writes. */
async function fixture() {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('基础')
  sheet.getCell('A1').value = '中文 = text'
  sheet.getCell('B1').value = 12.5
  sheet.getCell('C1').value = true
  sheet.getCell('D1').value = new Date('2026-10-28T00:00:00Z')
  sheet.getCell('D1').numFmt = 'yyyy-mm-dd'
  sheet.getCell('A2').value = { formula: 'SUM(B1:B1)', result: 12.5 }
  sheet.getCell('A1').font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FF123456' } }
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFABCDEF' } }
  sheet.getCell('A1').border = { bottom: { style: 'double', color: { argb: 'FF000000' } } }
  sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
  sheet.getRow(1).height = 25
  sheet.getColumn(1).width = 24
  sheet.mergeCells('A3:B3')
  workbook.addWorksheet('Second').getCell('A1').value = 'two'
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

describe('Excel basic codec', () => {
  it('only converts xlsx, never xls/xlsm/xlsb', () => {
    expect(isExcelPath('A.XLSX')).toBe(true)
    for (const path of ['a.xls', 'a.xlsm', 'a.xlsb']) expect(isExcelPath(path)).toBe(false)
  })
  it('uses a small fail-closed formula grammar and real bounds', () => {
    for (const formula of ['SUM(A1:B2)', '=AVERAGE(A1,2)', 'MIN(A1)', 'MAX(A1)', 'COUNT(A1)', "'数据'!$A$1", 'XFD1048576']) expect(basicFormula(formula), formula).toBe(true)
    for (const formula of ['SUM()', 'SUM(A1,)', 'IF(A1,1,0)', 'A1+B1', '[1]Sheet!A1', 'NamedRange', 'XFE1', 'A1048577', "'O''Brien'!A1"]) expect(basicFormula(formula), formula).toBe(false)
  })
  it('roundtrips multi-sheet scalars, formula, date, basic style and merge', async () => {
    const decoded = await decodeExcel(await fixture())
    expect(decoded.reasons).toEqual([])
    expect(decoded.snapshot.sheetOrder).toHaveLength(2)
    const bytes = await encodeExcel(decoded.snapshot)
    const output = new ExcelJS.Workbook()
    await output.xlsx.load(bytes as never)
    const sheet = output.worksheets[0]
    expect(sheet.getCell('A1').value).toBe('中文 = text')
    expect(sheet.getCell('B1').value).toBe(12.5)
    expect(sheet.getCell('C1').value).toBe(true)
    expect(sheet.getCell('D1').value).toEqual(new Date('2026-10-28T00:00:00Z'))
    expect(sheet.getCell('A2').formula).toBe('SUM(B1:B1)')
    expect(sheet.getCell('A1').font.bold).toBe(true)
    expect(sheet.getCell('A1').border.bottom?.style).toBe('double')
    expect(sheet.getCell('A1').alignment.horizontal).toBe('center')
    expect(sheet.model.merges).toContain('A3:B3')
    expect(sheet.getRow(1).height).toBe(25)
    expect(sheet.getColumn(1).width).toBe(24)
  })
  it('detects unknown parts, protection, formula and external relationships', () => {
    const parts = new Map([
      ['xl/charts/chart1.xml', '<chart/>'],
      ['xl/worksheets/sheet1.xml', '<worksheet><sheetProtection/><f>IF(A1,1,0)</f></worksheet>'],
      ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Type="evil" TargetMode="External"/></Relationships>'],
    ])
    expect(rawGate(parts).length).toBeGreaterThanOrEqual(3)
  })
  it('accepts only exact empty generator metadata, never populated extensions or custom print settings', async () => {
    const parts = inspectZip(await fixture())
    expect(xmlGate(parts)).toEqual([])
    expect(rawGate(parts)).toEqual([])
    const styles = parts.get('xl/styles.xml')!
    parts.set('xl/styles.xml', styles.replace('defaultSlicerStyle="SlicerStyleLight1"/>', 'defaultSlicerStyle="SlicerStyleLight1"><x14:slicerStyle name="Custom"/></x14:slicerStyles>'))
    expect(xmlGate(parts).length).toBeGreaterThan(0)
    expect(rawGate(parts).length).toBeGreaterThan(0)
    parts.set('xl/styles.xml', styles)
    parts.set('xl/worksheets/sheet1.xml', parts.get('xl/worksheets/sheet1.xml')!.replace('scale="100"', 'scale="90"'))
    expect(xmlGate(parts).length).toBeGreaterThan(0)
    parts.set('xl/workbook.xml', parts.get('xl/workbook.xml')!.replace('state="visible"', 'state="hidden"'))
    expect(xmlGate(parts)).toContain('隐藏工作表')
  })
  it('previews valid differential styles without treating their children as malformed XML', async () => {
    const parts = inspectZip(await fixture())
    const differential = '<dxfs count="1"><dxf><font><b val="1"/></font><fill><patternFill patternType="solid"><fgColor rgb="FFABCDEF"/></patternFill></fill><border><bottom style="thin"/></border><numFmt numFmtId="164" formatCode="0.00"/></dxf></dxfs>'
    parts.set('xl/styles.xml', parts.get('xl/styles.xml')!.replace(/<dxfs\b[^>]*\/>|<dxfs\b[^>]*>[\s\S]*?<\/dxfs>/, differential))

    expect(xmlGate(parts)).toContain('不支持的 XML 元素：xl/styles.xml:dxf')
    const archive = Object.fromEntries([...parts].map(([part, xml]) => [part, strToU8(xml)]))
    const decoded = await decodeExcel(zipSync(archive))
    expect(decoded.reasons).toContain('不支持的 XML 元素：xl/styles.xml:dxf')
    expect(decoded.snapshot.sheets[decoded.snapshot.sheetOrder[0]].cellData![0][0].v).toBe('中文 = text')
  })
  it.each(['fill', 'font', 'border', 'numFmt'])('still rejects a misplaced %s outside style containers', (element) => {
    const xml = `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><${element}/></styleSheet>`
    expect(() => xmlGate(new Map([['xl/styles.xml', xml]]))).toThrow('Excel XML 元素层级错误：' + element)
  })
  it('rejects unsupported user edits and huge merges before ExcelJS allocations', async () => {
    const decoded = await decodeExcel(await fixture())
    const sheet = decoded.snapshot.sheets[decoded.snapshot.sheetOrder[0]]
    sheet.hidden = 1
    await expect(encodeExcel(decoded.snapshot)).rejects.toThrow('隐藏工作表')
    sheet.hidden = 0
    sheet.rowData = { 0: { hd: 1 } }
    await expect(encodeExcel(decoded.snapshot)).rejects.toThrow('行列编辑字段')
    sheet.rowData = {}
    sheet.freeze = { xSplit: 1, ySplit: 0, startRow: -1, startColumn: 0 }
    await expect(encodeExcel(decoded.snapshot)).rejects.toThrow('冻结窗格')
    delete sheet.freeze
    sheet.mergeData = [{ startRow: 0, endRow: 1048575, startColumn: 0, endColumn: 16383 }]
    await expect(encodeExcel(decoded.snapshot)).rejects.toThrow('累计合并范围')
    sheet.mergeData = []
    sheet.cellData = { '-1': { 0: { v: 1 } } }
    await expect(encodeExcel(decoded.snapshot)).rejects.toThrow('坐标越界')
  })
  it('exports the real Univer save shape after an A1 text edit without losing styles', async () => {
    const decoded = await decodeExcel(await fixture())
    const snapshot = decoded.snapshot
    snapshot.styles._8TFxe = {
      ff: 'Arial', fs: 12, bl: 1, it: 0, cl: { rgb: '#123456' },
      ul: { s: 0, cl: { rgb: '#123456' } }, st: { s: 0, cl: { rgb: '#123456' } },
      n: { pattern: 'General' }, bg: { rgb: '#ABCDEF' }, ht: 2, vt: 2, tb: 3,
      bd: { b: { s: 7, cl: { rgb: '#000000' } } },
    }
    snapshot.sheets[snapshot.sheetOrder[0]].cellData![0][0] = { s: '_8TFxe', v: 'Excel现场编辑', t: 4 }
    const output = new ExcelJS.Workbook()
    await output.xlsx.load(await encodeExcel(snapshot) as never)
    const cell = output.worksheets[0].getCell('A1')
    expect(cell.value).toBe('Excel现场编辑')
    expect(cell.font.bold).toBe(true)
    expect(cell.font.color?.argb).toBe('FF123456')
    expect(cell.font.underline).toBeFalsy()
    expect(cell.font.strike).toBeFalsy()
    expect(cell.border.bottom?.style).toBe('double')
    expect(cell.alignment.horizontal).toBe('center')
  })
  it.each([
    { ul: { s: 2 } }, { st: { s: 2 } }, { ht: 5 }, { vt: 4 }, { tb: 2 },
    { bd: { b: { s: 99 } } }, { cl: { rgb: '#FF000080' } }, { cl: { rgb: '#112233', theme: 1 } },
    { ul: { s: 1, color: '#112233' } }, { ul: { s: 1, cl: { rgb: '#112233' } } },
    { ul: { s: 0, cl: { rgb: '#112233', th: 1 } } }, { st: { s: 0, cl: { rgb: 'invalid' } } },
  ])('rejects unsupported nested style values: %j', async (style) => {
    const decoded = await decodeExcel(await fixture())
    const sheet = decoded.snapshot.sheets[decoded.snapshot.sheetOrder[0]]
    sheet.cellData = { 0: { 0: { v: 'styled', s: style as never } } }
    await expect(encodeExcel(decoded.snapshot)).rejects.toThrow()
  })
  it('rejects malformed/encrypted/archive budget and CRC corruption', async () => {
    expect(() => inspectZip(new Uint8Array(21 * 1024 * 1024))).toThrow('20MiB')
    expect(() => inspectZip(new Uint8Array([1, 2, 3]))).toThrow('加密')
    const parts = { '[Content_Types].xml': strToU8('<Types/>'), 'xl/workbook.xml': strToU8('<workbook/>') }
    const bytes = zipSync(parts, { level: 0 })
    bytes[60] ^= 1
    expect(() => inspectZip(bytes)).toThrow()
    const bomb = zipSync({ 'xl/workbook.xml': new Uint8Array(33 * 1024 * 1024) })
    expect(() => inspectZip(bomb)).toThrow('超限')
  })
  it('namespace-aware gate rejects hidden/freeze/custom/unsafe structures before parsing', () => {
    const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    const parts = new Map([['xl/worksheets/sheet1.xml', `<worksheet xmlns="${ns}"><pane state="frozen"/><sheetData><row r="1" hidden="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`]])
    expect(xmlGate(parts).length).toBeGreaterThan(0)
    parts.set('xl/worksheets/sheet1.xml', `<worksheet xmlns="${ns}"><mergeCells><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>`)
    expect(() => xmlGate(parts)).toThrow('合并范围')
    parts.set('xl/worksheets/sheet1.xml', '<!DOCTYPE test [<!ENTITY x "test">]><worksheet/>')
    expect(() => xmlGate(parts)).toThrow('DTD')
  })
})
