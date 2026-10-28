/**
 * client reviewBar 纯函数测试（不触 DOM/RPC）。
 * 作者 ddj 2026年10月27号
 */
import { describe, expect, it } from 'vitest'
import {
  SESSION_DOWN_NOTICE, SIDECAR_KEEP_TITLE, SIDECAR_LABEL, SIDECAR_LABEL_TITLE, SIDECAR_UNDO_TITLE,
  officialDownView, reviewBarView,
} from '../src/client/reviewBar.js'

const base = { jumps: 0, stale: 0, index: 0, ready: true, pendingRecords: 1, canKeep: true }

describe('reviewBarView 载入期', () => {
  it('内容未就绪时不断言差异失效', () => {
    const view = reviewBarView({ ...base, ready: false, stale: 6 })
    expect(view.position).toBe('载入中')
    expect(view.notice).toBe('')
    expect(view.navPrevTitle).toBe('文件载入中')
    expect(view.navNextTitle).toBe('文件载入中')
  })
})

describe('reviewBarView 可跳转', () => {
  it('位置按可定位块数而非记录数', () => {
    const view = reviewBarView({ ...base, jumps: 6, index: 1 })
    expect(view.position).toBe('2 / 6')
    expect(view.notice).toBe('')
    expect(view.navNextTitle).toBe('下一个差异')
  })
  it('部分失效时提示可见跳转数', () => {
    const view = reviewBarView({ ...base, jumps: 4, stale: 2, index: 0 })
    expect(view.position).toBe('1 / 4')
    expect(view.noticeTone).toBe('info')
    expect(view.notice).toContain('2 处历史差异无法定位')
    expect(view.notice).toContain('其余 4 处可跳转')
  })
  it('越界索引钳制到最后一块', () => {
    expect(reviewBarView({ ...base, jumps: 3, index: 5 }).position).toBe('3 / 3')
  })
})

describe('reviewBarView 全部失效', () => {
  it('给出 Keep 结案叙事', () => {
    const view = reviewBarView({ ...base, stale: 6 })
    expect(view.position).toBe('无可跳转')
    expect(view.noticeTone).toBe('warn')
    expect(view.notice).toContain('均已不在当前文件中')
    expect(view.notice).toContain('Keep')
    expect(view.navNextTitle).toBe('该记录的改动已不在当前文件中，无可跳转差异')
  })
  it('可 Keep 时说明只标记已采纳', () => {
    expect(reviewBarView({ ...base, stale: 6 }).keepHint).toContain('不改写磁盘')
  })
  it('不可 Keep 时回退默认提示', () => {
    expect(reviewBarView({ ...base, stale: 6, canKeep: false }).keepHint).toBe('保留当前记录的未处理修改')
  })
})

describe('reviewBarView 无差异', () => {
  it('给出中性占位与原因', () => {
    const view = reviewBarView({ ...base, pendingRecords: 0 })
    expect(view.position).toBe('—')
    expect(view.notice).toBe('')
    expect(view.navPrevTitle).toBe('当前文件没有可定位差异')
  })
})

describe('reviewBarView 输入归一', () => {
  it('负数与非数字计数归零', () => {
    const view = reviewBarView({ ...base, jumps: -3, stale: Number.NaN, index: Number.NaN })
    expect(view.position).toBe('—')
    expect(view.notice).toBe('')
  })
  it('待审计数标题附带可跳转数', () => {
    expect(reviewBarView({ ...base, jumps: 2 }).pendingTitle).toBe('1 条官方待审记录，本文件可跳转 2 处')
  })
})

describe('officialDownView 官方通道不可用', () => {
  it('空错误表示通道正常，不渲染提示', () => {
    expect(officialDownView('')).toBeNull()
    expect(officialDownView(undefined)).toBeNull()
    expect(officialDownView(null)).toBeNull()
  })
  it('会话缺失给出可读原因与重试文案', () => {
    const view = officialDownView('会话不存在')
    expect(view).not.toBeNull()
    expect(view?.text.startsWith('官方差异不可用：')).toBe(true)
    expect(view?.text).toContain('会话在当前端不可用')
    expect(view?.retryLabel).toBe('重试')
  })
  it('未提供官方导航的宿主提示原样透传', () => {
    const view = officialDownView('Host 尚未提供官方文件导航，请重启加载新版插件')
    expect(view?.text).toBe('官方差异不可用：Host 尚未提供官方文件导航，请重启加载新版插件')
  })
})

describe('非官方栏标识与作用域说明', () => {
  it('标识用日常说法，不出现内部术语', () => {
    expect(SIDECAR_LABEL).toBe('历史改动')
    expect(SIDECAR_LABEL).not.toContain('侧车')
  })
  it('Keep/Undo 说明作用域只到历史记录', () => {
    expect(SIDECAR_KEEP_TITLE).toContain('不影响官方审查')
    expect(SIDECAR_KEEP_TITLE).toContain('不改写磁盘')
    expect(SIDECAR_UNDO_TITLE).toContain('不影响官方审查')
    expect(SIDECAR_LABEL_TITLE).toContain('官方审查列表')
  })
  it('会话未激活用中性说明，不出现报错口吻', () => {
    expect(SESSION_DOWN_NOTICE).toContain('仍可查看')
    expect(SESSION_DOWN_NOTICE).not.toContain('错误')
    expect(SESSION_DOWN_NOTICE).not.toContain('不可用：该会话可能')
  })
})
