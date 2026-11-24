import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMPOSER_BAR_SLOT, composerCrashed, recoverComposer, watchComposer } from '../src/client/composerState.js'

/** @private @author ddj 2026年11月23号 @description Minimal document whose selector hit is switchable. @returns Fixture controls. */
function fixture(initial = false) {
  const state = { hit: initial }
  const doc = {
    body: {},
    querySelector: vi.fn((selector: string) => {
      expect(selector).toContain(COMPOSER_BAR_SLOT)
      return state.hit ? { selector } : null
    }),
  } as unknown as Document
  return { doc, state }
}

/** @private @author ddj 2026年11月23号 @description Install a fake MutationObserver and expose its trigger. @returns Trigger and restore. */
function observerFixture() {
  let fire: (() => void) | null = null
  const original = globalThis.MutationObserver
  class FakeObserver {
    /** @author ddj 2026年11月23号 @param callback Mutation delivery. */
    constructor(callback: () => void) { fire = callback }
    /** @author ddj 2026年11月23号 */
    observe(): void {}
    /** @author ddj 2026年11月23号 */
    disconnect(): void { fire = null }
  }
  globalThis.MutationObserver = FakeObserver as unknown as typeof MutationObserver
  return {
    trigger: () => fire?.(),
    restore: () => { globalThis.MutationObserver = original },
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('composerCrashed', () => {
  it('崩溃占位存在时为 true', () => {
    expect(composerCrashed(fixture(true).doc)).toBe(true)
  })

  it('没有崩溃占位时为 false', () => {
    expect(composerCrashed(fixture(false).doc)).toBe(false)
  })

  it('没有文档时按未崩溃处理', () => {
    expect(composerCrashed(undefined)).toBe(false)
  })
})

describe('watchComposer', () => {
  it('首次立刻回调当前状态，翻转才再次回调', () => {
    const fake = observerFixture()
    const { doc, state } = fixture(false)
    const seen: boolean[] = []
    const off = watchComposer(doc, (crashed) => seen.push(crashed))

    fake.trigger()
    state.hit = true
    fake.trigger()
    fake.trigger()
    state.hit = false
    fake.trigger()

    expect(seen).toEqual([false, true, false])
    off()
    fake.restore()
  })

  it('解绑后不再回调', () => {
    const fake = observerFixture()
    const { doc, state } = fixture(false)
    const seen: boolean[] = []
    const off = watchComposer(doc, (crashed) => seen.push(crashed))
    off()
    state.hit = true
    fake.trigger()
    expect(seen).toEqual([false])
    fake.restore()
  })

  it('没有文档时返回空操作', () => {
    expect(typeof watchComposer(undefined, () => {})).toBe('function')
  })
})

describe('recoverComposer', () => {
  it('派发既有的受保护刷新命令', () => {
    const dispatch = vi.fn()
    vi.stubGlobal('window', { dispatchEvent: dispatch })
    vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} })

    recoverComposer()

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0].type).toBe('edrv.command.reloadWindow')
    vi.unstubAllGlobals()
  })
})
