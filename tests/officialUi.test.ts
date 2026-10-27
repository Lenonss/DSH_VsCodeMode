import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DiffBox } from '../src/client/ui/DiffBox.js'
import { DiffLauncher } from '../src/client/ui/DiffLauncher.js'
vi.mock('../src/client/rpc.js', () => ({ rpc: vi.fn() }))

describe('official review in existing UI', () => {
  it('existing file dock gates legacy write controls and opens the embedded patch browser', () => {
    const html = renderToStaticMarkup(React.createElement(DiffBox, {
      official: { sessionId: 'view', path: '/a.lua', pending: 2, page: null }, activePath: '/a.lua', fileTotal: 1,
      pendingRegions: [{ callId: 'legacy', idx: 0 }], allPendingCount: 2,
    }))
    expect(html).toContain('data-edrv-diff-source="official"')
    expect(html).toContain('2 条官方待审记录')
    expect(html).toContain('查看差异 / 标记已审')
    expect(html).toMatch(/disabled=""[^>]*>Undo 不可用/)
    expect(html).not.toContain('Keep All')
    expect(html).not.toContain('data-edrv-hunk')
  })
  it('existing launcher defaults to official history and keeps the old records behind an explicit source switch', () => {
    const html = renderToStaticMarkup(React.createElement(DiffLauncher, {
      sessionId: 'view', sum: { files: [], pendingFiles: [], totalFiles: 0 }, tab: 'archive',
    }))
    expect(html).toContain('data-edrv-launch="1"')
    expect(html).toContain('官方净差异')
    expect(html).toContain('旧工具记录')
    expect(html).toContain('原始历史只读')
    expect(html).not.toContain('官方历史审查 ·')
    expect(html).not.toContain('将文件恢复到批次')
  })
})
