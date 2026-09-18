/**
 * Markdown 文件判定单测：扩展名识别与边界（.mdx 明确排除）。
 * 断言使用字符串字面量，不依赖 path.join。
 * 作者 ddj 2026年09月18号
 */
import { describe, expect, it } from 'vitest'
import { isMarkdownPath } from '../src/client/markdownPreview.js'

describe('isMarkdownPath', () => {
  it('识别 .md 与 .markdown（大小写不敏感）', () => {
    expect(isMarkdownPath('README.md')).toBe(true)
    expect(isMarkdownPath('docs/guide.MARKDOWN')).toBe(true)
    expect(isMarkdownPath('a/b/c.Md')).toBe(true)
  })

  it('兼容反斜杠分隔的 Windows 路径', () => {
    expect(isMarkdownPath('C:\\proj\\docs\\README.MD')).toBe(true)
  })

  it('排除 .mdx（渲染器只走 GFM，JSX 会被当字面文本，预览反而误导）', () => {
    expect(isMarkdownPath('page.mdx')).toBe(false)
  })

  it('排除其它扩展名与无扩展名路径', () => {
    expect(isMarkdownPath('main.ts')).toBe(false)
    expect(isMarkdownPath('notes.mdown')).toBe(false)
    expect(isMarkdownPath('README.md.bak')).toBe(false)
    expect(isMarkdownPath('md')).toBe(false)
    expect(isMarkdownPath('.md')).toBe(false)
    expect(isMarkdownPath('')).toBe(false)
  })
})
