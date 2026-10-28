import type { IWorkbookData } from '@univerjs/presets'

export const EXCEL_LIMITS = { compressed: 20 * 1024 ** 2, expanded: 100 * 1024 ** 2, part: 32 * 1024 ** 2, entries: 10000, sheets: 50, cells: 200000 }
export interface ExcelDocument {
  snapshot: IWorkbookData
  reasons: string[]
  baseline?: string
}

/** @public @author ddj 2026年10月28号 @param path Candidate path. @returns Only the approved non-macro workbook extension. */
export function isExcelPath(path: unknown): boolean {
  return typeof path === 'string' && /\.xlsx$/i.test(path)
}

/** @public @author ddj 2026年10月28号 @param formula Excel expression. @returns Whether the expression belongs to the deliberately small formula grammar. */
export function basicFormula(formula: string): boolean {
  const source = formula.replace(/^=/, '').trim()
  const reference = /^(?:(?:'[^'\[\]]+'|[\p{L}_][\p{L}\p{N}_ ]*)!)?\$?[A-Z]{1,3}\$?[1-9]\d{0,6}(?::\$?[A-Z]{1,3}\$?[1-9]\d{0,6})?$/iu
  if (reference.test(source)) return validRef(source)
  const call = /^(SUM|AVERAGE|MIN|MAX|COUNT)\((.*)\)$/i.exec(source)
  if (!call) return false
  return call[2].split(',').every((argument) => (reference.test(argument.trim()) && validRef(argument.trim())) || /^-?\d+(?:\.\d+)?$/.test(argument.trim()))
}

/** @public @author ddj 2026年10月28号 @param reference A1 reference, optionally sheet qualified. @returns Coordinates within Excel's physical row/column bounds. */
export function validRef(reference: string): boolean {
  const coordinate = reference.slice(reference.lastIndexOf('!') + 1)
  return coordinate.split(':').every((cell) => {
    const match = /^\$?([A-Z]+)\$?([1-9]\d*)$/i.exec(cell)
    if (!match) return false
    let column = 0
    for (const letter of match[1].toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64
    return column <= 16384 && Number(match[2]) <= 1048576
  })
}
