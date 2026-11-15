/**
 * 引用路径解析的纯函数测试：清洗、排序、多义判定。
 *
 * 多义规则是「宁可不插也不插错」：只有唯一候选、或活动文件目录下恰好一个同名候选才自动插入。
 * @author ddj 2026年11月15号
 */
import { describe, expect, it } from 'vitest'
import { ambiguityOf, baseNameOfPath, cleanRefText, dirNameOfPath, rankCandidates } from '../src/refPointer.js'

describe('清洗路径片段', () => {
  it('去掉 @ / 引号 / 反斜杠 / 末尾斜杠', () => {
    expect(cleanRefText('@src\\a.ts')).toBe('src/a.ts')
    expect(cleanRefText('"src/a.ts"')).toBe('src/a.ts')
    expect(cleanRefText('  src/a/  ')).toBe('src/a')
    expect(cleanRefText('@')).toBe('')
    expect(cleanRefText('')).toBe('')
  })
})

describe('路径拆分', () => {
  it('取末段文件名与目录', () => {
    expect(baseNameOfPath('a/b/c.ts')).toBe('c.ts')
    expect(baseNameOfPath('c.ts')).toBe('c.ts')
    expect(dirNameOfPath('a/b/c.ts')).toBe('a/b')
    expect(dirNameOfPath('c.ts')).toBe('')
  })
})

describe('候选排序', () => {
  it('同目录优先，其次层级更浅、路径更短', () => {
    const ranked = rankCandidates(['deep/x/index.ts', 'src/index.ts', 'src/client/index.ts'], 'src/app.ts')
    // 同目录（src/）优先 → 层级更浅（src/index.ts 两段）→ 同层级时路径更短
    expect(ranked).toEqual(['src/index.ts', 'deep/x/index.ts', 'src/client/index.ts'])
  })

  it('去重且归一反斜杠', () => {
    expect(rankCandidates(['a\\b.ts', 'a/b.ts'])).toEqual(['a/b.ts'])
  })
})

describe('多义判定', () => {
  it('唯一候选可插入', () => {
    expect(ambiguityOf(['src/a.ts'], 'src/app.ts')).toEqual([])
  })

  it('多个候选且活动目录里没有 → 多义（不瞎插）', () => {
    const ranked = rankCandidates(['src/index.ts', 'src/client/index.ts'], 'src/search/ripgrep.ts')
    expect(ambiguityOf(ranked, 'src/search/ripgrep.ts').length).toBeGreaterThan(0)
  })

  it('多个候选但活动目录恰好一个 → 可插入', () => {
    const ranked = rankCandidates(['src/index.ts', 'src/client/index.ts'], 'src/app.ts')
    expect(ambiguityOf(ranked, 'src/app.ts')).toEqual([])
  })

  it('活动目录里也有多个同名 → 多义', () => {
    const ranked = rankCandidates(['src/index.ts', 'src/other.ts', 'lib/index.ts'], 'src/app.ts')
    expect(ambiguityOf(ranked, 'src/app.ts').length).toBeGreaterThan(0)
  })

  it('没有活动文件时，多个候选一律多义', () => {
    expect(ambiguityOf(['a.ts', 'b/a.ts'], '')).toHaveLength(2)
  })
})
