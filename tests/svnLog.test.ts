/**
 * P3 解析与 handler 契约测试：`svn log --xml -v` 解析、仓库路径映射、update 条目级解析、
 * 以及 svn.log / svn.diffRev / svn.cleanup 的 argv 形态与业务分支。
 *
 * 关键实测约束（来自 svn 1.14.5 真机探查，均有断言守护）：
 * - `svn log` 默认范围是 BASE:1 → handler **必须**显式传 `-r HEAD:1`，否则日志近乎空白
 * - `svn log --xml` 的 path 是仓库绝对路径（/trunk/...）→ 需按 relative-url 剥前缀
 * - `svn cat -r <REV-1>` 对新增文件报 E195012 → 左侧返回 null（业务分支，不是错误）
 * - `svn update` 不接受 `--xml` → 只能文本解析（断言 argv 不含 --xml）
 * 作者 ddj 2026-09-16
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createSvnRpc } from '../src/svn.js'
import { mapRepoPath, parseLogXml, parseSvnInfoRevision } from '../src/svnLog.js'
import { commitResultOf, updateResultOf } from '../src/svnText.js'
import { attrOf, numAttrOf, scanXmlTags, textOf, unescapeXml } from '../src/svnXml.js'

/** 一段真实的 `svn log --xml -v` 输出（含复制来源、多行信息、目录与文件）。 */
const LOG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<log>
<logentry
   revision="5">
<author>ddj</author>
<date>2026-09-16T10:08:54.194855Z</date>
<paths>
<path
   prop-mods="false"
   text-mods="false"
   kind="file"
   action="D">/trunk/sub/y.txt</path>
<path
   prop-mods="false"
   text-mods="false"
   kind="file"
   copyfrom-path="/trunk/sub/y.txt"
   copyfrom-rev="4"
   action="A">/trunk/sub/z.txt</path>
</paths>
<msg>移动文件

附带第二行</msg>
</logentry>
<logentry
   revision="4">
<author>ddj</author>
<date>2026-09-16T10:08:53.704957Z</date>
<paths>
<path
   prop-mods="false"
   text-mods="false"
   kind="file"
   copyfrom-path="/trunk/sub/x.txt"
   copyfrom-rev="3"
   action="A">/trunk/sub/y.txt</path>
</paths>
<msg>copy x to y</msg>
</logentry>
</log>`

/**
 * `svn log -g --xml -v` 片段（P1-5）：形状与 §6 M1 实测一致——
 * 嵌套 `<logentry>` 位于父条目 `</msg>` 之后、可并列多个，嵌套条目带 `reverse-merge`，
 * 且其 paths 是**源分支路径**；顶层 r20 之后还有一条普通条目 r19（守护"嵌套不污染后续顶层"）。
 */
const MERGED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<log>
<logentry
   revision="20">
<author>ddj</author>
<date>2026-09-18T10:00:00.000000Z</date>
<paths>
<path
   prop-mods="true"
   text-mods="false"
   kind="dir"
   action="M">/trunk</path>
</paths>
<msg>Merged revision(s) 18 from /branches/feature: 
</msg>
<logentry
   reverse-merge="false"
   revision="18">
<author>other</author>
<date>2026-09-18T09:00:00.000000Z</date>
<paths>
<path
   prop-mods="false"
   text-mods="true"
   kind="file"
   action="M">/branches/feature/Assets/a.txt</path>
</paths>
<msg>feature 改动</msg>
</logentry>
<logentry
   reverse-merge="true"
   revision="17">
<author>other</author>
<date>2026-09-18T08:30:00.000000Z</date>
<paths>
<path
   prop-mods="false"
   text-mods="true"
   kind="file"
   action="M">/branches/feature/Assets/b.txt</path>
</paths>
<msg>反向合并的修订</msg>
</logentry>
</logentry>
<logentry
   revision="19">
<author>ddj</author>
<date>2026-09-18T08:00:00.000000Z</date>
<paths>
<path
   prop-mods="false"
   text-mods="true"
   kind="file"
   action="M">/trunk/README.md</path>
</paths>
<msg>普通条目</msg>
</logentry>
</log>`

