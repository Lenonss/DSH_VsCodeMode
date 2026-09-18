/**
 * SVN 日志排序单测（P0-12/D31，G10）：
 * 四键 × 升降序、日期解析失败沉底、message 按首行排序与显示一致、默认保持后端倒序。
 * 蓝图落点：src/svnLog.ts orderLogEntries（纯函数）。
 * 作者 ddj 2026-09-17
 */
import { describe, expect, it } from 'vitest'
import { orderLogEntries } from '../src/svnLog.js'
import type { SvnLogEntry } from '../src/shared/svn.js'

/** 构造条目。 */
function mk(revision: number, extra: Partial<SvnLogEntry> = {}): SvnLogEntry {
  return { revision, author: '', date: '', message: '', paths: [], ...extra }
}

describe('orderLogEntries 排序（P0-12）', () => {
  const entries = [
    mk(300, { author: 'zhang', date: '2026-09-16T10:00:00Z', message: '第三行\n第二段' }),
    mk(100, { author: 'wang', date: '2026-09-17T10:00:00Z', message: '首行A' }),
    mk(200, { author: 'li', date: '2026-09-15T10:00:00Z', message: '首行B' }),
  ]

  it('默认 revision desc（数值降序；host 后端本就倒序，对真实数据等价于保持原序）', () => {
    expect(orderLogEntries(entries).map((e) => e.revision)).toEqual([300, 200, 100])
    expect(orderLogEntries(entries, 'revision', 'desc').map((e) => e.revision)).toEqual([300, 200, 100])
  })

  it('revision asc', () => {
    expect(orderLogEntries(entries, 'revision', 'asc').map((e) => e.revision)).toEqual([100, 200, 300])
  })

  it('author 用 localeCompare（asc/desc）', () => {
    expect(orderLogEntries(entries, 'author', 'asc').map((e) => e.revision)).toEqual([200, 100, 300])
    expect(orderLogEntries(entries, 'author', 'desc').map((e) => e.revision)).toEqual([300, 100, 200])
  })

  it('message 按首行排序（与显示一致；localeCompare 拼音序：首 > 第），desc', () => {
    expect(orderLogEntries(entries, 'message', 'desc').map((e) => e.revision)).toEqual([200, 100, 300])
  })

  it('date 按时间戳排序；解析失败行恒定沉底（不随方向翻转）', () => {
    const withBad = [
      mk(1, { date: '2026-09-17T09:00:00Z' }),
      mk(2, { date: 'not-a-date' }),
      mk(3, { date: '2026-09-15T09:00:00Z' }),
      mk(4, { date: '' }),
    ]
    const asc = orderLogEntries(withBad, 'date', 'asc')
    expect(asc.map((e) => e.revision)).toEqual([3, 1, 2, 4])
    const desc = orderLogEntries(withBad, 'date', 'desc')
    expect(desc.map((e) => e.revision)).toEqual([1, 3, 2, 4])
  })

  it('不改动入参（纯函数）', () => {
    const before = entries.map((e) => e.revision)
    orderLogEntries(entries, 'author', 'asc')
    expect(entries.map((e) => e.revision)).toEqual(before)
  })
})
