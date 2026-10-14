/** Shared nonmodal geometry and bounded stacking. @author ddj 2026年10月14号 */
import { clampFloat } from './editorLayout.js'
import type { FloatRect } from './editorLayout.js'

const windows: string[] = []
const listeners = new Set<() => void>()
let version = 0

/** @private @author ddj 2026年10月14号 Notify every mounted window after an order change. */
function notify(): void { version += 1; for (const listener of listeners) listener() }
/** @public @author ddj 2026年10月14号 @param listener Order observer. @returns Unsubscribe callback. */
export function watchFloats(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
/** @public @author ddj 2026年10月14号 @returns Stable external-store revision. */
export function floatVersion(): number { return version }
/** @public @author ddj 2026年10月14号 @param id Window identity. Bring forward without exceeding modal layers. */
export function raiseFloat(id: string): void {
  const index = windows.indexOf(id)
  if (index === windows.length - 1 && index >= 0) return
  if (index >= 0) windows.splice(index, 1)
  windows.push(id)
  notify()
}
/** @public @author ddj 2026年10月14号 @param id Unmounted window identity. */
export function dropFloat(id: string): void {
  const index = windows.indexOf(id)
  if (index < 0) return
  windows.splice(index, 1)
  notify()
}
/** @public @author ddj 2026年10月14号 @param id Window identity. @returns Layer below menus/modals (190+). */
export function floatLayer(id: string): number {
  return 60 + Math.floor(120 * Math.max(0, windows.indexOf(id)) / Math.max(1, windows.length))
}
/** @public @author ddj 2026年10月14号 @param width Preferred width. @param height Preferred height. @param vw Viewport width. @param vh Viewport height. @returns Centered, reachable bounds. */
export function initialFloat(width: number, height: number, vw: number, vh: number): FloatRect {
  return clampFloat({ width, height, left: (vw - width) / 2, top: (vh - height) / 2 }, vw, vh)
}
/** @public @author ddj 2026年10月14号 @param rect Gesture origin. @param dx Horizontal delta. @param dy Vertical delta. @param sizing Resize instead of move. @param vw Viewport width. @param vh Viewport height. @returns Clamped next bounds. */
export function moveFloat(rect: FloatRect, dx: number, dy: number, sizing: boolean, vw: number, vh: number): FloatRect {
  const next = sizing ? { ...rect, width: rect.width + dx, height: rect.height + dy }
    : { ...rect, left: rect.left + dx, top: rect.top + dy }
  return clampFloat(next, vw, vh)
}
/** @public @author ddj 2026年10月14号 @param target Key target. @returns Whether native text/control navigation owns the key. */
export function inputOwnsKey(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"], .monaco-editor')
}
