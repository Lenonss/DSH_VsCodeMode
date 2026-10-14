/** Internal pointer drag: never converts external text into file paths. @author ddj 2026年10月14号 */
import { clampFloat, type DropTarget, type Edge } from './state/editorLayout.js'

export interface Rect { left: number; top: number; width: number; height: number }
export interface Point { x: number; y: number }
export type TabDrop = DropTarget | { kind: 'reference' }
export interface HitRegion { group: string; rect: Rect; tabs?: { path: string; rect: Rect }[]; tabRect?: Rect; floating?: boolean }
export interface DragHitInput {
  point: Point
  viewport: { width: number; height: number }
  composer?: Rect | null
  regions: HitRegion[]
  blank: boolean
  allowCreate: boolean
}
export interface DragPreview { path: string; point: Point; target: TabDrop | null; rect: Rect | null; label: string }

/** @public @author ddj 2026年10月14号 @param point Pointer position. @param rect View bounds. @returns Containment. */
export function contains(point: Point, rect: Rect): boolean {
  return point.x >= rect.left && point.x <= rect.left + rect.width && point.y >= rect.top && point.y <= rect.top + rect.height
}

/** @public @author ddj 2026年10月14号 @param from Press origin. @param to Current pointer. @returns Whether movement exceeds the drag threshold. */
export function dragStarted(from: Point, to: Point): boolean { return Math.hypot(from.x - to.x, from.y - to.y) >= 6 }

/** @public @author ddj 2026年10月14号 @param point Pointer. @param rect Editor bounds. @returns Nearest edge in a 22% band, or null. */
export function edgeAt(point: Point, rect: Rect): Edge | null {
  const x = (point.x - rect.left) / rect.width, y = (point.y - rect.top) / rect.height
  const distances: [Edge, number][] = [['left', x], ['right', 1 - x], ['top', y], ['bottom', 1 - y]]
  distances.sort((a, b) => a[1] - b[1])
  return distances[0]![1] < 0.22 ? distances[0]![0] : null
}

/** @public @author ddj 2026年10月14号 @param rect Editor bounds. @param edge Split direction. @returns Preview half rectangle. */
export function splitRect(rect: Rect, edge: Edge): Rect {
  const { left, top, width, height } = rect
  if (edge === 'left' || edge === 'right') return { left: left + (edge === 'right' ? width / 2 : 0), top, width: width / 2, height }
  return { left, top: top + (edge === 'bottom' ? height / 2 : 0), width, height: height / 2 }
}

/** @public @author ddj 2026年10月14号 @param input Trusted geometry and blank classification. @returns Drop proposal; no state is mutated. */
export function hitTarget(input: DragHitInput): { target: TabDrop; rect: Rect; label: string } | null {
  const { point, viewport, composer, regions } = input
  if (!contains(point, { left: 0, top: 0, ...viewport })) return null
  if (composer && contains(point, composer)) return { target: { kind: 'reference' }, rect: composer, label: '添加文件引用（不发送）' }
  for (const region of regions) {
    if (!contains(point, region.rect)) continue
    if (region.tabRect && contains(point, region.tabRect)) {
      const tabs = region.tabs ?? []
      const index = tabs.findIndex((tab) => point.x < tab.rect.left + tab.rect.width / 2)
      const at = index < 0 ? tabs.length : index
      const left = tabs[at]?.rect.left ?? (tabs.length ? tabs[tabs.length - 1]!.rect.left + tabs[tabs.length - 1]!.rect.width : region.tabRect.left)
      return { target: { kind: 'group', group: region.group, index: at }, rect: { left, top: region.tabRect.top, width: 3, height: region.tabRect.height }, label: '移动到此处' }
    }
    const edge = edgeAt(point, region.rect)
    const fits = edge === 'left' || edge === 'right' ? region.rect.width >= 480 : region.rect.height >= 320
    if (edge && !region.floating && input.allowCreate && fits) return { target: { kind: 'split', group: region.group, edge }, rect: splitRect(region.rect, edge), label: '分屏编辑' }
    return { target: { kind: 'group', group: region.group }, rect: region.rect, label: '移入编辑组' }
  }
  if (!input.blank || !input.allowCreate) return null
  const rect = clampFloat({ left: point.x - 120, top: point.y - 18, width: 600, height: 400 }, viewport.width, viewport.height)
  return { target: { kind: 'float', rect }, rect, label: '独立浮窗' }
}

