/**
 * 原生 SVN 更新窗口的纯状态、虚拟列表与右键动作测试。
 * @author ddj 2026年09月24号
 */
import { describe, expect, it } from 'vitest'
import type { SvnUpdateRow } from '../src/shared/svn.js'
import { sameUpdateOwner, updateActs, updateCloseMode, updateDone, updateLocked, updateParent, updateRange, updateReady, updateType } from '../src/client/ui/svnUpdateModel.js'

const row: SvnUpdateRow = { seq: 1, action: 'U', path: 'src/a.cs', relPath: 'src/a.cs', label: '已更新', raw: 'U    src/a.cs' }

describe('SVN 更新窗口数据逻辑', () => {
  it('大列表只渲染视口附近条目，边界不会越界', () => {
    expect(updateRange(4000, 0, 500, 28)).toEqual({ start: 0, end: 26 })
    expect(updateRange(4000, 3000, 500, 28).end - updateRange(4000, 3000, 500, 28).start).toBeLessThan(50)
    expect(updateRange(4, 1000, 500, 28)).toEqual({ start: 4, end: 4 })
  })

  it('运行中、取消中不能关闭，失败和取消都为终态', () => {
    expect(updateDone('starting')).toBe(false)
    expect(updateDone('cancelling')).toBe(false)
    expect(updateDone('completed')).toBe(true)
    expect(updateDone('failed')).toBe(true)
    expect(updateDone('cancelled')).toBe(true)
  })

  it('右键文件操作只作用于更新完成且真实存在的工作区文件', () => {
    expect(updateActs(row, 'running', 'file', 42).open).toBe(false)
    expect(updateActs(row, 'completed', 'loading', 42).parent).toBe(true)
    expect(updateActs(row, 'completed', 'file', 42)).toMatchObject({ compare: true, open: true, log: true, parent: true, copy: true })
    expect(updateActs({ ...row, action: 'D' }, 'completed', 'missing', 42).open).toBe(false)
    expect(updateActs({ ...row, relPath: null }, 'completed', 'file', 42).parent).toBe(false)
  })

  it('MIME 仅按已知扩展名推断；二进制与无修订号不开放文本比较', () => {
    expect(updateType('level.bytes')).toBe('application/octet-stream')
    expect(updateType('Sprite.png.meta')).toBe('')
    expect(updateActs({ ...row, path: 'level.bytes' }, 'completed', 'file', 42).compare).toBe(false)
    expect(updateActs(row, 'completed', 'file', null).compare).toBe(false)
  })

  it('后台已完成但仍有结果页待取时不能提前显示完成', () => {
    expect(updateReady('completed', true)).toBe(false)
    expect(updateReady('completed', false)).toBe(true)
    expect(updateReady('running', false)).toBe(false)
  })

  it('运行中断连可明确关闭，菜单或二级弹窗打开时 Esc 不关闭父窗', () => {
    expect(updateCloseMode(false, '连接失败', true, false)).toEqual({ passive: false, explicit: true, confirm: true })
    expect(updateCloseMode(false, '启动失败', false, false)).toEqual({ passive: true, explicit: true, confirm: false })
    expect(updateCloseMode(true, '', true, true).passive).toBe(false)
    expect(updateCloseMode(true, '', true, false).passive).toBe(true)
  })

  it('更新窗口只在原会话与原工作区挂载', () => {
    const dialog = { sessionId: 's1', scope: '/wc' }
    expect(sameUpdateOwner(dialog, 's1', '/wc')).toBe(true)
    expect(sameUpdateOwner(dialog, 's2', '/wc')).toBe(false)
    expect(sameUpdateOwner(dialog, 's1', '/other')).toBe(false)
  })

  it('只有失败于工作副本锁定时才引导清理，其他失败与终态不误报', () => {
    expect(updateLocked({ phase: 'failed', error: "SVN 更新失败（退出码 1）：svn: E155037: Previous operation has not finished; run 'cleanup' if it was interrupted" })).toBe(true)
    expect(updateLocked({ phase: 'failed', error: 'svn: E155004: Working copy locked' })).toBe(true)
    expect(updateLocked({ phase: 'failed', rawTail: "svn: E155037: Previous operation has not finished; run 'cleanup' if it was interrupted" })).toBe(true)
    expect(updateLocked({ phase: 'failed', error: 'svn: E170013: Unable to connect to a repository' })).toBe(false)
    expect(updateLocked({ phase: 'completed', error: 'E155037' })).toBe(false)
    expect(updateLocked({ phase: 'cancelling', error: 'E155037' })).toBe(false)
    expect(updateLocked(null)).toBe(false)
  })

  it('根文件的父目录是工作区根', () => {
    expect(updateParent('a.cs')).toBe('')
    expect(updateParent('src/sub/a.cs')).toBe('src/sub')
  })
})
