import { SaxesParser, type SaxesTagNS } from 'saxes'
import { EXCEL_LIMITS, validRef } from './model.js'

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types'
const TAGS: Record<string, string> = {
  worksheet: '', sheetPr: '', outlinePr: 'summaryBelow summaryRight', pageSetUpPr: '', dimension: 'ref', sheetViews: '', sheetView: 'workbookViewId tabSelected showGridLines zoomScale zoomScaleNormal', selection: 'activeCell sqref', sheetFormatPr: 'defaultRowHeight baseColWidth defaultColWidth dyDescent',
  cols: '', col: 'min max width customWidth', sheetData: '', row: 'r spans ht customHeight dyDescent', c: 'r s t', v: '', f: '', is: '', t: 'space', mergeCells: 'count', mergeCell: 'ref', pageMargins: 'left right top bottom header footer',
  workbook: '', fileVersion: 'appName lastEdited lowestEdited rupBuild', workbookPr: 'date1904 defaultThemeVersion filterPrivacy', bookViews: '', workbookView: 'xWindow yWindow windowWidth windowHeight activeTab firstSheet', sheets: '', sheet: 'name sheetId id', calcPr: 'calcId fullCalcOnLoad forceFullCalc calcMode',
  sst: 'count uniqueCount', si: '', styleSheet: '', numFmts: 'count', numFmt: 'numFmtId formatCode', fonts: 'count', font: '', name: 'val', sz: 'val', family: 'val', scheme: 'val', charset: 'val', b: 'val', i: 'val', u: 'val', strike: 'val', color: 'rgb theme indexed auto', fills: 'count', fill: '', patternFill: 'patternType', fgColor: 'rgb theme indexed auto', bgColor: 'rgb theme indexed auto', borders: 'count', border: '', left: 'style', right: 'style', top: 'style', bottom: 'style', diagonal: '', cellStyleXfs: 'count', cellXfs: 'count', xf: 'numFmtId fontId fillId borderId xfId applyAlignment applyNumberFormat applyBorder applyFill applyFont', alignment: 'horizontal vertical wrapText', cellStyles: 'count', cellStyle: 'name xfId builtinId', dxfs: 'count', tableStyles: 'count defaultTableStyle defaultPivotStyle',
}
const EMPTY_STYLES = '<extLst><ext uri="{EB79DEF2-80B8-43e5-95BD-54CBDDF9020C}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:slicerStyles defaultSlicerStyle="SlicerStyleLight1"/></ext><ext uri="{9260A510-F301-46a8-8635-F512D64BE5F5}" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main"><x15:timelineStyles defaultTimelineStyle="TimeSlicerStyleLight1"/></ext></extLst>'

/** @public @author ddj 2026年10月28号 @param part Original part path. @param xml Original XML. @returns Only the exact empty ExcelJS default style extension is ignored; populated/unknown extensions remain gated. */
export function basicXml(part: string, xml: string): string {
  return part === 'xl/styles.xml' ? xml.replace(EMPTY_STYLES, '') : xml
}

const CONTENTS = new Set([
  'application/vnd.openxmlformats-package.relationships+xml', 'application/xml',
  'application/vnd.openxmlformats-package.core-properties+xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
  'application/vnd.openxmlformats-officedocument.theme+xml',
])

/** @public @author ddj 2026年10月28号 @param xml Original XML. @param visit Namespace-aware opening-tag inspection. @sideEffects Throws on malformed XML, DTD or entity declarations. */
export function parseXml(xml: string, visit: (tag: SaxesTagNS, parent?: string) => void): void {
  const parser = new SaxesParser({ xmlns: true })
  parser.on('doctype', () => { throw new Error('Excel XML 禁止 DTD/实体声明') })
  parser.on('error', (error) => { throw error })
  const stack: string[] = []
  parser.on('opentag', (tag) => { visit(tag, stack.at(-1)); stack.push(tag.local) })
  parser.on('closetag', () => { stack.pop() })
  parser.write(xml).close()
}

