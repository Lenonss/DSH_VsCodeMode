/**
 * P2 status --xml 解析与变更消费纯函数测试。
 * 覆盖：parseStatusXml（多块 changelist / 路径归一 / 实体反转义 / 根条目 / 畸形输入 / 上限截断）、
 * changePathOf、batchResultOf、SVN_STATUS_* 表、svnVisibleChanges / svnBadgeOf / isSvnDiffable。
 * 期望值取自本机 svn 1.14.5 在真实工作副本上的实测输出（含 Windows 反斜杠路径与 `&` 转义）。
 * 平台注意：断言只用 `/` 归一后的相对路径，不写死盘符/分隔符（CI 跑 ubuntu）。
 * 作者 ddj 2026-09-16
 */
import { describe, expect, it } from 'vitest'
import { batchResultOf, changePathOf, parseStatusXml } from '../src/svn.js'
import {
  SVN_STATUS_LABEL,
  SVN_STATUS_LETTER,
  SVN_STATUS_TONE,
  isSvnDiffable,
  svnBadgeOf,
  svnBadgeTitle,
  svnVisibleChanges,
} from '../src/shared/svn.js'
import type { SvnChangeEntry, SvnItemStatus } from '../src/shared/svn.js'

/** 一份实测输出的最小样例（含 changelist 块与未版本控制项）。 */
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<status>
<target
   path=".">
<entry
   path="keep.txt">
<wc-status
   props="none"
   item="deleted"
   revision="2">
</wc-status>
</entry>
<entry
   path="new.txt">
<wc-status
   item="added"
   revision="-1"
   props="none">
</wc-status>
</entry>
</target>
<changelist
   name="mylist">
<entry
   path="a.txt">
<wc-status
   item="modified"
   revision="2"
   props="none">
