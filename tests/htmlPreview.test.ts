/**
 * client HTML 预览判定与官方 HTML 渲染器探针测试（纯逻辑 + 假 ctx / 手动调度）。
 * @author ddj 2026年11月21号
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  DOCUMENT_PREVIEWS_SERVICE,
  hasHtmlPreviewBody,
  hasOfficialHtmlPreview,
  installHtmlPreviewProbe,
  isHtmlPath,
  resetHtmlPreviewProbe,
  setOfficialHtmlPreview,
} from '../src/client/htmlPreview.js'

/** 手动调度收集器：逐个 flush 已排队的回调。 */
function collector(): { schedule: (fn: () => void, ms: number) => void; flush: () => void; pending: () => number } {
  const queue: Array<() => void> = []
  return {
    schedule: (fn) => { queue.push(fn) },
    flush: () => { const next = queue.shift(); if (next) next() },
    pending: () => queue.length,
  }
}

/** 只暴露 documentPreviews 的假 ctx（getter 便于中途切换服务形态）。 */
function ctxOf(getter: () => unknown): { get: (name: string) => unknown } {
  return { get: (name) => (name === DOCUMENT_PREVIEWS_SERVICE ? getter() : undefined) }
}

afterEach(() => { resetHtmlPreviewProbe() })

describe('isHtmlPath', () => {
  it('html/htm 命中，大小写与反斜杠不敏感', () => {
    expect(isHtmlPath('a.html')).toBe(true)
    expect(isHtmlPath('A.HTM')).toBe(true)
    expect(isHtmlPath('dir\\sub\\x.Html')).toBe(true)
    expect(isHtmlPath('dir/sub/x.htm')).toBe(true)
  })

  it('非 HTML/无后缀/隐藏文件/坏输入不命中', () => {
    expect(isHtmlPath('a.htmlx')).toBe(false)
    expect(isHtmlPath('a.md')).toBe(false)
    expect(isHtmlPath('README')).toBe(false)
    expect(isHtmlPath('.html')).toBe(false)
    expect(isHtmlPath('')).toBe(false)
    expect(isHtmlPath(undefined)).toBe(false)
    expect(isHtmlPath(42)).toBe(false)
  })
})

describe('hasHtmlPreviewBody', () => {
  it('识别 html/htm body（含带点与大小写）', () => {
    expect(hasHtmlPreviewBody([{ id: 'x', extensions: ['md', 'markdown'] }])).toBe(false)
    expect(hasHtmlPreviewBody([{ id: 'x', extensions: ['html', 'htm'] }])).toBe(true)
    expect(hasHtmlPreviewBody([{ extensions: ['.HTML'] }])).toBe(true)
    expect(hasHtmlPreviewBody([{ extensions: ['htm'] }])).toBe(true)
  })

  it('畸形快照一律按没有处理', () => {
    expect(hasHtmlPreviewBody(null)).toBe(false)
    expect(hasHtmlPreviewBody(undefined)).toBe(false)
    expect(hasHtmlPreviewBody({})).toBe(false)
    expect(hasHtmlPreviewBody([null, 3, { extensions: 'html' }, { extensions: [1, null] }])).toBe(false)
  })
})

describe('installHtmlPreviewProbe', () => {
  it('服务命中即置真，卸载复位并退订', () => {
    let unsubscribed = false
    const service = {
      getSnapshot: () => [{ extensions: ['html'] }],
      subscribe: () => () => { unsubscribed = true },
    }
    const dispose = installHtmlPreviewProbe(ctxOf(() => service), { schedule: () => {} })
    expect(hasOfficialHtmlPreview()).toBe(true)
    dispose()
    expect(hasOfficialHtmlPreview()).toBe(false)
    expect(unsubscribed).toBe(true)
  })

  it('服务缺失时有界重试，命中后不再调度', () => {
    const timer = collector()
    let present = false
    const service = { getSnapshot: () => (present ? [{ extensions: ['html'] }] : []) }
    const dispose = installHtmlPreviewProbe(ctxOf(() => service), { schedule: timer.schedule, attempts: 3, intervalMs: 5 })
    expect(hasOfficialHtmlPreview()).toBe(false)
    expect(timer.pending()).toBe(1)
    present = true
    timer.flush()
    expect(hasOfficialHtmlPreview()).toBe(true)
    expect(timer.pending()).toBe(0)
    timer.flush()
    expect(hasOfficialHtmlPreview()).toBe(true)
    dispose()
  })

  it('重试耗尽后停止（不无限调度）', () => {
    const timer = collector()
    const dispose = installHtmlPreviewProbe(ctxOf(() => undefined), { schedule: timer.schedule, attempts: 2, intervalMs: 5 })
    expect(timer.pending()).toBe(1)
    timer.flush()
    expect(timer.pending()).toBe(0)
    timer.flush()
    expect(timer.pending()).toBe(0)
    expect(hasOfficialHtmlPreview()).toBe(false)
    dispose()
  })

  it('订阅回调可让结论随官方快照变化', () => {
    let present = false
    let listener: (() => void) | null = null
    const service = {
      getSnapshot: () => (present ? [{ extensions: ['html', 'htm'] }] : []),
      subscribe: (fn: () => void) => { listener = fn; return () => { listener = null } },
    }
    const dispose = installHtmlPreviewProbe(ctxOf(() => service), { schedule: () => {} })
    expect(hasOfficialHtmlPreview()).toBe(false)
    present = true
    expect(listener).not.toBeNull()
    listener!()
    expect(hasOfficialHtmlPreview()).toBe(true)
    dispose()
  })

  it('ctx 抛错/服务异常不抛出，结论保持不可用', () => {
    const throwCtx = { get: () => { throw new Error('boom') } }
    expect(() => installHtmlPreviewProbe(throwCtx, { schedule: () => {} })).not.toThrow()
    expect(hasOfficialHtmlPreview()).toBe(false)
    const broken = { getSnapshot: () => { throw new Error('snapshot') }, subscribe: () => () => {} }
    expect(() => installHtmlPreviewProbe(ctxOf(() => broken), { schedule: () => {} })).not.toThrow()
    expect(hasOfficialHtmlPreview()).toBe(false)
  })
})

describe('setOfficialHtmlPreview', () => {
  it('只接受严格 true', () => {
    setOfficialHtmlPreview(true)
    expect(hasOfficialHtmlPreview()).toBe(true)
    setOfficialHtmlPreview(false)
    expect(hasOfficialHtmlPreview()).toBe(false)
    setOfficialHtmlPreview(1 as unknown as boolean)
    expect(hasOfficialHtmlPreview()).toBe(false)
  })
})
