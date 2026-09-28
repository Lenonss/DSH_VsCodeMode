import { describe, expect, it, vi } from 'vitest'
import { eventModifiers, KeyCapture, startRecording } from '../src/client/shortcutRecorder.js'
import type { RecordHooks } from '../src/client/shortcutRecorder.js'
import type { ShortcutsServiceLike } from '../src/client/shortcutsOfficial.js'

/**
 * Create an acknowledged native service and a physical-binding validator.
 * @author ddj 2026年09月28号
 * @param runtime Official runtime.
 * @param platform Official receiving platform.
 * @returns Service, lifecycle hooks and observable native interception state.
 */
function setup(runtime = 'desktop', platform = 'windows') {
  const native = { recording: false }
  const hooks: RecordHooks = { ready: vi.fn(), save: vi.fn(), cancel: vi.fn(), error: vi.fn() }
  const service = {
    runtime, platform,
    recording: vi.fn(async (active) => { native.recording = active }),
    describeBinding: vi.fn((binding) => {
      const codes = [binding.code, binding.secondCode].filter(Boolean).sort()
      return { binding: { ...binding, code: codes[0], ...(codes[1] ? { secondCode: codes[1] } : {}) }, issue: null, conflicts: [], keys: [] }
    }),
  } as unknown as ShortcutsServiceLike
  return { service, hooks, native }
}

/**
 * Construct a real cancelable Event with physical keyboard fields in node.
 * @author ddj 2026年09月28号
 * @param type DOM keyboard event type.
 * @param fields Keyboard facts.
 * @returns Event accepted by EventTarget and recorder.
 */
function key(type = 'keydown', fields: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return Object.assign(new Event(type, { cancelable: true }), {
    code: 'KeyS', key: 's', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false,
    isComposing: false, repeat: false, getModifierState: () => false, ...fields,
  }) as KeyboardEvent
}

describe('physical recorder gestures', () => {
  it('records physical Control and Meta independently and together', () => {
    expect(eventModifiers(key())).toEqual(['control'])
    expect(eventModifiers(key('keydown', { ctrlKey: false, metaKey: true }))).toEqual(['meta'])
    expect(eventModifiers(key('keydown', { metaKey: true, altKey: true, shiftKey: true }))).toEqual(['control', 'alt', 'shift', 'meta'])
  })

  it.each(['windows', 'macos'])('records a desktop pair on %s at release only', (platform) => {
    const { service, hooks } = setup('desktop', platform)
    const capture = new KeyCapture(service, hooks)
    capture.down(key())
    capture.down(key('keydown', { code: 'KeyD', key: 'd' }))
    expect(hooks.save).not.toHaveBeenCalled()
    capture.up(key('keyup'))
    capture.up(key('keyup', { code: 'KeyD' }))
    expect(hooks.save).toHaveBeenCalledExactlyOnceWith({ code: 'KeyD', secondCode: 'KeyS', modifiers: ['control'] })
  })

  it.each(['web:windows', 'web:macos', 'web:linux', 'desktop:linux'])('does not invent secondCode for %s', (profile) => {
    const [runtime, platform] = profile.split(':')
    const { service, hooks } = setup(runtime, platform)
    const capture = new KeyCapture(service, hooks)
    capture.down(key())
    capture.down(key('keydown', { code: 'KeyD', key: 'd' }))
    capture.up(key('keyup', { code: 'KeyD' }))
    expect(hooks.save).toHaveBeenCalledExactlyOnceWith({ code: 'KeyD', modifiers: ['control'] })
  })

  it.each([
    { isComposing: true }, { keyCode: 229 }, { getModifierState: () => true }, { key: 'Dead' },
  ])('leaves guarded IME/dead/AltGraph input untouched: %j', (fields) => {
    const { service, hooks } = setup()
    const capture = new KeyCapture(service, hooks)
    const event = key('keydown', fields)
    capture.down(event); capture.up(key('keyup'))
    expect(event.defaultPrevented).toBe(false)
    expect(hooks.save).not.toHaveBeenCalled()
  })

  it('records the official macOS Web Meta+Alt+N dead-key exception', () => {
    const { service, hooks } = setup('web', 'macos')
    const capture = new KeyCapture(service, hooks)
    capture.down(key('keydown', { key: 'Dead', code: 'KeyN', ctrlKey: false, metaKey: true, altKey: true }))
    capture.up(key('keyup', { code: 'KeyN' }))
    expect(hooks.save).toHaveBeenCalledWith({ code: 'KeyN', modifiers: ['alt', 'meta'] })
  })

  it('drops a pending pair on composition, blur, or a third main key', () => {
    const { service, hooks } = setup()
    const capture = new KeyCapture(service, hooks)
    capture.down(key()); capture.reset(true); capture.down(key()); capture.up(key('keyup'))
    expect(hooks.save).not.toHaveBeenCalled()
    capture.reset(); capture.down(key()); capture.reset(); capture.up(key('keyup'))
    expect(hooks.save).not.toHaveBeenCalled()
    capture.down(key()); capture.down(key('keydown', { code: 'KeyD' })); capture.down(key('keydown', { code: 'KeyF' }))
    capture.up(key('keyup'))
    expect(hooks.save).not.toHaveBeenCalled()
    expect(hooks.error).toHaveBeenCalledOnce()
  })

  it('does not clear preferences for a modified Delete binding', () => {
    const { service, hooks } = setup()
    const capture = new KeyCapture(service, hooks)
    capture.down(key('keydown', { code: 'Delete', key: 'Delete' }))
    capture.up(key('keyup', { code: 'Delete' }))
    expect(hooks.save).toHaveBeenCalledWith({ code: 'Delete', modifiers: ['control'] })
  })
})

