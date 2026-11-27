/**
 * client recentOpen 测试（最近打开记录：TTL 裁剪 + 合并进恢复结果）。
 * 复现的缺陷：链接打开文件后，界面状态恢复把节点顶回旧文件。
 * 作者 ddj 2026-11-26
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyRecentOpen,
  clearRecentOpen,
  markRecentOpen,
  recentOpenOf,
  RECENT_OPEN_TTL_MS,
} from '../src/client/state/recentOpen.js'

afterEach(() => { clearRecentOpen() })

describe('markRecentOpen / recentOpenOf', () => {
  it('写入后 TTL 内可读回', () => {
    markRecentOpen('ws:a', 'Assets/Scripts/Boot/BootText.cs', 1_000)
    expect(recentOpenOf('ws:a', 1_000)).toBe('Assets/Scripts/Boot/BootText.cs')
  })

  it('超过 TTL 视为无记录（交回存档语义）', () => {
    markRecentOpen('ws:b', 'a.cs', 1_000)
    expect(recentOpenOf('ws:b', 1_000 + RECENT_OPEN_TTL_MS)).toBe('a.cs')
    expect(recentOpenOf('ws:b', 1_001 + RECENT_OPEN_TTL_MS)).toBeNull()
  })

  it('系统时间回拨时仍视为新鲜', () => {
    markRecentOpen('ws:c', 'b.cs', 5_000)
    expect(recentOpenOf('ws:c', 4_000)).toBe('b.cs')
  })

  it('作用域隔离：不同工作区互不影响', () => {
    markRecentOpen('ws:x', 'x.cs', 1_000)
    expect(recentOpenOf('ws:y', 1_000)).toBeNull()
  })

  it('只留最新一条；空 scope/空 path 忽略', () => {
    markRecentOpen('ws:d', 'old.cs', 1_000)
    markRecentOpen('ws:d', 'new.cs', 1_100)
    expect(recentOpenOf('ws:d', 1_100)).toBe('new.cs')
    markRecentOpen('', 'x.cs', 1_100)
    markRecentOpen('ws:e', '', 1_100)
    expect(recentOpenOf('', 1_100)).toBeNull()
    expect(recentOpenOf('ws:e', 1_100)).toBeNull()
  })
})

describe('applyRecentOpen', () => {
  it('无最近打开时原样返回恢复结果', () => {
    const tabs = [{ path: 'a.cs' }]
    const merged = applyRecentOpen(tabs, 'a.cs', null)
    expect(merged.tabs).toBe(tabs)
    expect(merged.active).toBe('a.cs')
  })

  it('最近打开不在页签表时插入并设为活动页', () => {
    const merged = applyRecentOpen([{ path: 'GameInitState.cs' }], 'GameInitState.cs', 'Boot/BootText.cs')
    expect(merged.tabs.map((tab) => tab.path)).toEqual(['GameInitState.cs', 'Boot/BootText.cs'])
    expect(merged.active).toBe('Boot/BootText.cs')
  })

  it('最近打开已在页签表时只切活动页，不重复插入', () => {
    const merged = applyRecentOpen([{ path: 'a.cs' }, { path: 'b.cs' }], 'a.cs', 'b.cs')
    expect(merged.tabs.map((tab) => tab.path)).toEqual(['a.cs', 'b.cs'])
    expect(merged.active).toBe('b.cs')
  })

  it('插入位置跟随固定分区（插到最后一个固定页签之后）', () => {
    const merged = applyRecentOpen([{ path: 'a.cs', pinned: true }, { path: 'b.cs' }], 'b.cs', 'c.cs')
    expect(merged.tabs.map((tab) => tab.path)).toEqual(['a.cs', 'c.cs', 'b.cs'])
  })

  it('无固定页签时追加末尾', () => {
    const merged = applyRecentOpen([{ path: 'a.cs' }], 'a.cs', 'c.cs')
    expect(merged.tabs.map((tab) => tab.path)).toEqual(['a.cs', 'c.cs'])
  })
})
