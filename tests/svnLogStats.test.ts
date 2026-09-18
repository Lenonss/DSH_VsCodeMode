// @ts-nocheck
/**
 * SVN 日志统计聚合（P1-10）单测：总数/期间/作者分布/case-insensitive 归并。
 * 守护：统计口径（总数=传入条目、期间取可解析日期的 min/max）与作者归并开关语义。
 * 作者 ddj 2026年09月17号
 */
import { describe, expect, it } from 'vitest'
import { svnLogStatsOf } from '../src/client/ui/SvnLogStats.js'

const entryOf = (author: string | undefined, date: string) => ({ author, date, message: '', paths: [] })

describe('svnLogStatsOf（P1-10 聚合）', () => {
  it('总数与期间：取可解析日期的 min/max，无日期条目仍计入总数', () => {
    const stats = svnLogStatsOf([
      entryOf('a', '2026-09-05T10:00:00Z'),
      entryOf('b', '2026-09-01T08:00:00Z'),
      entryOf('c', 'not-a-date'),
    ])
    expect(stats.total).toBe(3)
    expect(stats.minDate).toBe('2026-09-01')
    expect(stats.maxDate).toBe('2026-09-05')
  })

  it('作者分布：降序、无作者归「（无作者）」', () => {
    const stats = svnLogStatsOf([
      entryOf('dadajuan', '2026-09-01T00:00:00Z'),
      entryOf('dadajuan', '2026-09-02T00:00:00Z'),
      entryOf('qiuqiu', '2026-09-02T00:00:00Z'),
      entryOf(undefined, '2026-09-03T00:00:00Z'),
    ])
    expect(stats.authors.map((a) => [a.name, a.count])).toEqual([
      ['dadajuan', 2],
      ['（无作者）', 1],
      ['qiuqiu', 1],
    ])
  })

  it('caseInsensitive 开关：默认区分大小写，开启后同名词形归并', () => {
    const entries = [
      entryOf('Dadajuan', '2026-09-01T00:00:00Z'),
      entryOf('dadajuan', '2026-09-02T00:00:00Z'),
    ]
    expect(svnLogStatsOf(entries).authors).toHaveLength(2)
    const merged = svnLogStatsOf(entries, { caseInsensitive: true })
    expect(merged.authors).toHaveLength(1)
    expect(merged.authors[0].count).toBe(2)
  })

  it('空输入：total 0、期间为空、无作者分布', () => {
    const stats = svnLogStatsOf([])
    expect(stats.total).toBe(0)
    expect(stats.minDate).toBe('')
    expect(stats.authors).toHaveLength(0)
    expect(stats.days).toHaveLength(0)
  })
})