// --region svnXml 基元

describe('svnXml 基元', () => {
  it('unescapeXml：命名实体与十进制/十六进制数字引用', () => {
    expect(unescapeXml('a&amp;b.txt')).toBe('a&b.txt')
    expect(unescapeXml('&lt;x&gt;')).toBe('<x>')
    expect(unescapeXml('&quot;q&quot;')).toBe('"q"')
    expect(unescapeXml('&#65;&#x42;')).toBe('AB')
    // 未知引用原样保留（不猜）
    expect(unescapeXml('&unknown;')).toBe('&unknown;')
    expect(unescapeXml('')).toBe('')
  })

  it('attrOf：取属性值并反转义；缺失返回空串', () => {
    const tag = '   prop-mods="false"\n   kind="file"\n   action="A"'
    expect(attrOf(tag, 'action')).toBe('A')
    expect(attrOf(tag, 'kind')).toBe('file')
    expect(attrOf(tag, 'missing')).toBe('')
    expect(attrOf('path="a&amp;b.txt"', 'path')).toBe('a&b.txt')
  })

  it('numAttrOf：数字属性；非法/缺失返回 undefined', () => {
    expect(numAttrOf('revision="42"', 'revision')).toBe(42)
    expect(numAttrOf('revision="abc"', 'revision')).toBeUndefined()
    expect(numAttrOf('x="1"', 'revision')).toBeUndefined()
  })

  it('textOf：文本节点（含换行）；缺失返回空串', () => {
    expect(textOf('<msg>a\nb</msg>', 'msg')).toBe('a\nb')
    expect(textOf('<x/>', 'msg')).toBe('')
  })

  it('scanXmlTags：只识别指定标签族，并区分开/闭/自闭合', () => {
    const xml = '<a x="1"><b/><c y="2"></c></a>'
    const hits = scanXmlTags(xml, ['a', 'b', 'c'])
    expect(hits.map((h) => [h.name, h.closing, h.selfClosing])).toEqual([
      ['a', false, false], ['b', false, true], ['c', false, false], ['c', true, false], ['a', true, false],
    ])
    // 未指定标签被忽略
    expect(scanXmlTags(xml, ['b']).every((h) => h.name === 'b')).toBe(true)
    expect(scanXmlTags('', ['a'])).toEqual([])
  })
})

// --endregion

// --region 日志解析与路径映射

describe('parseSvnInfoRevision（P1-9 工作副本版号解析）', () => {
  it('文件条目取 <commit revision>；目录条目返回 null', () => {
    const fileXml = '<info><entry kind="file" path="a.txt"><commit revision="293375"><author>x</author></commit></entry></info>'
    expect(parseSvnInfoRevision(fileXml)).toBe(293375)
    const dirXml = '<info><entry kind="dir" path="Assets"><commit revision="293375"><author>x</author></commit></entry></info>'
    expect(parseSvnInfoRevision(dirXml)).toBeNull()
  })

  it('无 commit 节点（added 未提交）与垃圾输入返回 null', () => {
    expect(parseSvnInfoRevision('<info><entry kind="file" path="a.txt"></entry></info>')).toBeNull()
    expect(parseSvnInfoRevision('svn: garbage')).toBeNull()
    expect(parseSvnInfoRevision('')).toBeNull()
  })
})

