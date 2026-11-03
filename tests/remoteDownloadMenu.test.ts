/**
 * 资源管理器「下载到本机」菜单项单测。
 * 覆盖：仅远程通道可见（文件/文件夹/根空白区分派）、条目文案与排序位置、
 * run 统一委派 downloadTarget（分流逻辑只存在一处）。
 * 下载动作本身不在此测（downloadFile.test.ts 覆盖），故 mock 掉该模块。
 * 作者 ddj 2026年11月03号
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const downloadTargetMock = vi.fn()

vi.mock('../src/client/downloadFile.js', () => ({
  downloadTarget: (...args: unknown[]) => downloadTargetMock(...args),
}))

import { buildTreeMenu, createTreeMenuRegistry } from '../src/client/sidebar/contextMenu.js'
import { createDefaultFileMenuItems } from '../src/client/sidebar/menuItems.js'
import type { TreeMenuItem, TreeMenuTarget } from '../src/client/sidebar/contextMenu.js'
import type { SidebarCtx } from '../src/client/sidebar/types.js'
import { CHANNEL_SEAT, isRemoteChannel } from '../src/shared/remoteChannel.js'

const ctx = { sessionId: 's1', notify: () => {} } as unknown as SidebarCtx

/** 把内置项装入注册表并按目标构建可见菜单（与面板同一路径）。 */
function menuFor(target: TreeMenuTarget): TreeMenuItem[] {
  const registry = createTreeMenuRegistry()
  for (const item of createDefaultFileMenuItems()) registry.register(item)
  return buildTreeMenu(registry, target, ctx)
}

/** 某目标下菜单项 id 列表。 */
function idsFor(target: TreeMenuTarget): string[] {
  return menuFor(target).map((item) => item.id)
}

const FILE: TreeMenuTarget = { path: 'src/index.ts', type: 'file' }
const DIR: TreeMenuTarget = { path: 'src', type: 'directory' }
const ROOT: TreeMenuTarget = { path: '', type: 'directory' }

afterEach(() => {
  vi.unstubAllGlobals()
  downloadTargetMock.mockClear()
})

describe('可见性只看远程通道', () => {
  it('本机页面（无通道 seat）：三种目标都没有该条目', () => {
    vi.stubGlobal('window', {})
    expect(isRemoteChannel()).toBe(false)
    for (const target of [FILE, DIR, ROOT]) {
      expect(idsFor(target)).not.toContain('remote-download')
    }
  })

  it('远程页面（有通道 seat）：三种目标都出现', () => {
    vi.stubGlobal('window', { [CHANNEL_SEAT]: {} })
    expect(isRemoteChannel()).toBe(true)
    for (const target of [FILE, DIR, ROOT]) {
      expect(idsFor(target)).toContain('remote-download')
    }
  })
})

describe('文案与排序', () => {
  it('文件目标直下（无省略号），文件夹与根空白区带省略号（要弹窗）', () => {
    vi.stubGlobal('window', { [CHANNEL_SEAT]: {} })
    const labelOf = (target: TreeMenuTarget): unknown =>
      menuFor(target).find((item) => item.id === 'remote-download')?.label
    expect(labelOf(FILE)).toBe('下载到本机')
    expect(labelOf(DIR)).toBe('下载到本机…')
    expect(labelOf(ROOT)).toBe('下载到本机…')
  })

  it('落在「复制相对路径」之后、「重命名」之前', () => {
    vi.stubGlobal('window', { [CHANNEL_SEAT]: {} })
    const ids = idsFor(FILE)
    expect(ids.indexOf('remote-download')).toBeGreaterThan(ids.indexOf('copy-relative-path'))
    expect(ids.indexOf('remote-download')).toBeLessThan(ids.indexOf('rename'))
  })
})

describe('run 委派', () => {
  it('点击把目标与上下文原样交给 downloadTarget（分流只在一处）', () => {
    vi.stubGlobal('window', { [CHANNEL_SEAT]: {} })
    const registry = createTreeMenuRegistry()
    for (const item of createDefaultFileMenuItems()) registry.register(item)
    const item = registry.get('remote-download')
    expect(item).toBeDefined()
    item?.run(DIR, ctx)
    expect(downloadTargetMock).toHaveBeenCalledWith(DIR, ctx)
  })
})