describe('native recording lifecycle', () => {
  it('waits for recording(true), then restores native interception after save', async () => {
    const { service, hooks, native } = setup()
    let acknowledge!: () => void
    vi.mocked(service.recording).mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve }))
    const target = new EventTarget()
    const dispose = startRecording(service, target, hooks)
    target.dispatchEvent(key()); target.dispatchEvent(key('keyup'))
    expect(hooks.save).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'))
    acknowledge()
    await vi.waitFor(() => expect(hooks.ready).toHaveBeenCalledOnce())
    target.dispatchEvent(key()); target.dispatchEvent(key('keyup'))
    await vi.waitFor(() => expect(service.recording).toHaveBeenLastCalledWith(false))
    expect(hooks.save).toHaveBeenCalledOnce()
    dispose(); target.dispatchEvent(key()); target.dispatchEvent(key('keyup'))
    expect(hooks.save).toHaveBeenCalledOnce()
    expect(native.recording).toBe(false)
  })

  it('unmount during native startup restores false after late completion', async () => {
    const { service, hooks } = setup()
    let acknowledge!: () => void
    vi.mocked(service.recording).mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve }))
    const dispose = startRecording(service, new EventTarget(), hooks)
    dispose(); dispose()
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'))
    acknowledge()
    await vi.waitFor(() => expect(service.recording).toHaveBeenLastCalledWith(false))
    expect(hooks.ready).not.toHaveBeenCalled()
    expect(service.recording).toHaveBeenCalledTimes(2)
  })

  it('failure restores false and reports without enabling capture', async () => {
    const { service, hooks } = setup()
    vi.mocked(service.recording).mockRejectedValueOnce(new Error('native unavailable'))
    const dispose = startRecording(service, new EventTarget(), hooks)
    await vi.waitFor(() => expect(service.recording).toHaveBeenLastCalledWith(false))
    expect(hooks.ready).not.toHaveBeenCalled()
    expect(hooks.error).toHaveBeenCalledOnce()
    dispose()
  })

  it.each(['Escape', 'Backspace'])('restores native interception on bare %s', async (name) => {
    const { service, hooks, native } = setup()
    const target = new EventTarget()
    const dispose = startRecording(service, target, hooks)
    await vi.waitFor(() => expect(hooks.ready).toHaveBeenCalledOnce())
    target.dispatchEvent(key('keydown', { key: name, code: name, ctrlKey: false }))
    await vi.waitFor(() => expect(native.recording).toBe(false))
    expect(name === 'Escape' ? hooks.cancel : hooks.save).toHaveBeenCalledOnce()
    dispose()
  })

  it('serializes old cleanup before a replacement recorder starts', async () => {
    const { service, hooks } = setup()
    let acknowledge!: () => void
    vi.mocked(service.recording).mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve }))
    const old = startRecording(service, new EventTarget(), hooks)
    old()
    const nextHooks = setup().hooks
    vi.resetModules()
    const reloaded = await import('../src/client/shortcutRecorder.js')
    const next = reloaded.startRecording(service, new EventTarget(), nextHooks)
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'))
    acknowledge()
    await vi.waitFor(() => expect(nextHooks.ready).toHaveBeenCalledOnce())
    expect(vi.mocked(service.recording).mock.calls.map(([active]) => active)).toEqual([true, false, true])
    expect(hooks.ready).not.toHaveBeenCalled()
    next()
    await vi.waitFor(() => expect(service.recording).toHaveBeenLastCalledWith(false))
  })
})