describe('mapRepoPath（仓库路径 → 工作区相对路径）', () => {
  it('剥 relative-url 前缀；根自身映射为空串', () => {
    expect(mapRepoPath('/trunk/sub/x.txt', '^/trunk')).toBe('sub/x.txt')
    expect(mapRepoPath('/trunk', '^/trunk')).toBe('')
    expect(mapRepoPath('/trunk/sub/', '^/trunk/')).toBe('sub')
  })

  it('前缀不匹配（分支/外部路径）返回 null，不硬拼错误路径', () => {
    expect(mapRepoPath('/branches/foo/x.txt', '^/trunk')).toBeNull()
    expect(mapRepoPath('/trunk2/x.txt', '^/trunk')).toBeNull()
  })

  it('无 relative-url 时不映射', () => {
    expect(mapRepoPath('/trunk/x.txt', '')).toBeNull()
  })

  it('relative-url 为 URL 编码形态（实测：空格 %20、中文 %EX）时先解码再比对（2026-09-17 缺陷修复）', () => {
    const encoded = '^/002%20%E9%A1%B9%E7%9B%AE%E5%BA%93/007%20%E4%B8%89%E6%B6%88/Project/Branch/Dev/IslandSplash'
    const repoPath = '/002 项目库/007 三消/Project/Branch/Dev/IslandSplash/Assets/GameData/a.prefab'
    expect(mapRepoPath(repoPath, encoded)).toBe('Assets/GameData/a.prefab')
  })

  it('解码回落：含非法 % 序列时按原值比对，不抛错', () => {
    expect(mapRepoPath('/trunk/a%zz.txt', '^/trunk')).toBe('a%zz.txt')
    expect(mapRepoPath('/branches/foo/x.txt', '^/trunk%zz')).toBeNull()
  })
})

