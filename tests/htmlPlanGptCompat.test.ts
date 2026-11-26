/**
 * 弱模型（GPT 系列典型输出）与 HTML 计划模式的兼容回归。
 *
 * 这里锁的是「模型写得差也不会出烂页面」这条契约：正文乱格式仍能排成计划树，
 * 自造样式页 / 假 doc-* 页被判为不可用并由标准页接管，正文里的 HTML 一律转义。
 * @author ddj 2026年11月26号
 */
import { describe, expect, it } from 'vitest'
import { hasPlanRuntime, hasPlanStructure } from '../src/client/htmlPlan/planPage.js'
import { planRuntimeAssets, renderAutoPlanPage } from '../src/planAutoPage.js'

/** GPT 常见写法：标题带编号、主张带句号、决策塞在正文里、列表用 4 空格缩进。 */
const GPT_PLAN = [
  '## 1. 计划：给导出加进度条',
  '',
  '导出 3 万行时会卡住十几秒，用户以为卡死了。',
  '',
  '### 1.1 为什么',
  '',
  '    - 用户反馈「点了没反应」。',
  '',
  '- 导出中途没有进度，只能干等。',
  '',
  '## 2. 导出时显示进度条。',
  '',
  '进度按已写行数算，**不按文件大小**。',
  '',
  '```ts',
  'const percent = Math.round(done / total * 100)',
  '```',
  '',
  '## 3. 进度条可以取消。',
  '',
  '取消后保留已写出的部分，删掉半成品文件。',
  '',
  '## 4. 待决策清单',
  '',
  '1. 进度条位置 | 导出弹窗内 | 页面顶栏',
  '2. 取消后是否保留半成品',
  '',
  '## 5. 不改什么',
  '',
  '- 不改导出的文件格式。',
  '',
].join('\n')

describe('弱模型正文 → 标准计划页', () => {
  it('带编号标题、句号、4 空格列表、混排代码也能排出主张树', async () => {
    const assets = await planRuntimeAssets()
    const html = renderAutoPlanPage(GPT_PLAN, assets)
    expect(html).toContain('<doc-plan>')
    expect(html).toContain('<h1>给导出加进度条</h1>')
    expect(html).toContain('<p>导出时显示进度条。</p>')
    expect(html).toContain('<p>进度条可以取消。</p>')
    expect(html).toContain('<details class="thread"><summary>为什么 · ')
    expect(html).toContain('<doc-ask id="d1" kind="decision">')
    expect(html).toContain('<input type="radio" name="d1" value="导出弹窗内" checked>')
    expect(html).toContain('<doc-claim aux="scope">')
  })

  it('决策项没写选项时给自由填写框，不伪造单选项', async () => {
    const assets = await planRuntimeAssets()
    const html = renderAutoPlanPage(GPT_PLAN, assets)
    expect(html).toContain('<textarea name="d2"')
    expect(html).toMatch(/d1[\s\S]*opts-row[\s\S]*d2[\s\S]*textarea/)
  })

  it('正文里塞的 HTML 只当文本，不注入标签', async () => {
    const assets = await planRuntimeAssets()
    const html = renderAutoPlanPage('# 计划：x\n\n## 主张\n\n<img src=x onerror=alert(1)>', assets)
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})

describe('弱模型自造页面 → 判为不可用', () => {
  it('自带卡片样式的文档页：没有计划结构也没有运行时', () => {
    const page = '<html><head><style>.card{border:1px solid #ddd;border-radius:12px}</style></head>'
      + '<body><h1>计划</h1><div class="card"><h2>新建预制体</h2></div></body></html>'
    expect(hasPlanStructure(page)).toBe(false)
    expect(hasPlanRuntime(page)).toBe(false)
  })

  it('只在脚本里提到 doc-plan 的页面不算计划结构', () => {
    const page = '<script>const tag = "doc-plan"; const claim = "doc-claim";</script><div class="card">x</div>'
    expect(hasPlanStructure(page)).toBe(false)
  })

  it('用了 doc-claim 却没引用运行时：结构有、运行时缺', () => {
    const page = '<main><doc-plan><doc-claim><p>一条主张</p></doc-claim></doc-plan></main>'
    expect(hasPlanStructure(page)).toBe(true)
    expect(hasPlanRuntime(page)).toBe(false)
  })

  it('合规作者页：结构与运行时都在', () => {
    const page = '<link rel="stylesheet" href="runtime/htmlplan.css">'
      + '<main><doc-plan><doc-claim><p>一条主张</p></doc-claim></doc-plan></main>'
    expect(hasPlanStructure(page)).toBe(true)
    expect(hasPlanRuntime(page)).toBe(true)
  })
})
