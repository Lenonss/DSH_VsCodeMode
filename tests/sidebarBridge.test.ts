/**
 * client sidebarBridge 纯函数测试（不触 DOM/窗口事件）。
 * 作者 ddj 2026-08-25
 */
import { describe, expect, it } from 'vitest'
import {
  detectSidebarService,
  getSidePending,
  resolveInitialOpen,
  routeSideEditor,
  setEnsureSideEditor,
  setSideEditorMounted,
  setSidePending,
  stagePendingSideOpen,
  takePendingSideOpen,
  SIDE_TAB_ID,
  SIDE_TAB_TITLE,
} from '../src/client/sidebarBridge.js'

describe('resolveInitialOpen', () => {
  it('tab.path 优先作为初始打开路径', () => {
    expect(resolveInitialOpen({ path: 'src/a.ts', meta: { openPath: 'src/b.ts' } }))
      .toEqual({ path: 'src/a.ts', focusDiff: false })
  })
  it('无 path 时读 meta.openPath 与 focusDiff', () => {
    expect(resolveInitialOpen({ meta: { openPath: 'src/b.ts', focusDiff: true } }))
      .toEqual({ path: 'src/b.ts', focusDiff: true })
  })
  it('空 tab/损坏 meta 安全返回空请求', () => {
    expect(resolveInitialOpen(null)).toEqual({ path: null, focusDiff: false })
    expect(resolveInitialOpen({})).toEqual({ path: null, focusDiff: false })
    expect(resolveInitialOpen({ meta: 42 })).toEqual({ path: null, focusDiff: false })
  })
})

describe('detectSidebarService', () => {
  it('缺服务/缺 registerTab 或 openTab 时返回 undefined', () => {
    expect(detectSidebarService({ get: () => undefined })).toBeUndefined()
    expect(detectSidebarService({ get: () => ({ registerTab: () => () => {} }) })).toBeUndefined()
    expect(detectSidebarService({ get: () => ({ openTab: () => {} }) })).toBeUndefined()
  })
  it('get 抛错时安全降级', () => {
    expect(detectSidebarService({ get: () => { throw new Error('no') } })).toBeUndefined()
  })
  it('完整服务通过探测', () => {
    const service = { registerTab: () => () => {}, openTab: () => {} }
    expect(detectSidebarService({ get: () => service })).toBe(service)
  })
})

describe('sidePending', () => {
  it('写入/读取/清零', () => {
    expect(getSidePending('s-pending-test')).toBe(0)
    setSidePending('s-pending-test', 3)
    expect(getSidePending('s-pending-test')).toBe(3)
    setSidePending('s-pending-test', 0)
    expect(getSidePending('s-pending-test')).toBe(0)
    setSidePending('s-pending-test', -2)
    expect(getSidePending('s-pending-test')).toBe(0)
    setSidePending('', 5)
    expect(getSidePending('')).toBe(0)
  })
})

describe('routeSideEditor', () => {
  it('未注册路由返回 false', () => {
    setEnsureSideEditor(null)
    expect(routeSideEditor('a.ts', false)).toBe(false)
  })
  it('路由函数抛错时返回 false', () => {
    setEnsureSideEditor(() => { throw new Error('boom') })
    expect(routeSideEditor('a.ts', true)).toBe(false)
    setEnsureSideEditor(null)
  })
  it('注册后透传参数并返回路由结果', () => {
    const calls = []
    setEnsureSideEditor((path, focusDiff) => { calls.push([path, focusDiff]); return true })
    expect(routeSideEditor('a.ts', true)).toBe(true)
    expect(calls).toEqual([['a.ts', true]])
    setEnsureSideEditor(null)
  })
})

describe('待消费打开 handoff', () => {
  it('未暂存/会话不匹配时 take 返回 null 且不消费', () => {
    expect(takePendingSideOpen('s-handoff-a')).toBeNull()
    stagePendingSideOpen('s-handoff-a', 'a.ts', true)
    expect(takePendingSideOpen('s-handoff-b')).toBeNull()
    expect(takePendingSideOpen('s-handoff-a')).toEqual({ path: 'a.ts', focusDiff: true })
    expect(takePendingSideOpen('s-handoff-a')).toBeNull()
  })
  it('暂存覆盖与非法会话忽略', () => {
    stagePendingSideOpen('s-handoff-a', 'first.ts', false)
    stagePendingSideOpen('s-handoff-a', 'second.ts', true)
    expect(takePendingSideOpen('s-handoff-a')).toEqual({ path: 'second.ts', focusDiff: true })
    stagePendingSideOpen('', 'x.ts', true)
    expect(takePendingSideOpen('')).toBeNull()
  })
  it('挂载标志可读写', () => {
    setSideEditorMounted(true)
    setSideEditorMounted(false)
  })
})

describe('侧栏 Tab 常量', () => {
  it('Tab id 与标题稳定', () => {
    expect(SIDE_TAB_ID).toBe('edrv-editor')
    expect(SIDE_TAB_TITLE).toBe('文件编辑')
  })
})