describe('parseLogXml', () => {
  it('解析版本/作者/日期/多行提交信息与变更路径', () => {
    const { entries, truncated } = parseLogXml(LOG_XML, '^/trunk')
    expect(truncated).toBe(false)
    expect(entries).toHaveLength(2)
    const [first, second] = entries
    expect(first.revision).toBe(5)
    expect(first.author).toBe('ddj')
    expect(first.date).toContain('2026-09-16')
    // 多行信息保留换行（<msg> 是文本节点）
    expect(first.message).toBe('移动文件\n\n附带第二行')
    expect(first.paths.map((p) => p.action)).toEqual(['D', 'A'])
    expect(first.paths[0]).toMatchObject({ path: '/trunk/sub/y.txt', relPath: 'sub/y.txt', kind: 'file' })
    // 复制来源（svn move/copy 的 A 带 copyfrom）
    expect(first.paths[1]).toMatchObject({ copyFrom: '/trunk/sub/y.txt', copyFromRev: 4 })
    expect(second.revision).toBe(4)
    expect(second.message).toBe('copy x to y')
  })

  it('仓库前缀之外的路径标为 null（UI 显示仓库外而非错误路径）', () => {
    // 精确替换第二个条目的 path 文本（首个 /trunk/sub/x.txt 出现在 copyfrom 属性里）
    const xml = LOG_XML.replace('copyfrom-path="/trunk/sub/x.txt"', 'copyfrom-path="/branches/b/sub/x.txt"')
      .replace('>/trunk/sub/y.txt</path>', '>/branches/b/sub/y.txt</path>')
    const { entries } = parseLogXml(xml, '^/trunk')
    // 第一条的 D 行仍是 /trunk/sub/y.txt（未被替换的那处），第二条 copyfrom 已跨分支
    const branchEntry = entries[1]
    expect(branchEntry.paths[0].copyFrom).toBe('/branches/b/sub/x.txt')
    expect(branchEntry.paths[0].relPath).toBe('sub/y.txt')

    // 直接构造一条纯分支路径，断言映射为 null
    const outsideXml = '<log><logentry revision="1"><paths><path action="M" kind="file">/branches/b/x.txt</path></paths></logentry></log>'
    const outside = parseLogXml(outsideXml, '^/trunk').entries[0].paths[0]
    expect(outside.relPath).toBeNull()
    expect(outside.path).toBe('/branches/b/x.txt')
  })

  it('无 -v（无 paths 段）时 paths 为空数组，不抛错', () => {
    const xml = '<log><logentry revision="2"><author>me</author><date>2026-01-01T00:00:00Z</date><msg>only msg</msg></logentry></log>'
    const { entries } = parseLogXml(xml, '^/trunk')
    expect(entries).toHaveLength(1)
    expect(entries[0].paths).toEqual([])
    expect(entries[0].author).toBe('me')
  })

  it('空/畸形输入返回空清单', () => {
    expect(parseLogXml('', '^/trunk').entries).toEqual([])
    expect(parseLogXml('<log>', '^/trunk').entries).toEqual([])
    expect(parseLogXml('not xml', '^/trunk').entries).toEqual([])
  })

  it('超过上限时截断并标记', () => {
    const many = Array.from({ length: 5 }, (_v, i) => `<logentry revision="${i + 1}"><msg>m${i}</msg></logentry>`).join('')
    const { entries, truncated } = parseLogXml('<log>' + many + '</log>', '^/trunk', 3)
    expect(entries).toHaveLength(3)
    expect(truncated).toBe(true)
  })

  it('实体转义的提交信息与路径被正确还原', () => {
    const xml = '<log><logentry revision="1"><msg>fix &amp; cleanup</msg><paths><path action="A" kind="file">/trunk/a&amp;b.txt</path></paths></logentry></log>'
    const { entries } = parseLogXml(xml, '^/trunk')
    expect(entries[0].message).toBe('fix & cleanup')
    expect(entries[0].paths[0].relPath).toBe('a&b.txt')
  })

  // --region P1-5 Include merged revisions（-g；形状按 §6 M1 实测）

  it('不带 -g（无嵌套 logentry）：不产生 merged 字段，且路径不含源分支内容', () => {
    const { entries } = parseLogXml(LOG_XML, '^/trunk')
    expect(entries).toHaveLength(2)
    expect(entries[0].merged).toBeUndefined()
    expect(entries[0].paths.map((p) => p.path)).toEqual(['/trunk/sub/y.txt', '/trunk/sub/z.txt'])
  })

  it('-g 输出：嵌套条目收进父条目 merged，同级可并列；后续顶层条目不受嵌套影响', () => {
    const { entries, truncated } = parseLogXml(MERGED_XML, '^/trunk')
    expect(truncated).toBe(false)
    // 总条目数 = 顶层 2 条（嵌套不占顶层额度）
    expect(entries.map((e) => e.revision)).toEqual([20, 19])
    const parent = entries[0]
    // 父条目自身字段取块内首个同名节点（message 只到 </msg>，保留原文尾部换行）
    expect(parent.message).toBe('Merged revision(s) 18 from /branches/feature: \n')
    expect(parent.paths.map((p) => p.action)).toEqual(['M'])
    expect(parent.merged?.map((m) => m.revision)).toEqual([18, 17])
    // 嵌套条目解析出自身作者/日期/信息（属性顺序不稳定，故只断言值）
    expect(parent.merged?.[0]).toMatchObject({ author: 'other', message: 'feature 改动' })
    expect(parent.merged?.[0].date).toContain('2026-09-18')
    // reverse-merge 属性按可能存在 true 处理（实测只采到 false）
    expect(parent.merged?.[0].reverseMerge).toBe(false)
    expect(parent.merged?.[1].reverseMerge).toBe(true)
    // 嵌套条目的 paths 是源分支路径：不得误映射进工作区，按仓库外标 null
    expect(parent.merged?.[0].paths[0]).toMatchObject({ path: '/branches/feature/Assets/a.txt', relPath: null })
    expect(parent.merged?.[1].paths[0]).toMatchObject({ path: '/branches/feature/Assets/b.txt', relPath: null })
    // 顶层 r19 必须是干净的另一条（嵌套路径不得串进它）
    expect(entries[1].paths.map((p) => p.path)).toEqual(['/trunk/README.md'])
    expect(entries[1].merged).toBeUndefined()
  })

  it('嵌套块边界：多条顶层各自解析，前面的嵌套不吞掉后面的条目', () => {
    // 两条都带嵌套，且中间无多余文本（最坏形状）
    const xml = '<log>'
      + '<logentry revision="3"><msg>m3</msg><logentry revision="2"><msg>m2</msg></logentry></logentry>'
      + '<logentry revision="1"><msg>m1</msg></logentry>'
      + '</log>'
    const { entries } = parseLogXml(xml, '')
    expect(entries.map((e) => e.revision)).toEqual([3, 1])
    expect(entries[0].merged?.map((m) => m.revision)).toEqual([2])
    expect(entries[0].merged?.[0].message).toBe('m2')
    expect(entries[1].message).toBe('m1')
  })

  it('深度上限护栏：超过 LOG_MERGE_DEPTH 的嵌套不再下钻（不抛错、不无限递归）', () => {
    // 12 层嵌套：超过上限后停止收集，不产生 merged 字段
    let xml = '<logentry revision="1"><msg>deep</msg>'
    for (let i = 2; i <= 12; i += 1) xml = '<logentry revision="' + i + '"><msg>d' + i + '</msg>' + xml
    const { entries } = parseLogXml('<log>' + xml + '</log>', '')
    expect(entries.map((e) => e.revision)).toEqual([12])
    let node = entries[0]
    let depth = 0
    while (node.merged && node.merged.length) { depth += 1; node = node.merged[0] }
    expect(depth).toBeLessThan(12)
  })

  // 真实仓库日志样本**不入库**（.gitignore 排除 tests/fixtures/*.xml）：本地留着可复跑，
  // CI 上文件不存在则跳过本用例——嵌套形状仍由上面的合成用例守护。
  const realFixture = fileURLToPath(new URL('./fixtures/svnlog-g-r293108.xml', import.meta.url))
  it.skipIf(!existsSync(realFixture))('真实 `svn log -g` 输出（本地样本，未入库）解析结果与实测吻合', () => {
    // 样本取法：IslandSplash_BugFix 合并提交窗口 `svn log -r r293108:1 -l 5 --xml -v -g`（1.22MB，svn 1.14.5）
    const xml = readFileSync(realFixture, 'utf8')
    const relativeUrl = '^/002%20%E9%A1%B9%E7%9B%AE%E5%BA%93/007%20%E4%B8%89%E6%B6%88/Project/Branch/Dev/IslandSplash'
    const { entries, truncated } = parseLogXml(xml, relativeUrl)
    expect(truncated).toBe(false)
    // 顶层 5 条（-l 5），r293108 之后是普通条目
    expect(entries.map((e) => e.revision)).toEqual([293108, 293099, 293095, 293091, 293084])
    const merge = entries[0]
    expect(String(merge.message)).toContain('Merged revision(s) 292909-293107')
    expect(merge.merged?.map((m) => m.revision)).toEqual([293107, 293103])
    expect(merge.merged?.every((m) => m.reverseMerge === false)).toBe(true)
    // 嵌套条目 paths 为源分支路径 → 一律判为仓库外（不做硬拼）
    expect(merge.merged?.[0].paths.length).toBe(5420)
    expect(merge.merged?.[0].paths[0]).toMatchObject({
      path: '/002 项目库/007 三消/Project/Branch/Dev/IslandSplash_ZDev/Tools/RunningGMMcpServer',
      relPath: null,
    })
    // 普通条目不得因前面的嵌套而串味
    expect(entries[1].merged).toBeUndefined()
    expect(entries[1].paths).toHaveLength(1)
  })

  // --endregion
})

