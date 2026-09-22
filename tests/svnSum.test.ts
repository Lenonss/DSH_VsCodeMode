/**
 * W2 解析纯函数单测（fixtures 取自 2026-09-20 M3/M5 探针实测输出，svn 1.14.5）。
 * 守护：M5 —— summarize 的 path 文本为绝对路径（需归一为工作副本相对）、属性顺序不稳定
 * （只按字段名取值，不做字符串快照）；M3 —— repos-status 缺省 = 远端无变化、落后锚点
 * = repos-status@item ≠ 'none'、against@revision 提取；路径归一的盘符/大小写容错。
 * 作者 ddj 2026年09月20号
 */
import { describe, expect, it } from 'vitest'
import { parseRemoteStatusXml, parseSummarizeXml, relPathOfAbs } from '../src/svn.js'

const WC_ROOT = 'D:\\Work\\PopIsland\\IslandSplash_BugFix'

/** M5 实测形态（属性顺序两种排列混排 + 反斜杠绝对路径 + 无变更的 dir 混入）。 */
const SUM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<diff>
<paths>
<path
   props="none"
   kind="file"
   item="modified">${WC_ROOT}\\Assets\\Scripts\\Audio\\ConstDefine\\AudioConst.cs</path>
<path
   props="none"
   kind="file"
   item="added">${WC_ROOT}\\Assets\\Scripts\\Audio\\AudioClipCache.cs</path>
<path
   kind="dir"
   item="modified"
   props="none">${WC_ROOT}\\Assets\\Scripts\\Audio</path>
<path
   props="none"
   kind="file"
   item="deleted">${WC_ROOT}\\Assets\\Scripts\\Audio\\Old.cs</path>
</paths>
</diff>`

/** M3 实测形态（落后条目带 repos-status item="modified"；未落后条目无该元素；against 修订）。 */
const REMOTE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<status>
<target
   path="${WCROOT()}\\Assets\\Scripts\\Lua\\Sys\\Else">
<entry
   path="${WCROOT()}\\Assets\\Scripts\\Lua\\Sys\\Else\\LuaDefine.lua">
<wc-status
   item="normal"
   revision="293524"
   props="none">
</wc-status>
<repos-status
   item="modified"
   props="none">
</repos-status>
</entry>
<entry
   path="${WCROOT()}\\Assets\\Scripts\\Lua\\Sys\\Else\\Other.lua">
<wc-status
   item="normal"
   revision="293524"
   props="none">
</wc-status>
</entry>
<against
   revision="293534"/>
</target>
</status>`

/** 冒烟实测（2026-09-20）host 常态形态：cwd=wcRoot + 相对路径目标 → svn 回显【相对路径】。 */
const SUM_XML_REL = `<?xml version="1.0" encoding="UTF-8"?>
<diff>
<paths>
<path
   item="modified"
   props="none"
   kind="file">Assets\\Scripts\\Audio\\ConstDefine\\AudioConst.cs</path>
<path
   item="added"
   props="none"
   kind="file">Assets\\Scripts\\Audio\\AudioClipCache.cs</path>
<path
   item="modified"
   props="none"
   kind="file">Assets\\Scripts\\Audio</path>
</paths>
</diff>`

/** M3 实测相对路径形态（host 常态：cwd=wcRoot + 相对目标 → entry path 为相对路径）。 */
const REMOTE_XML_REL = `<?xml version="1.0" encoding="UTF-8"?>
<status>
<target
   path="Assets\\Scripts\\Lua\\Sys\\Else">
<entry
   path="Assets\\Scripts\\Lua\\Sys\\Else\\LuaDefine.lua">
<wc-status
   item="normal"
   revision="293524"
   props="none">
</wc-status>
<repos-status
   item="modified"
   props="none">
</repos-status>
</entry>
<against
   revision="293558"/>
</target>
</status>`

function WCROOT(): string {
  return 'D:\\Work\\PopIsland\\IslandSplash_BugFix'
}

