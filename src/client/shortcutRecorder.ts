import type { OfficialBinding, OfficialModifier } from '../shared/keybindings.js'
import type { ShortcutsServiceLike } from './shortcutsOfficial.js'

export interface RecordHooks {
  ready(): void
  save(binding: OfficialBinding | null): void
  cancel(): void
  error(error: unknown): void
}
const recorderHost = globalThis as typeof globalThis & { __edrvRecording__?: WeakMap<ShortcutsServiceLike, Promise<void>> }
const leases = recorderHost.__edrvRecording__ ??= new WeakMap<ShortcutsServiceLike, Promise<void>>()

/**
 * Serialize native recorder state, including cleanup after a late ready response.
 * @author ddj 2026年09月28号
 * @param service Native/Web shortcut service.
 * @param active Desired native interception state.
 * @returns Completion of the state change; errors remain visible to the caller.
 */
function recordState(service: ShortcutsServiceLike, active: boolean): Promise<void> {
  const prior = leases.get(service) ?? Promise.resolve()
  const next = prior.catch(() => {}).then(() => service.recording(active))
  leases.set(service, next)
  return next
}

/**
 * Read physical modifiers without converting Control or Meta into logical primary.
 * @author ddj 2026年09月28号
 * @param event Keyboard event.
 * @returns Modifiers in official canonical order.
 */
export function eventModifiers(event: KeyboardEvent): OfficialModifier[] {
  const states = { control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey }
  return (Object.keys(states) as Array<keyof typeof states>).filter((key) => states[key])
}

/** Physical key collection; native readiness and listeners are owned by startRecording. */
export class KeyCapture {
  private held = new Set<string>()
  private pending: OfficialBinding | null = null
  private blocked = false
  private dead = false
  private composing = false

  /**
   * Create a physical collector with official platform capabilities.
   * @author ddj 2026年09月28号
   * @param service Official binding validator and profile.
   * @param hooks Completion/error handlers.
   */
  constructor(private service: ShortcutsServiceLike, private hooks: RecordHooks) {}

  /**
   * Reset a gesture on blur or composition transitions.
   * @author ddj 2026年09月28号
   * @param composing Whether IME composition is currently active.
   */
  reset(composing = false): void {
    this.held.clear(); this.pending = null; this.blocked = false; this.dead = false
    this.composing = composing
  }

  /**
   * Collect one physical press; commit only when a constituent key is released.
   * @author ddj 2026年09月28号
   * @param event Keyboard press; guarded IME/AltGraph input is left untouched.
   */
  down(event: KeyboardEvent): void {
    if (this.composing || event.isComposing || event.keyCode === 229 || event.getModifierState?.('AltGraph')) {
      this.pending = null; this.held.clear(); return
    }
    const commandDead = this.service.runtime === 'web' && this.service.platform === 'macos'
      && event.code === 'KeyN' && event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey
    if (event.key === 'Dead' && !commandDead) { this.reset(); this.dead = true; return }
    if (this.dead) { this.dead = false; return }
    event.preventDefault(); event.stopPropagation()
    if (event.repeat) return
    const modifiers = eventModifiers(event)
    if (!modifiers.length && event.key === 'Escape') { this.hooks.cancel(); return }
    if (!modifiers.length && (event.key === 'Backspace' || event.key === 'Delete')) { this.hooks.save(null); return }
    if (/^(Control|Alt|Shift|Meta|AltGraph)(Left|Right)?$/u.test(event.code || event.key)) {
      if (this.pending) this.reset()
      return
    }
    const chords = this.service.runtime === 'desktop' && ['macos', 'windows'].includes(this.service.platform)
    if (chords) this.held.add(event.code)
    if (this.blocked) return
    if (this.held.size > 2) {
      this.pending = null; this.blocked = true; this.hooks.error('最多同时录制两个主键'); return
    }
    const codes = chords ? [...this.held] : [event.code]
    try {
      const probe = this.service.describeBinding({ code: codes[0], modifiers, ...(codes[1] ? { secondCode: codes[1] } : {}) })
      if (!probe.binding || probe.issue) throw new Error(probe.issue ?? 'unsupported-key')
      this.pending = probe.binding
    } catch (error) { this.pending = null; this.hooks.error(error) }
  }

  /**
   * Commit an accepted physical gesture once at release.
   * @author ddj 2026年09月28号
   * @param event Released key or modifier.
   */
  up(event: KeyboardEvent): void {
    this.held.delete(event.code)
    const binding = this.pending
    const modifier = event.code.replace(/(Left|Right)$/u, '').toLowerCase() as OfficialModifier
    if (!binding || !(binding.code === event.code || binding.secondCode === event.code || binding.modifiers.includes(modifier))) return
    this.pending = null
    event.preventDefault(); event.stopPropagation()
    this.hooks.save(binding)
  }
}

/**
 * Protect recording before listening, and restore interception on every exit path.
 * @author ddj 2026年09月28号
 * @param service Official service whose asynchronous native bridge must be ready.
 * @param target Owning window, injectable for lifecycle tests.
 * @param hooks Ready, save, cancel and failure callbacks.
 * @returns Idempotent disposal, safe before readiness and after failure.
 */
export function startRecording(service: ShortcutsServiceLike, target: EventTarget, hooks: RecordHooks): () => void {
  let disposed = false
  let ready = false
  /** @author ddj 2026年09月28号 @param binding Accepted binding; release interception before saving. */
  const save = (binding: OfficialBinding | null): void => { dispose(); hooks.save(binding) }
  /** @author ddj 2026年09月28号 Cancel capture and restore native interception. */
  const cancel = (): void => { dispose(); hooks.cancel() }
  const capture = new KeyCapture(service, { ...hooks, save, cancel })
  /** @author ddj 2026年09月28号 @param event Physical key press. */
  const down = (event: Event): void => { if (ready) capture.down(event as KeyboardEvent) }
  /** @author ddj 2026年09月28号 @param event Physical key release. */
  const up = (event: Event): void => { if (ready) capture.up(event as KeyboardEvent) }
  /** @author ddj 2026年09月28号 Reset incomplete gesture on focus loss. */
  const blur = (): void => capture.reset()
  /** @author ddj 2026年09月28号 Guard the complete IME composition lifecycle. */
  const compose = (): void => capture.reset(true)
  const listeners: Array<[string, EventListener]> = [
    ['keydown', down], ['keyup', up], ['blur', blur], ['compositionstart', compose], ['compositionend', blur],
  ]
  /** @author ddj 2026年09月28号 Release DOM listeners and serialize native restoration. */
  const dispose = (): void => {
    if (disposed) return
    disposed = true; ready = false
    for (const [name, handler] of listeners) target.removeEventListener(name, handler, { capture: true })
    void recordState(service, false).catch(hooks.error)
  }
  /** @author ddj 2026年09月28号 Activate capture only after native acknowledgment. */
  const activate = (): void => {
    if (disposed) return
    ready = true
    for (const [name, handler] of listeners) target.addEventListener(name, handler, { capture: true })
    hooks.ready()
  }
  /** @author ddj 2026年09月28号 @param error Native activation failure. */
  const fail = (error: unknown): void => { if (!disposed) { dispose(); hooks.error(error) } }
  void recordState(service, true).then(activate, fail)
  return dispose
}