// --endregion

// --region update 条目级解析

describe('updateResultOf（条目级）', () => {
  it('解析 A/U/D 条目行并给中文说明（实测 update 输出形态）', () => {
    const out = "Updating '.':\nD    del.txt\nU    a.txt\nA    newfile.txt\nUpdated to revision 8."
    const res = updateResultOf(out, '', 0)
    expect(res.revision).toBe(8)
    expect(res.entries.map((e) => e.action)).toEqual(['D', 'U', 'A'])
    expect(res.entries.map((e) => e.path)).toEqual(['del.txt', 'a.txt', 'newfile.txt'])
    expect(res.entries[0].label).toBe('已删除')
    expect(res.entries[1].label).toBe('已更新')
    expect(res.summary).toContain('r8')
  })

  it('冲突条目进 entries 且进 conflicts（C 行 + 摘要段）', () => {
    const out = "Updating '.':\nC    conf.txt\nUpdated to revision 4.\nSummary of conflicts:\n  Text conflicts: 1"
    const res = updateResultOf(out, '', 0)
    expect(res.conflicts).toEqual(['conf.txt'])
    expect(res.entries.find((e) => e.action === 'C')?.label).toBe('冲突')
    expect(res.summary).toContain('冲突 1 项')
  })

  it('无变更（At revision N）时 entries 为空，摘要仍给出修订版号', () => {
    const res = updateResultOf("Updating '.':\nAt revision 8.", '', 0)
    expect(res.entries).toEqual([])
    expect(res.revision).toBe(8)
  })

  it('中文本地化输出同样可解析版本号', () => {
    expect(updateResultOf('已更新到版本 456。', '', 0).revision).toBe(456)
  })

  it('路径含空格时整段取为路径（不截断）', () => {
    const res = updateResultOf("U    my dir/a b.txt\nUpdated to revision 3.", '', 0)
    expect(res.entries[0].path).toBe('my dir/a b.txt')
  })

  it('失败输出保留原文且可为空条目', () => {
    const res = updateResultOf('', 'svn: E175013: Access denied', 1)
    expect(res.output).toContain('E175013')
    expect(res.entries).toEqual([])
    expect(res.revision).toBeUndefined()
  })
})

