import { describe, it, expect } from 'vitest'
import { routesUniver, viewerAddress } from '../src/client/univer/routing.js'
import { canImportOffice } from '../src/shared/univer.js'

describe('optional Office routing', () => {
  it('leaves Office defaults unchanged without an available plugin', () => {
    for (const path of ['budget.xlsx', 'report.docx', 'slides.pptx', 'source.ts', 'data.csv']) expect(routesUniver(path)).toBe(false)
    expect(routesUniver('budget.xlsx', { available: false, writable: false })).toBe(false)
    expect(routesUniver('budget.xlsx', { available: true, writable: false })).toBe(true)
  })
  it('never treats a Univer container as text regardless of installation', () => {
    expect(routesUniver('draft.UNIVER')).toBe(true)
    expect(canImportOffice('file.xlsm')).toBe(false)
    expect(canImportOffice('data.tsv')).toBe(true)
  })
  it('accepts only same-origin session-bound Viewer addresses', () => {
    expect(viewerAddress('/univer-viewer/?file=x&sessionId=s', 'http://localhost:3080', 's')).toContain('sessionId=s')
    for (const url of ['https://evil.test/univer-viewer/?sessionId=s', '/univer-viewer/?sessionId=other', '/other?sessionId=s', 'javascript:alert(1)']) {
      expect(() => viewerAddress(url, 'http://localhost:3080', 's')).toThrow('不安全')
    }
  })
})