/** @public @author ddj 2026年10月28号 @param parts Preinflated original parts. @returns Fail-closed reasons and pre-parse budget validation. */
export function xmlGate(parts: Map<string, string>): string[] {
  const reasons = new Set<string>()
  let sheets = 0
  let cells = 0
  let mergeCells = 0
  for (const [part, xml] of parts) {
    if (!part.endsWith('.xml') && !part.endsWith('.rels')) continue
    const spreadsheet = /^xl\/(?:workbook|styles|sharedStrings|worksheets\/sheet\d+)\.xml$/.test(part)
    const roots = { 'xl/workbook.xml': 'workbook', 'xl/styles.xml': 'styleSheet', 'xl/sharedStrings.xml': 'sst' }
    const expected = roots[part as keyof typeof roots] || 'worksheet'
    const singleton = new Set<string>()
    parseXml(basicXml(part, xml), (tag, parent) => {
      if (part.endsWith('.rels')) { checkRelation(tag, part, parts, reasons); return }
      if (part === '[Content_Types].xml') { checkType(tag, parts, reasons); return }
      if (!spreadsheet) return
      if (tag.local === 'pageSetup' && tag.uri === MAIN && parent === 'worksheet' && defaultPage(tag)) return
      if (tag.uri !== MAIN || !(tag.local in TAGS)) { reasons.add('不支持的 XML 元素：' + part + ':' + tag.name); return }
      if (!parent && tag.local !== expected) throw new Error('Excel XML 根元素错误：' + part)
      // Differential styles are valid OOXML but still trigger read-only via the unsupported dxf tag.
      // Their shared children must not turn a safe preview into a malformed-document error.
      const parents: Record<string, string> = { c: 'row', row: 'sheetData', v: 'c', f: 'c', sheet: 'sheets', mergeCell: 'mergeCells', col: 'cols', si: 'sst', numFmt: 'numFmts dxf', xf: 'cellXfs cellStyleXfs', font: 'fonts dxf', fill: 'fills dxf', border: 'borders dxf' }
      if (parents[tag.local] && !parents[tag.local].split(' ').includes(parent || '')) throw new Error('Excel XML 元素层级错误：' + tag.name)
      if (['sheetData', 'sheets', 'cellXfs', 'styles', 'mergeCells'].includes(tag.local)) {
        if (singleton.has(tag.local)) throw new Error('Excel XML 重复关键元素：' + tag.name)
        singleton.add(tag.local)
      }
      const allowed = TAGS[tag.local].split(' ')
      for (const attribute of Object.values(tag.attributes)) {
        if (attribute.uri === 'http://www.w3.org/2000/xmlns/' || defaultAttr(tag, attribute.local, attribute.uri, attribute.value)) continue
        const qualified = !attribute.uri || (attribute.local === 'id' && attribute.uri === OFFICE.slice(0, -1)) || (attribute.local === 'space' && attribute.uri === 'http://www.w3.org/XML/1998/namespace') || (attribute.local === 'dyDescent' && attribute.uri === 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac')
        if (!qualified || !allowed.includes(attribute.local)) reasons.add('不支持的 XML 属性：' + part + ':' + tag.name + '.' + attribute.name)
      }
      if (tag.local === 'sheet' && ++sheets > EXCEL_LIMITS.sheets) throw new Error('Excel 超过 50 个工作表')
      if (tag.local === 'c' && ++cells > EXCEL_LIMITS.cells) throw new Error('Excel 已用单元格超过 200000')
      mergeCells += checkRanges(tag)
      if (mergeCells > EXCEL_LIMITS.cells) throw new Error('Excel 累计合并范围超过 200000 单元格')
      if (tag.local === 'sheet' && attribute(tag, 'state') && attribute(tag, 'state') !== 'visible') reasons.add('隐藏工作表')
      if (tag.local === 'alignment' && ['fill', 'centerContinuous'].includes(attribute(tag, 'horizontal'))) reasons.add('不支持的填充/跨列居中对齐')
      if (tag.local === 'u' && attribute(tag, 'val') && attribute(tag, 'val') !== 'single') reasons.add('不支持的双下划线/会计下划线')
      if (tag.local === 'patternFill' && !['none', 'solid', 'gray125'].includes(attribute(tag, 'patternType'))) reasons.add('复杂图案填充')
      if (tag.local === 'xf' && Object.values(tag.attributes).some((entry) => entry.local === 'applyProtection')) reasons.add('样式保护')
    })
  }
  return [...reasons]
}

/** @private @author ddj 2026年10月28号 @param tag Node. @param name Attribute. @param uri Attribute namespace. @param value Attribute value. @returns Whether exact inert generator metadata is safe to ignore. */
function defaultAttr(tag: SaxesTagNS, name: string, uri: string, value: string): boolean {
  if (uri === 'http://schemas.openxmlformats.org/markup-compatibility/2006' && name === 'Ignorable') {
    const expected: Record<string, string> = { worksheet: 'x14ac', workbook: 'x15', styleSheet: 'x14ac x16r2' }
    return value === expected[tag.local]
  }
  if (uri === 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac' && tag.local === 'fonts' && name === 'knownFonts') return value === '1'
  if (uri) return false
  if (tag.local === 'sheet' && name === 'state') return value === 'visible'
  return tag.local === 'sheetFormatPr' && ['outlineLevelRow', 'outlineLevelCol'].includes(name) && value === '0'
}

/** @private @author ddj 2026年10月28号 @param tag Page setup node. @returns Exact default print settings only; any actual custom print settings remain read-only. */
function defaultPage(tag: SaxesTagNS): boolean {
  const defaults: Record<string, string> = { orientation: 'portrait', horizontalDpi: '4294967295', verticalDpi: '4294967295', scale: '100', fitToWidth: '1', fitToHeight: '1' }
  return Object.values(tag.attributes).every((entry) => !entry.uri && defaults[entry.local] === entry.value)
}

/** @private @author ddj 2026年10月28号 @param tag Parsed node. @param name Local attribute name. @returns Decoded attribute without regex/entity ambiguities. */
function attribute(tag: SaxesTagNS, name: string): string {
  return Object.values(tag.attributes).find((entry) => entry.local === name)?.value || ''
}

/** @private @author ddj 2026年10月28号 @param tag Node. @sideEffects Rejects sparse extreme coordinates and huge merge allocations before ExcelJS sees them. */
function checkRanges(tag: SaxesTagNS): number {
  if (tag.local === 'c' && !validRef(attribute(tag, 'r'))) throw new Error('Excel 单元格坐标越界')
  if (tag.local === 'row' && (!/^\d+$/.test(attribute(tag, 'r')) || Number(attribute(tag, 'r')) > 1048576)) throw new Error('Excel 行坐标越界')
  if (tag.local === 'col' && (Number(attribute(tag, 'max')) > 16384 || Number(attribute(tag, 'min')) < 1)) throw new Error('Excel 列坐标越界')
  if (!['dimension', 'mergeCell'].includes(tag.local)) return 0
  const range = attribute(tag, 'ref')
  if (!validRef(range)) throw new Error('Excel 范围越界')
  if (tag.local !== 'mergeCell') return 0
  const positions = range.split(':').map((cell) => {
    const match = /^([A-Z]+)(\d+)$/i.exec(cell)!
    let column = 0
    for (const letter of match[1].toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64
    return { row: Number(match[2]), column }
  })
  const end = positions[1] || positions[0]
  const area = (Math.abs(end.row - positions[0].row) + 1) * (Math.abs(end.column - positions[0].column) + 1)
  if (area > EXCEL_LIMITS.cells) throw new Error('Excel 合并范围超过 200000 单元格')
  return area
}

/** @private @author ddj 2026年10月28号 @param tag Node. @param part Relationship part. @param parts All original entries. @param reasons Refusal set. @sideEffects Validates complete relationship URIs and normalized targets against the archive. */
function checkRelation(tag: SaxesTagNS, part: string, parts: Map<string, string>, reasons: Set<string>): void {
  if (tag.uri !== REL || !['Relationships', 'Relationship'].includes(tag.local)) { reasons.add('未知关系命名空间/元素：' + part); return }
  if (tag.local !== 'Relationship') return
  for (const field of Object.values(tag.attributes)) {
    if (field.uri === 'http://www.w3.org/2000/xmlns/') continue
    if (field.uri || !['Id', 'Type', 'Target', 'TargetMode'].includes(field.local)) reasons.add('未知关系属性：' + field.name)
  }
  const type = attribute(tag, 'Type')
  const accepted = ['officeDocument', 'worksheet', 'styles', 'sharedStrings', 'theme', 'extended-properties'].map((suffix) => OFFICE + suffix)
  accepted.push('http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties')
  const target = attribute(tag, 'Target')
  const base = part === '_rels/.rels' ? '' : part.slice(0, part.indexOf('/_rels/')) + '/'
  const resolved: string[] = []
  for (const segment of (target.startsWith('/') ? target.slice(1) : base + target).split('/')) {
    if (segment === '..') { if (!resolved.length) throw new Error('Excel 关系路径越界'); resolved.pop() }
    else if (segment !== '.' && segment) resolved.push(segment)
  }
  const role = type.slice(type.lastIndexOf('/') + 1)
  const targetPart = resolved.join('/')
  const targets: Record<string, RegExp> = { officeDocument: /^xl\/workbook\.xml$/, worksheet: /^xl\/worksheets\/sheet\d+\.xml$/, styles: /^xl\/styles\.xml$/, sharedStrings: /^xl\/sharedStrings\.xml$/, theme: /^xl\/theme\/theme\d+\.xml$/, 'core-properties': /^docProps\/core\.xml$/, 'extended-properties': /^docProps\/app\.xml$/ }
  const sourceValid = part === '_rels/.rels' ? ['officeDocument', 'core-properties', 'extended-properties'].includes(role) : part === 'xl/_rels/workbook.xml.rels' && ['worksheet', 'styles', 'sharedStrings', 'theme'].includes(role)
  if (!sourceValid || !targets[role]?.test(targetPart)) reasons.add('关系类型与来源/目标不匹配：' + part + ':' + target)
  if (!accepted.includes(type) || attribute(tag, 'TargetMode') || /[\\:%?#]/.test(target) || !parts.has(resolved.join('/'))) reasons.add('外部、未知或无效目标关系：' + part + ':' + target)
}

/** @private @author ddj 2026年10月28号 @param tag Node. @param reasons Refusal set. @sideEffects Refuses content types outside basic OOXML. */
function checkType(tag: SaxesTagNS, parts: Map<string, string>, reasons: Set<string>): void {
  if (tag.uri !== TYPES || !['Types', 'Default', 'Override'].includes(tag.local)) { reasons.add('未知 Content_Types 命名空间/元素'); return }
  for (const field of Object.values(tag.attributes)) {
    if (field.uri === 'http://www.w3.org/2000/xmlns/') continue
    if (field.uri || !['PartName', 'Extension', 'ContentType'].includes(field.local)) reasons.add('未知内容类型属性：' + field.name)
  }
  // ExcelJS emits an unused VML default even without a VML part; never accept an actual drawing.
  if (tag.local === 'Default' && attribute(tag, 'Extension') === 'vml' && attribute(tag, 'ContentType') === 'application/vnd.openxmlformats-officedocument.vmlDrawing' && ![...parts.keys()].some((part) => /\.vml$/i.test(part))) return
  const name = attribute(tag, 'PartName')
  if (tag.local === 'Override' && (!name.startsWith('/') || !parts.has(name.slice(1)))) reasons.add('内容类型目标不存在：' + name)
  if (tag.local === 'Default' && !['rels', 'xml'].includes(attribute(tag, 'Extension'))) reasons.add('未知默认内容扩展')
  if (tag.local !== 'Types' && !CONTENTS.has(attribute(tag, 'ContentType'))) reasons.add('不支持的内容类型：' + attribute(tag, 'ContentType'))
}
