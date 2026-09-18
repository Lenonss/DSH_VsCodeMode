// @ts-nocheck
/**
 * SVN 日志客户端缓存键（P1-8 追加语义）单测。
 * 守护：limit 不再参与键——「加载更多」对同一键取更大 limit 后原地替换，而非另开缓存项。
 * 作者 ddj 2026年09月17号
 */
import { describe, expect, it } from 'vitest'
import { logKeyOf, svnLogKeyOf } from '../src/client/svnLog.js'

describe('logKeyOf（P1-8 缓存键）', () => {
  it('键仅含 scope 与 target，不同 target/scope 互相隔离', () => {
    expect(logKeyOf('s1', 'Assets')).toBe('s1\u0000Assets')
    expect(logKeyOf('s1', 'Assets')).not.toBe(logKeyOf('s1', 'Assets/Editor'))
    expect(logKeyOf('s1', 'Assets')).not.toBe(logKeyOf('s2', 'Assets'))
  })

  it('不同 limit 得到同一键（加载更多 = 原地替换的前提）', () => {
    // 旧实现把 limit 编进键；P1-8 起同目标任何 limit 命中同一缓存项
    expect(logKeyOf('s1', 'Assets')).toBe(svnStoreKeyCompat('s1', 'Assets', 100))
  })

  it('variant 维度：soc/range 进键且互不污染（P1-4/P1-6）', () => {
    expect(logKeyOf('s1', 'Assets', 'soc')).toBe('s1\u0000Assets\u0000soc')
    expect(logKeyOf('s1', 'Assets', 'r100-200')).not.toBe(logKeyOf('s1', 'Assets'))
    expect(logKeyOf('s1', 'Assets', 'soc|r100-200')).not.toBe(logKeyOf('s1', 'Assets', 'soc'))
    expect(logKeyOf('s1', 'Assets', '')).toBe('s1\u0000Assets')
  })

  it('variant 维度：mrg（P1-5 Include merged revs）与默认/soc/range 均隔离', () => {
    expect(logKeyOf('s1', 'Assets', 'mrg')).toBe('s1\u0000Assets\u0000mrg')
    expect(logKeyOf('s1', 'Assets', 'mrg')).not.toBe(logKeyOf('s1', 'Assets'))
    expect(logKeyOf('s1', 'Assets', 'mrg')).not.toBe(logKeyOf('s1', 'Assets', 'soc'))
    expect(logKeyOf('s1', 'Assets', 'soc|mrg')).not.toBe(logKeyOf('s1', 'Assets', 'soc'))
    expect(logKeyOf('s1', 'Assets', 'soc|mrg|r100-200')).not.toBe(logKeyOf('s1', 'Assets', 'soc|r100-200'))
  })

  it('svnLogKeyOf：opts 三选项各自进键，同选项组合稳定（EditorView 事件键与状态层同源）', () => {
    const base = svnLogKeyOf('s1', 'Assets')
    expect(svnLogKeyOf('s1', 'Assets', { showMerged: true })).toBe(logKeyOf('s1', 'Assets', 'mrg'))
    expect(svnLogKeyOf('s1', 'Assets', { stopOnCopy: true, showMerged: true })).toBe(logKeyOf('s1', 'Assets', 'soc|mrg'))
    expect(svnLogKeyOf('s1', 'Assets', { showMerged: true })).not.toBe(base)
    expect(svnLogKeyOf('s1', 'Assets', {})).toBe(base)
  })
})

/** 旧签名的兼容模拟：无论 limit 是多少都返回同一键（回归语义锚点）。 */
function svnStoreKeyCompat(scope: string, target: string, _limit: number): string {
  return logKeyOf(scope, target)
}
