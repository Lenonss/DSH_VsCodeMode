/**
 * HTML 计划模式兜底页测试：Markdown 子集渲染、页面外壳、运行时资产与体积上限。
 * @author ddj 2026年11月25号
 */
import { describe, expect, it } from 'vitest'
import {
  AUTO_PAGE_MARKDOWN_CAP,
  planRuntimeAssets,
  renderAutoPlanPage,
  renderInline,
  renderPlanMarkdown,
} from '../src/planAutoPage.js'

const ASSETS = { css: 'body{color:#111}', js: 'console.log("htmlplan")' }

describe('renderInline', () => {
  it('转义 HTML，并渲染行内代码、粗体、斜体与 http 链接', () => {
    expect(renderInline('a < b & c')).toBe('a &lt; b &amp; c')
    expect(renderInline('`x<y`')).toBe('<code>x&lt;y</code>')
    expect(renderInline('**粗** 与 *斜*')).toBe('<strong>粗</strong> 与 <em>斜</em>')
    expect(renderInline('[文档](https://example.com/x)')).toBe('<a href="https://example.com/x" rel="noreferrer noopener">文档</a>')
  })

  it('非 http 链接保留为纯文本，不生成可点击地址', () => {
    expect(renderInline('[本地](../secret.md)')).toBe('[本地](../secret.md)')
  })
})

describe('renderPlanMarkdown', () => {
  it('首个标题作 title，其余标题改 h2/h3，并剥掉页面标记行', () => {
    const markdown = [
      '# 计划：加个模式',
      '',
      'HTML 计划页：plans/x/plan.packed.html',
      '',
      '## 目标',
      '一句正文。',
      '',
      '### 细节',
      '- 第一项',
      '- 第二项',
    ].join('\n')
    const { title, body } = renderPlanMarkdown(markdown)
    expect(title).toBe('计划：加个模式')
    expect(body).toContain('<h2>目标</h2>')
    expect(body).toContain('<h3>细节</h3>')
    expect(body).toContain('<ul><li>第一项</li><li>第二项</li></ul>')
    expect(body).not.toContain('HTML 计划页')
  })

  it('围栏代码原样转义，表格生成 thead/tbody', () => {
    const markdown = [
      '# 标题',
      '',
      '```ts',
      'const a = "<b>"',
      '```',
      '',
      '| 名称 | 值 |',
      '| --- | --- |',
      '| a | 1 |',
    ].join('\n')
    const { body } = renderPlanMarkdown(markdown)
    expect(body).toContain('<pre><code class="language-ts">const a = &quot;&lt;b&gt;&quot;</code></pre>')
    expect(body).toContain('<thead><tr><th>名称</th><th>值</th></tr></thead>')
    expect(body).toContain('<tbody><tr><td>a</td><td>1</td></tr></tbody>')
  })

  it('没有标题时用默认名；引用与分隔线也能渲染', () => {
    expect(renderPlanMarkdown('> 引用一段\n\n---').title).toBe('计划')
    const { body } = renderPlanMarkdown('> 引用一段\n\n---')
    expect(body).toContain('<blockquote>引用一段</blockquote>')
    expect(body).toContain('<hr>')
  })
})

describe('renderAutoPlanPage', () => {
  it('输出 packed 外壳：内联样式与脚本、关闭 Respond 条、无外部运行时引用', () => {
    const html = renderAutoPlanPage('# 计划：测试\n\n## 小节\n正文', ASSETS)
    expect(html).toContain('data-htmlplan-packed')
    expect(html).toContain('<style data-htmlplan>')
    expect(html).toContain('body{color:#111}')
    expect(html).toContain('<script data-htmlplan>')
    expect(html).toContain('console.log("htmlplan")')
    expect(html).toContain('data-feedback="off"')
    expect(html).toContain('<title>计划：测试</title>')
    expect(html).not.toContain('runtime/htmlplan.css')
    expect(html).not.toContain('runtime/htmlplan.js')
  })

  it('脚本里的 </script 被转义，避免截断页面', () => {
    const html = renderAutoPlanPage('# x', { css: '', js: 'const a = "</script>"' })
    expect(html).toContain('<\\/script>')
  })

  it('超过上限直接报错', () => {
    expect(() => renderAutoPlanPage('x'.repeat(AUTO_PAGE_MARKDOWN_CAP + 1), ASSETS)).toThrow(/上限/)
  })
})

describe('planRuntimeAssets', () => {
  it('能读到技能自带的样式与脚本（随包资产在位）', async () => {
    const assets = await planRuntimeAssets()
    expect(assets.css).toContain('.nw-')
    expect(assets.js).toContain('HtmlPlan')
  })
})