export interface DragDeps {
  hit(point: Point): ReturnType<typeof hitTarget>
  preview(value: DragPreview | null): void
  drop(path: string, target: TabDrop): void
}

/** @public @author ddj 2026年10月14号 @param deps DOM geometry/readback callbacks. @param host Browser window. @returns Single internal drag controller with cleanup. */
export function createTabDrag(deps: DragDeps, host: Window) {
  let session: { path: string; origin: Point; point: Point; pointerId: number; dragging: boolean; capture: Element | null } | null = null
  let frame: number | null = null
  let suppressClick = false

  /** @private @author ddj 2026年10月14号 Render only once per animation frame. */
  function paint(): void {
    frame = null
    if (!session?.dragging) return
    const hit = deps.hit(session.point)
    // DOMRect properties live on its prototype; React style needs own enumerable geometry.
    const rect = hit ? { left: hit.rect.left, top: hit.rect.top, width: hit.rect.width, height: hit.rect.height } : null
    deps.preview({ path: session.path, point: session.point, target: hit?.target ?? null, rect, label: hit?.label ?? '无法放置' })
  }
  /** @public @author ddj 2026年10月14号 Cancel without changing file/layout ownership. */
  function cancel(): void {
    if (frame !== null) host.cancelAnimationFrame(frame)
    frame = null
    const previous = session
    session = null
    if (previous?.dragging) suppressClick = true
    try { previous?.capture?.releasePointerCapture(previous.pointerId) } catch { /* Pointer may already be released. */ }
    host.removeEventListener('pointermove', move, true)
    host.removeEventListener('pointerup', up, true)
    host.removeEventListener('pointercancel', cancel, true)
    host.removeEventListener('keydown', key, true)
    host.removeEventListener('blur', cancel)
    deps.preview(null)
  }
  /** @private @author ddj 2026年10月14号 @param event Pointer move. Update geometry, not layout. */
  function move(event: PointerEvent): void {
    if (!session || event.pointerId !== session.pointerId) return
    session.point = { x: event.clientX, y: event.clientY }
    session.dragging ||= dragStarted(session.origin, session.point)
    if (!session.dragging) return
    event.preventDefault()
    if (frame === null) frame = host.requestAnimationFrame(paint)
  }
  /** @private @author ddj 2026年10月14号 @param event Pointer release. Commit only a currently valid drop. */
  function up(event: PointerEvent): void {
    if (!session || event.pointerId !== session.pointerId) return
    const previous = session
    const hit = previous.dragging ? deps.hit({ x: event.clientX, y: event.clientY }) : null
    cancel()
    if (hit) deps.drop(previous.path, hit.target)
  }
  /** @private @author ddj 2026年10月14号 @param event Keyboard event. Escape cancels this drag only. */
  function key(event: KeyboardEvent): void { if (event.key === 'Escape' && session) { event.preventDefault(); event.stopPropagation(); cancel() } }
  /** @public @author ddj 2026年10月14号 @param path Trusted disk tab. @param event Primary pointer press. Start observation, not a move. */
  function start(path: string, event: PointerEvent): void {
    if (event.button !== 0 || !event.isPrimary || !path) return
    cancel()
    suppressClick = false
    const origin = { x: event.clientX, y: event.clientY }
    session = { path, origin, point: origin, pointerId: event.pointerId, dragging: false, capture: event.currentTarget instanceof Element ? event.currentTarget : null }
    try { session.capture?.setPointerCapture(event.pointerId) } catch { /* Global listeners cover older platforms. */ }
    host.addEventListener('pointermove', move, true)
    host.addEventListener('pointerup', up, true)
    host.addEventListener('pointercancel', cancel, true)
    host.addEventListener('keydown', key, true)
    host.addEventListener('blur', cancel)
  }
  /** @public @author ddj 2026年10月14号 @returns Whether to consume the synthetic post-drag click. */
  function consumeClick(): boolean { const result = suppressClick; suppressClick = false; return result }
  return { start, cancel, consumeClick }
}
