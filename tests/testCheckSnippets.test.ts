/**
 * 测试验收模式：跨语言上报片段（五语言、行数、路径、hash 口径说明）。
 * @author ddj 2026年11月25号
 */
import { describe, expect, it } from 'vitest'
import { reportSnippets, sheetFileNames, snippetsMarkdown } from '../src/shared/testCheckSnippets.js'

describe('reportSnippets', () => {
  it('覆盖五种语言，顺序固定', () => {
    const snippets = reportSnippets('settings-ui')
    expect(snippets.map((snippet) => snippet.id)).toEqual(['node', 'python', 'bash', 'lua', 'csharp'])
  })

  it('每段 5~10 行，能直接粘进项目', () => {
    for (const snippet of reportSnippets('settings-ui')) {
      const lines = snippet.code.split('\n')
      expect(lines.length, snippet.id + ' 行数').toBeGreaterThanOrEqual(5)
      expect(lines.length, snippet.id + ' 行数').toBeLessThanOrEqual(10)
      expect(snippet.code.trim().length).toBeGreaterThan(0)
    }
  })

  it('每段都写同一个单子的 events 目录', () => {
    for (const snippet of reportSnippets('settings-ui')) {
      expect(snippet.code, snippet.id).toContain('.dsh/test-check/settings-ui')
      expect(snippet.code, snippet.id).toContain('events')
    }
  })

  it('每段都带 item / status / summary 与 evidence（无证据的 pass 不算通过）', () => {
    for (const snippet of reportSnippets('settings-ui')) {
      expect(snippet.code, snippet.id).toContain('item')
      expect(snippet.code, snippet.id).toContain('status')
      expect(snippet.code, snippet.id).toContain('summary')
      expect(snippet.code, snippet.id).toContain('evidence')
    }
  })
})

describe('snippetsMarkdown', () => {
  it('汇总成一份可读文档：标题、必填说明、五段代码、hash 口径', () => {
    const text = snippetsMarkdown('settings-ui', '设置页 · Claude 风格')
    expect(text).toContain('# 验收上报片段 · 设置页 · Claude 风格')
    expect(text).toContain('必填只有 `item` 与 `status`')
    for (const snippet of reportSnippets('settings-ui')) {
      expect(text).toContain('## ' + snippet.label)
      expect(text).toContain('```' + snippet.lang)
    }
    expect(text).toContain('subject.hash')
    expect(text).toContain('sha256:')
  })

  it('没给标题时退回单子 id', () => {
    expect(snippetsMarkdown('settings-ui')).toContain('# 验收上报片段 · settings-ui')
  })
})

describe('sheetFileNames', () => {
  it('定义与片段文件名固定（提示文案与落盘共用）', () => {
    expect(sheetFileNames()).toEqual({ items: 'items.json', snippets: 'snippets.md' })
  })
})
