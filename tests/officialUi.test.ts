import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DiffBox } from '../src/client/ui/DiffBox.js'
import { DiffLauncher } from '../src/client/ui/DiffLauncher.js'
vi.mock('../src/client/rpc.js', () => ({ rpc: vi.fn() }))
// Runtime primitives are host-provided externals, not a standalone npm React tree.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ variant, size, icon, children, ...props }: any) => React.createElement('button', props, icon, children),
  Menu: ({ anchor }: any) => anchor,
}))

describe('official review in existing UI', () => {
  it('existing file dock gates legacy write controls and opens the embedded patch browser', () => {
    const html = renderToStaticMarkup(React.createElement(DiffBox, {
      official: { sessionId: 'view', path: '/a.lua', pending: 2, page: null }, activePath: '/a.lua', fileTotal: 1,
      pendingRegions: [{ callId: 'legacy', idx: 0 }], allPendingCount: 2,
      reviewError: '当前文件与可信快照不匹配',
    }))
    expect(html).toContain('data-edrv-diff-source="official"')
    expect(html).toContain('2 条官方待审记录')
    expect(html).toContain('展开差异')
    expect(html).toContain('当前文件与可信快照不匹配')
    expect(html).toContain('role="alert"')
    expect(html).toContain('>Keep</button>')
    expect(html).toMatch(/class="[^"]*edrv-review-undo[^"]*"[^>]*disabled=""/)
    expect(html).toContain('aria-label="文件差异审查"')
    expect(html).toContain('aria-label="选择官方差异记录"')
    expect(html).not.toContain('<select')
    expect(html).not.toContain('edrv-pill-keep')
    expect(html).toContain('Keep All')
    expect(html).toContain('Undo All')
    expect(html).toContain('aria-label="全部待审文件"')
    expect(html).toContain('差异文件')
    expect(html).toContain('0 / 1')
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
