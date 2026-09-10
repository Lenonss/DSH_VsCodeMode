/**
 * 浮层作用域回归测试（本文件针对一类真实事故：浮层样式整块失效）。
 *
 * 事故回顾：SnippetsPicker 用 createPortal 把浮层挂到 body，但根节点只写了
 * `data-edrv-snippet-picker`；而 editor.css 里浮层样式全部以 `[data-edrv-view]` 为作用域前缀，
 * 于是 24 条规则全部失配 —— 浮层退化为无样式裸流铺在页面底部（不是浮窗）。
 *
 * 两道断言分别守两侧契约：
 * ① 源码侧：凡调用 createPortal 的组件，其 portal 根节点必须携带 data-edrv-view（与
 *    CommandPalette / ContextMenu 一致）；
 * ② 样式侧：editor.css 中的浮层类（.edrv-snip-*）必须以 [data-edrv-view] 限定，
 *    避免出现「写了样式但永远匹配不上」的静默失效。
 * 作者 ddj 2026-09-10
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 递归收集 src/client 下的 .ts/.tsx 源文件。 */
function clientSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name)
    if (name.isDirectory()) clientSources(full, out)
    else if (/\.tsx?$/.test(name.name)) out.push(full)
  }
  return out
}

/** 读取文件（相对包根）。 */
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

describe('portal 根节点作用域（浮层样式失配回归）', () => {
  const files = clientSources(join(ROOT, 'src', 'client'))
  const portalFiles = files.filter((file) => readFileSync(file, 'utf8').includes('createPortal('))

  it('存在调用 createPortal 的组件（防收集失败导致空断言）', () => {
    expect(portalFiles.length).toBeGreaterThanOrEqual(3)
  })

  it('每个 createPortal 的根节点都带 data-edrv-view', () => {
    for (const file of portalFiles) {
      const source = readFileSync(file, 'utf8')
      const rel = file.slice(ROOT.length).replace(/\\/g, '/')
      // 取 createPortal( 到目标容器（document.body）之间的实参文本 = portal 根节点表达式
      const at = source.indexOf('createPortal(')
      const bodyAt = source.indexOf('document.body', at)
      expect(bodyAt, rel + ' 未找到 createPortal(..., document.body)').toBeGreaterThan(at)
      const raw = source.slice(at + 'createPortal('.length, bodyAt).replace(/,\s*$/, '').trim()
      // 根节点可能是内联表达式，也可能是先声明的变量（CommandPalette/ContextMenu 即后者）
      const isIdentifier = /^[A-Za-z_$][\w$]*$/.test(raw)
      const rootArg = isIdentifier
        ? (() => {
            const declAt = source.search(new RegExp('(?:const|let|var)\\s+' + raw + '\\s*='))
            expect(declAt, rel + ' 未能定位根节点变量 ' + raw + ' 的声明').toBeGreaterThanOrEqual(0)
            return source.slice(declAt, declAt + 800)
          })()
        : raw
      expect(rootArg, rel + ' 的 portal 根节点（' + raw + '）缺少 data-edrv-view（浮层样式将整块失配）')
        .toContain("'data-edrv-view'")
    }
  })
})

describe('浮层样式作用域（写了却匹配不上的静默失效回归）', () => {
  const css = read('src/client/styles/editor.css')

  /** 提取某前缀类的全部规则行。 */
  function ruleLines(prefix: string): string[] {
    return css.split('\n').filter((line) => line.includes('.' + prefix) && line.includes('{'))
  }

  it('代码片段浮层类均以 [data-edrv-view] 限定', () => {
    const lines = ruleLines('edrv-snip-')
    expect(lines.length).toBeGreaterThan(0) // 防正则失效导致空断言
    const unscoped = lines.filter((line) => !line.trimStart().startsWith('[data-edrv-view]'))
    expect(unscoped, '以下规则缺少 [data-edrv-view] 限定：\n' + unscoped.join('\n')).toEqual([])
  })

  it('命令栏浮层类均以 [data-edrv-view] 限定（同款契约）', () => {
    const lines = ruleLines('edrv-palette')
    expect(lines.length).toBeGreaterThan(0)
    const unscoped = lines.filter((line) => !line.trimStart().startsWith('[data-edrv-view]'))
    expect(unscoped, '以下规则缺少 [data-edrv-view] 限定：\n' + unscoped.join('\n')).toEqual([])
  })

  it('片段浮窗复用原生模态卡片（不另造视觉）', () => {
    // 卡片尺寸/圆角/阴影来自 mcp.css 的 .vsm-mcp-dialog；本组件须显式依赖它
    expect(read('src/client/ui/SnippetsPicker.ts')).toContain("import '../styles/mcp.css'")
    expect(css).toContain('.edrv-snip-dialog')
    expect(read('src/client/ui/SnippetsPicker.ts')).toContain('vsm-mcp-dialog')
  })
})