</wc-status>
</entry>
</changelist>
</status>`

describe('changePathOf', () => {
  it('Windows 反斜杠归一为斜杠（XML 实测路径形态）', () => {
    expect(changePathOf('sub\\deep\\b.txt')).toBe('sub/deep/b.txt')
  })

  it('剥 ./ 前缀并去尾部斜杠', () => {
    expect(changePathOf('./sub/a.txt')).toBe('sub/a.txt')
    expect(changePathOf('sub/')).toBe('sub')
  })

  it('根自身（. 或空）归一为空串', () => {
    expect(changePathOf('.')).toBe('')
    expect(changePathOf('')).toBe('')
  })
})

describe('parseStatusXml', () => {
  it('解析 target 内条目：状态/属性/版本号/受版本控制标记', () => {
    const { entries, truncated } = parseStatusXml(SAMPLE)
    expect(truncated).toBe(false)
    const byPath = Object.fromEntries(entries.map((entry) => [entry.path, entry]))
    expect(byPath['keep.txt']).toMatchObject({ status: 'deleted', props: 'none', versioned: true, revision: 2 })
    expect(byPath['new.txt']).toMatchObject({ status: 'added', versioned: true })
    // revision="-1"（新增未提交）不入载荷
    expect(byPath['new.txt'].revision).toBeUndefined()
  })

  it('changelist 块内的条带回 changelist 名（同块内多条共享）', () => {
    const xml = SAMPLE.replace('</changelist>', '<entry\n   path="b.txt">\n<wc-status\n   item="modified"\n   revision="2"\n   props="none">\n</wc-status>\n</entry>\n</changelist>')
    const { entries } = parseStatusXml(xml)
    const named = entries.filter((entry) => entry.changelist === 'mylist')
    expect(named.map((entry) => entry.path)).toEqual(['a.txt', 'b.txt'])
    // 块外条目不带 changelist
    expect(entries.find((entry) => entry.path === 'keep.txt')?.changelist).toBeUndefined()
  })

  it('path="." 的根自身条目被跳过（不把根当变更项）', () => {
    const xml = '<status><target path="."><entry path="."><wc-status props="modified" item="normal" revision="1"/></entry><entry path="a.txt"><wc-status item="modified" revision="1" props="none"/></entry></target></status>'
    const { entries } = parseStatusXml(xml)
    expect(entries.map((entry) => entry.path)).toEqual(['a.txt'])
  })

  it('XML 实体反转义（实测路径含 & 时会输出 &amp;）', () => {
    const xml = '<status><target path="."><entry path="a&amp;b.txt"><wc-status item="modified" revision="2" props="none"/></entry></target></status>'
    const { entries } = parseStatusXml(xml)
    expect(entries[0].path).toBe('a&b.txt')
  })

  it('属性列 modified 被保留（props 只收敛为 none/modified/conflicted）', () => {
    const xml = '<status><target path="."><entry path="x"><wc-status item="modified" revision="2" props="modified"/></entry></target></status>'
    const { entries } = parseStatusXml(xml)
    expect(entries[0].props).toBe('modified')
  })

  it('未版本控制/忽略项标记为非版本控制', () => {
    const xml = '<status><target path="."><entry path="u.txt"><wc-status item="unversioned" props="none"/></entry><entry path="i.log"><wc-status item="ignored" props="none"/></entry></target></status>'
    const byPath = Object.fromEntries(parseStatusXml(xml).entries.map((entry) => [entry.path, entry]))
    expect(byPath['u.txt'].versioned).toBe(false)
    expect(byPath['i.log'].versioned).toBe(false)
  })

  it('冲突条目与冲突残留文件同现（.mine/.rN 为 unversioned）', () => {
    const xml = '<status><target path="."><entry path="c.txt"><wc-status item="conflicted" revision="3" props="none"/></entry><entry path="c.txt.mine"><wc-status item="unversioned" props="none"/></entry></target></status>'
    const { entries } = parseStatusXml(xml)
    expect(entries[0]).toMatchObject({ status: 'conflicted', versioned: true })
    expect(entries[1]).toMatchObject({ status: 'unversioned', versioned: false })
  })

  it('未知 item 值按 modified 兜底（不抛错、不丢条目）', () => {
    const xml = '<status><target path="."><entry path="x"><wc-status item="wat" props="none"/></entry></target></status>'
    expect(parseStatusXml(xml).entries[0].status).toBe('modified')
  })

  it('空/畸形输入返回空清单且不抛错', () => {
    expect(parseStatusXml('').entries).toEqual([])
    expect(parseStatusXml('<status><target path=".">').entries).toEqual([])
    expect(parseStatusXml('not xml at all').entries).toEqual([])
  })

  it('超过上限时截断并标记 truncated', () => {
    const rows = []
    for (let i = 0; i < 5; i += 1) rows.push('<entry path="f' + i + '"><wc-status item="modified" revision="1" props="none"/></entry>')
    const xml = '<status><target path=".">' + rows.join('') + '</target></status>'
    const { entries, truncated } = parseStatusXml(xml, 3)
    expect(entries).toHaveLength(3)
    expect(truncated).toBe(true)
  })
})

describe('batchResultOf', () => {
  it('成功：按 Reverted/Adding 行计数并给中文摘要', () => {
    const out = "Reverted 'a.txt'\nReverted 'b.txt'\n"
    const res = batchResultOf(out, '', 0, '还原')
    expect(res.count).toBe(2)
    expect(res.summary).toContain('还原完成')
    expect(res.summary).toContain('2 项')
  })

  it('成功但无匹配行：摘要不带计数', () => {
    const res = batchResultOf('', '', 0, '加入版本控制')
    expect(res.count).toBe(0)
    expect(res.summary).toBe('加入版本控制完成')
  })

  it('失败：摘要带原文尾部（诊断用）', () => {
    const res = batchResultOf('', 'svn: E200009: Illegal target', 1, '加入版本控制')
    expect(res.summary).toContain('失败')
    expect(res.summary).toContain('E200009')
  })
})

describe('状态表与消费纯函数', () => {
  const base = { wcRoot: '/wc', svnPath: 'svn', tortoiseExe: '' }
  const entry = (path: string, status: SvnItemStatus, over: Partial<SvnChangeEntry> = {}): SvnChangeEntry => ({
    path, status, versioned: status !== 'unversioned' && status !== 'ignored', ...over,
  })

  it('字母/标签/配色表覆盖全部状态（无遗漏键）', () => {
    const all: SvnItemStatus[] = ['normal', 'added', 'deleted', 'replaced', 'conflicted', 'missing', 'unversioned', 'obstructed', 'ignored', 'modified', 'external', 'incomplete']
    for (const status of all) {
      expect(SVN_STATUS_LETTER[status]).toBeTypeOf('string')
      expect(SVN_STATUS_LABEL[status]).toBeTruthy()
      expect(SVN_STATUS_TONE[status]).toBeTruthy()
    }
    expect(SVN_STATUS_LETTER.modified).toBe('M')
    expect(SVN_STATUS_LETTER.conflicted).toBe('C')
    expect(SVN_STATUS_TONE.conflicted).toBe('conflict')
  })

  it('svnVisibleChanges：默认显示未版本控制、隐藏忽略项', () => {
    const list = [
      entry('m.txt', 'modified'),
      entry('u.txt', 'unversioned'),
      entry('i.log', 'ignored'),
      entry('n.txt', 'normal'),
    ]
    expect(svnVisibleChanges(list).map((item) => item.path)).toEqual(['m.txt', 'u.txt'])
  })

  it('svnVisibleChanges：开关可放开忽略项与关掉未版本控制', () => {
    const list = [entry('u.txt', 'unversioned'), entry('i.log', 'ignored')]
    expect(svnVisibleChanges(list, { ignored: true }).map((item) => item.path)).toEqual(['u.txt', 'i.log'])
    expect(svnVisibleChanges(list, { unversioned: false }).map((item) => item.path)).toEqual([])
  })

  it('svnBadgeOf/svnBadgeTitle：normal 与 external 不出徽标', () => {
    expect(svnBadgeOf(entry('a', 'normal'))).toBe('')
    expect(svnBadgeOf(entry('a', 'external'))).toBe('')
    expect(svnBadgeOf(entry('a', 'missing'))).toBe('!')
    expect(svnBadgeTitle(entry('a', 'modified'))).toBe('M 已修改')
    expect(svnBadgeTitle(entry('a', 'normal'))).toBe('')
  })

  it('isSvnDiffable：未版本控制/忽略项不可比较；二进制扩展名不可比较', () => {
    expect(isSvnDiffable('src/a.ts')).toBe(true)
    expect(isSvnDiffable('src/a.ts', 'modified')).toBe(true)
    expect(isSvnDiffable('new.txt', 'unversioned')).toBe(false)
    expect(isSvnDiffable('x.log', 'ignored')).toBe(false)
    expect(isSvnDiffable('img/logo.png', 'modified')).toBe(false)
    expect(isSvnDiffable('doc/manual.pdf', 'modified')).toBe(false)
    expect(isSvnDiffable('Dockerfile')).toBe(true)
    expect(base.wcRoot).toBe('/wc')
  })
})