describe('commitResultOf（P4 预置）', () => {
  it('解析新版本号并生成成功摘要', () => {
    const res = commitResultOf('Sending a.txt\nTransmitting file data .\nCommitted revision 9.', '', 0)
    expect(res.revision).toBe(9)
    expect(res.summary).toContain('r9')
  })

  it('失败时保留失败摘要与原文', () => {
    const res = commitResultOf('', 'svn: E170001: auth failed', 1)
    expect(res.ok === undefined || res.revision === undefined).toBe(true)
    expect(res.summary).toContain('失败')
    expect(res.output).toContain('E170001')
  })
})

// --endregion

// --region createSvnRpc P3 handlers

/** 会话 mock（对齐既有 svn.test.ts 风格）。 */
function makeCtx(spawn: ((spec: Record<string, unknown>) => unknown) | null, cwd: string, fsMock?: unknown) {
  const session = { id: 's1', header: { cwd } }
  return {
    get: (name: string) => {
      if (name === 'subprocess') return spawn ? { spawn } : null
      if (name === 'sessions') return { list: () => [session] }
      if (name === 'fs') return fsMock ?? null
      return undefined
    },
  }
}

const settings = { svn: () => ({ svnPath: '', tortoisePath: '' }) }

/** 构造 deps（记录 spawn spec；log/info 返回给定输出）。 */
function makeLogDeps(over: {
  logXml?: string
  infoXml?: string
  catSides?: { left?: string; right?: string }
  code?: number
} = {}) {
  const specs: Array<Record<string, unknown>> = []
  const spawn = (spec: Record<string, unknown>) => {
    specs.push(spec)
    const argv = spec.argv as string[]
    if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
    if (argv.includes('info')) {
      return {
        done: Promise.resolve({ exitCode: 0 }),
        collected: { stdout: { readFrom: () => ({ text: over.infoXml ?? '<info><entry><relative-url>^/trunk</relative-url></entry></info>' }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }
    }
    if (argv.includes('log')) {
      return {
        done: Promise.resolve({ exitCode: over.code ?? 0 }),
        collected: { stdout: { readFrom: () => ({ text: over.logXml ?? LOG_XML }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }
    }
    if (argv.includes('cat')) {
      const revision = argv[argv.indexOf('-r') + 1]
      const isRight = over.catSides?.right !== undefined && revision === '5'
      const text = isRight ? over.catSides!.right! : (over.catSides?.left ?? '')
      const failed = over.catSides?.left === undefined && !isRight
      return {
        done: Promise.resolve({ exitCode: failed ? 1 : 0 }),
        collected: {
          stdout: { readFrom: () => ({ text: failed ? '' : text }) },
          stderr: { readFrom: () => ({ text: failed ? "svn: E195012: Unable to find repository location in revision 4" : '' }) },
        },
      }
    }
    return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } } }
  }
  return {
    specs,
    deps: {
      ctx: makeCtx(spawn, '/wc') as never,
      settings,
      findRoot: async () => '/wc',
      findTortoise: async () => null,
    },
  }
}

describe('createSvnRpc svn.log', () => {
  it('argv 必须显式带 -r HEAD:1（默认 BASE:1 会拿不到日志）与 --xml -v，且选项在 -- 之前', async () => {
    const { specs, deps } = makeLogDeps()
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.log']({ path: '' } as never) as { ok: boolean; entries?: unknown[]; target?: string }
    expect(res.ok).toBe(true)
    expect(res.entries).toHaveLength(2)
    const logSpec = specs.find((s) => (s.argv as string[]).includes('log'))
    const argv = logSpec?.argv as string[]
    expect(argv).toEqual(expect.arrayContaining(['--non-interactive', 'log', '-r', 'HEAD:1', '--xml', '-v']))
    expect(argv).toContain('-l')
  })

  it('带目标路径时选项全部在 -- 之前（实测 -v 放 -- 之后会被当路径）', async () => {
    const { specs, deps } = makeLogDeps()
    const { handlers } = createSvnRpc(deps)
    await (handlers as Record<string, (a: never) => unknown>)['svn.log']({ path: 'sub/x.txt' } as never)
    const argv = (specs.find((s) => (s.argv as string[]).includes('log'))?.argv as string[])
    expect(argv.indexOf('--')).toBeGreaterThan(argv.indexOf('-v'))
    expect(argv.slice(argv.indexOf('--'))).toEqual(['--', 'sub/x.txt'])
  })

  it('用 relative-url 映射仓库路径为工作区相对路径', async () => {
    const { deps } = makeLogDeps()
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.log']({ path: '' } as never) as {
      entries?: Array<{ paths: Array<{ relPath: string | null }> }>
    }
    expect(res.entries?.[0].paths[0].relPath).toBe('sub/y.txt')
  })

  it('未受管理工作区拒绝且不执行 log', async () => {
    const spawn = (spec: Record<string, unknown>) => {
      const argv = spec.argv as string[]
      if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
      throw new Error('不应执行：' + argv.join(' '))
    }
    const { handlers } = createSvnRpc({ ctx: makeCtx(spawn, '/nowc') as never, settings, findRoot: async () => null, findTortoise: async () => null })
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.log']({ path: '' } as never) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不受 SVN 管理')
  })

  it('log 非零退出返回错误并带原文', async () => {
    const spawn = (spec: Record<string, unknown>) => {
      const argv = spec.argv as string[]
      if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
      if (argv.includes('info')) return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: '<info/>' }) }, stderr: { readFrom: () => ({ text: '' }) } } }
      return { done: Promise.resolve({ exitCode: 1 }), collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: 'svn: E170013: unable to connect' }) } } }
    }
    const { handlers } = createSvnRpc({ ctx: makeCtx(spawn, '/wc') as never, settings, findRoot: async () => '/wc', findTortoise: async () => null })
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.log']({ path: '' } as never) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('E170013')
  })
})