describe('relPathOfAbs（绝对路径 → 工作副本相对）', () => {
  it('反斜杠与正斜杠都归一为 `/` 分隔的相对路径', () => {
    expect(relPathOfAbs('D:\\wc\\a\\b.txt', 'D:\\wc')).toBe('a/b.txt')
    expect(relPathOfAbs('D:/wc/a/b.txt', 'D:\\wc\\')).toBe('a/b.txt')
  })

  it('Windows 盘符大小写不敏感匹配，剥离后保留原大小写', () => {
    expect(relPathOfAbs('d:\\WC\\Assets\\A.lua', 'D:\\wc')).toBe('Assets/A.lua')
  })

  it('不在根下返回 null；根自身返回 null（无相对段）', () => {
    expect(relPathOfAbs('D:\\other\\a.txt', 'D:\\wc')).toBeNull()
    expect(relPathOfAbs('D:\\wc', 'D:\\wc')).toBeNull()
    expect(relPathOfAbs('D:\\wc\\', 'D:\\wc')).toBeNull()
  })
})

describe('parseSummarizeXml（W2-2，M5 形态）', () => {
  it('按字段名取 item/kind/props（属性顺序不稳定），路径归一为相对', () => {
    const parsed = parseSummarizeXml(SUM_XML, WC_ROOT)
    expect(parsed.truncated).toBe(false)
    expect(parsed.entries.map((entry) => entry.path)).toEqual([
      'Assets/Scripts/Audio/ConstDefine/AudioConst.cs',
      'Assets/Scripts/Audio/AudioClipCache.cs',
      'Assets/Scripts/Audio',
      'Assets/Scripts/Audio/Old.cs',
    ])
    expect(parsed.entries[0]).toEqual({ path: 'Assets/Scripts/Audio/ConstDefine/AudioConst.cs', item: 'modified', kind: 'file', props: 'none' })
    expect(parsed.entries[2].kind).toBe('dir')
    expect(parsed.entries[3].item).toBe('deleted')
  })

  it('区间无变更（<paths> 空）→ 空数组非错误；畸形输入不抛错', () => {
    expect(parseSummarizeXml('<diff><paths></paths></diff>', WC_ROOT)).toEqual({ entries: [], truncated: false })
    expect(parseSummarizeXml('', WC_ROOT)).toEqual({ entries: [], truncated: false })
  })

  it('cap 截断标记', () => {
    const parsed = parseSummarizeXml(SUM_XML, WC_ROOT, 2)
    expect(parsed.entries.length).toBe(2)
    expect(parsed.truncated).toBe(true)
  })

  it('相对路径形态（host 常态，冒烟实测）：相对回显直接归一，不要求 wcRoot 前缀', () => {
    const parsed = parseSummarizeXml(SUM_XML_REL, WC_ROOT)
    expect(parsed.entries.map((entry) => entry.path)).toEqual([
      'Assets/Scripts/Audio/ConstDefine/AudioConst.cs',
      'Assets/Scripts/Audio/AudioClipCache.cs',
      'Assets/Scripts/Audio',
    ])
    expect(parsed.entries[0].item).toBe('modified')
  })
})

describe('parseRemoteStatusXml（W2-3，M3 形态）', () => {
  it('落后锚点 = repos-status 存在且 item ≠ none；未落后条目（无该元素）不产出', () => {
    const parsed = parseRemoteStatusXml(REMOTE_XML, WC_ROOT)
    expect(parsed.againstRev).toBe(293534)
    expect(parsed.outdated).toEqual([
      { path: 'Assets/Scripts/Lua/Sys/Else/LuaDefine.lua', item: 'modified' },
    ])
    expect(parsed.truncated).toBe(false)
  })

  it('repos-status item="none" 视为不落后；against 缺失 = null；畸形输入不抛错', () => {
    const xml = `<status><target path="x"><entry path="${WC_ROOT}\\a.lua"><wc-status item="normal"/><repos-status item="none"/></entry><against revision="7"/></target></status>`
    expect(parseRemoteStatusXml(xml, WC_ROOT).outdated).toEqual([])
    expect(parseRemoteStatusXml('<status><target/></status>', WC_ROOT)).toEqual({ outdated: [], againstRev: null, truncated: false })
    expect(parseRemoteStatusXml('', WC_ROOT)).toEqual({ outdated: [], againstRev: null, truncated: false })
  })

  it('相对路径形态（host 常态，冒烟实测）：相对 entry path 直接归一', () => {
    const parsed = parseRemoteStatusXml(REMOTE_XML_REL, WC_ROOT)
    expect(parsed.againstRev).toBe(293558)
    expect(parsed.outdated).toEqual([
      { path: 'Assets/Scripts/Lua/Sys/Else/LuaDefine.lua', item: 'modified' },
    ])
  })

  it('cap 截断标记', () => {
    const parsed = parseRemoteStatusXml(REMOTE_XML, WC_ROOT, 0)
    expect(parsed.truncated).toBe(true)
  })
})