describe('createSvnRpc svn.diffRev', () => {
  it('argv 为 cat -r REV 与 cat -r REV-1（两侧都以工作副本根为 cwd）', async () => {
    const { specs, deps } = makeLogDeps({ catSides: { left: 'old', right: 'new' } })
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.diffRev']({ path: 'a.txt', revision: 5 } as never) as { ok: boolean; left?: string | null; right?: string | null }
    expect(res.ok).toBe(true)
    expect(res.left).toBe('old')
    expect(res.right).toBe('new')
    const cats = specs.filter((s) => (s.argv as string[]).includes('cat'))
    expect(cats).toHaveLength(2)
    expect(cats[0].argv).toEqual(expect.arrayContaining(['cat', '-r', '5', '--', 'a.txt']))
    expect(cats[1].argv).toEqual(expect.arrayContaining(['cat', '-r', '4', '--', 'a.txt']))
    expect(cats[0].cwd).toBe('/wc')
  })

  it('左侧不存在（E195012 新增文件）→ left=null 且 ok=true（业务分支非错误）', async () => {
    const { deps } = makeLogDeps({ catSides: { right: 'new' } })
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.diffRev']({ path: 'new.txt', revision: 5 } as never) as { ok: boolean; left?: string | null; right?: string | null; reason?: string }
    expect(res.ok).toBe(true)
    expect(res.left).toBeNull()
    expect(res.right).toBe('new')
    expect(res.reason).toBe('not-exist')
  })

  it('版本 1 的上一版不存在 → 不执行第二次 cat', async () => {
    const { specs, deps } = makeLogDeps({ catSides: { right: 'first' } })
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.diffRev']({ path: 'a.txt', revision: 1 } as never) as { ok: boolean; left?: string | null }
    expect(res.ok).toBe(true)
    expect(res.left).toBeNull()
    expect(specs.filter((s) => (s.argv as string[]).includes('cat'))).toHaveLength(1)
  })

  it('路径与版本号守卫：空路径/越界/非法版本拒绝', async () => {
    const { deps } = makeLogDeps({ catSides: { left: 'a', right: 'b' } })
    const { handlers } = createSvnRpc(deps)
    const call = (handlers as Record<string, (a: never) => unknown>)['svn.diffRev']
    expect(((await call({ path: '', revision: 2 } as never)) as { ok: boolean }).ok).toBe(false)
    expect(((await call({ path: '../x', revision: 2 } as never)) as { ok: boolean }).ok).toBe(false)
    expect(((await call({ path: 'a.txt', revision: 0 } as never)) as { ok: boolean }).ok).toBe(false)
    expect(((await call({ path: 'a.txt', revision: -3 } as never)) as { ok: boolean }).ok).toBe(false)
  })
})

describe('createSvnRpc svn.cleanup', () => {
  it('默认只清锁（argv 不含破坏性选项）', async () => {
    const { specs, deps } = makeLogDeps()
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.cleanup']({} as never) as { ok: boolean; summary?: string }
    expect(res.ok).toBe(true)
    const argv = (specs.find((s) => (s.argv as string[]).includes('cleanup'))?.argv as string[])
    expect(argv).toEqual(['svn', '--non-interactive', 'cleanup'])
    expect(argv).not.toContain('--remove-unversioned')
    expect(res.summary).toContain('清理')
  })

  it('破坏性选项显式传入时才出现（且 host 不自行确认，确认在 client）', async () => {
    const { specs, deps } = makeLogDeps()
    const { handlers } = createSvnRpc(deps)
    await (handlers as Record<string, (a: never) => unknown>)['svn.cleanup']({ removeUnversioned: true } as never)
    const argv = (specs.find((s) => (s.argv as string[]).includes('cleanup'))?.argv as string[])
    expect(argv).toContain('--remove-unversioned')
    expect(argv).not.toContain('--remove-ignored')
  })

  it('清理失败返回错误并带原文', async () => {
    const spawn = (spec: Record<string, unknown>) => {
      const argv = spec.argv as string[]
      if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
      return { done: Promise.resolve({ exitCode: 1 }), collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: 'svn: E155004: locked' }) } } }
    }
    const { handlers } = createSvnRpc({ ctx: makeCtx(spawn, '/wc') as never, settings, findRoot: async () => '/wc', findTortoise: async () => null })
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.cleanup']({} as never) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('E155004')
  })
})

// --endregion
