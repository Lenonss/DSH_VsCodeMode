/**
 * dsh-vscode-mode client — 快捷菜单悬浮按钮与多列级联菜单（SAO Utils 2 风格）。
 *
 * 交互约定：
 * - 按钮可拖动（3px 阈值区分点击），松手落盘坐标；无保存坐标时锚定输入框左上角。
 * - 点开是纵向滑动列表：行靠近列中心放大、向两端递减透明度，上下各 48px 渐隐（CSS mask）。
 * - 每组列最后一行是「＋ 新建」；悬停组 120ms 后在右侧展开它的一列（放不下自动翻左侧）。
 * - 行悬停浮出「⋯」：编辑（弹窗内可删）/ 复制 / 删除；root 列底部固定「菜单设置」。
 * 作者 ddj 2026年10月30号
 */
import React from 'react'
import { createPortal } from 'react-dom'
import { MenuGlobalDialog, QuickItemDialog } from './QuickMenuDialog.js'
import type { QuickMenuHost } from '../quickMenuHost.js'
import {
  anchorLauncher,
  bindingKey,
  canCreateAt,
  centerScale,
  childrenOf,
  composePrompt,
  itemStatus,
  placeColumn,
  validateRule,
} from '../../shared/quickMenu.js'
import type { QuickMenuItem, QuickRect, ValidateContext } from '../../shared/quickMenu.js'

/** 悬浮按钮尺寸。 */
const LAUNCHER_SIZE = { width: 32, height: 32 }
/** 列宽。 */
const COL_WIDTH = 220
/** 行高（与 CSS 的 --qm-row 一致，用于计算子列对齐位置）。 */
const ROW_HEIGHT = 34
/** 列内上下内边距（与 CSS 一致）。 */
const COL_PAD = 8
/** 列间距。 */
const COL_GAP = 6
/** 列最大高度。 */
const COL_MAX_HEIGHT = 520
/** root 列底部「⚙ 菜单设置」底栏高度（与 CSS 的 flex-basis 一致），会占掉滚动区高度。 */
const FOOT_HEIGHT = 32
/** 「＋ 新建」行的额外上边距（与 CSS 一致）。 */
const ADD_GAP = 5
/** 行与行之间的间隔（与 CSS 的 .edrv-qm-list gap 一致）。 */
const ROW_GAP = 1
/** 空态卡片的内容高度：标题 + 说明 + 主按钮，短于此会被裁掉说明文字。 */
const EMPTY_HEIGHT = 132
/** 列的上下边框（border-box，需从内容高度里让出）。 */
const COL_BORDER = 2
/** 拖动判定阈值（像素）。 */
const DRAG_SLOP = 3
/** 悬停展开意图延迟。 */
const HOVER_DELAY = 120

/**
 * 悬浮按钮的鲸鱼标记：取自 DSH 顶栏品牌鲸（同一条可视化轮廓），
 * 实心填充在 19px 下比描边更认得出是鲸鱼而不是一个气泡。
 */
const WHALE_PATH = 'M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z'

/** 当前弹窗状态。 */
interface DialogState {
  kind: 'none' | 'item' | 'global'
  item?: QuickMenuItem
  parentId?: string | null
}

/** 行内小菜单状态。 */
interface RowMenuState {
  item: QuickMenuItem
  rect: QuickRect
}

/**
 * 数值夹取。
 * @author ddj 2026年10月30号
 * @param value 原始值
 * @param min 下限
 * @param max 上限
 * @returns 夹取结果
 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * 两个矩形是否等价（测量轮询用，避免无意义重渲染）。
 * @author ddj 2026年10月30号
 * @param left 矩形 A
 * @param right 矩形 B
 * @returns 是否等价
 */
function sameRect(left: QuickRect, right: QuickRect): boolean {
  return left.left === right.left && left.top === right.top && left.width === right.width && left.height === right.height
}

/**
 * 取当前可见的输入框锚点。
 * 页面里可能同时存在多个（隐藏会话的 seat 位于视口外，量到的 top 会超过浮层高度，
 * 把按钮夹到屏幕底边压住输入框），因此优先选真正落在视口内、面积最大的那个。
 * @author ddj 2026年10月30号
 * @param layerRect 浮层矩形（按钮坐标以它为基准）
 * @returns 相对浮层的输入框矩形；没有可用锚点时返回 null
 */
function pickSeatRect(layerRect: DOMRect): QuickRect | null {
  const seats = Array.from(document.querySelectorAll('[data-composer-seat]'))
  let best: { rect: QuickRect; visibleArea: number } | null = null
  for (const seat of seats) {
    const rect = seat.getBoundingClientRect()
    if (rect.width < 40 || rect.height < 20) continue
    const visibleTop = Math.max(rect.top, 0)
    const visibleBottom = Math.min(rect.bottom, window.innerHeight)
    if (visibleBottom <= visibleTop) continue
    const visibleArea = (visibleBottom - visibleTop) * rect.width
    if (best && best.visibleArea >= visibleArea) continue
    best = {
      visibleArea,
      rect: {
        left: rect.left - layerRect.left,
        top: rect.top - layerRect.top,
        width: rect.width,
        height: rect.height,
      },
    }
  }
  return best ? best.rect : null
}

/**
 * 今日日期文本（{{date}} 占位符）。
 * @author ddj 2026年10月30号
 * @returns YYYY-MM-DD
 */
function todayText(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return now.getFullYear() + '-' + month + '-' + day
}

/**
 * 当前文档选择文本（{{selection}} 占位符；拿不到就是空串）。
 * @author ddj 2026年10月30号
 * @returns 选中文本
 */
function selectionText(): string {
  try {
    return window.getSelection()?.toString() ?? ''
  } catch {
    return ''
  }
}

/**
 * 悬浮按钮 + 多列级联菜单。
 * @author ddj 2026年10月30号
 * @param props host（store + 发送/规则/技能桥接）
 * @returns 菜单元素（不显示时为 null）
 */
export function QuickMenuLauncher(props: { host: QuickMenuHost }): React.ReactElement | null {
  const { host } = props
  const store = host.store
  // 订阅 store：文档/绑定快照/挂载标志变化都会重渲染
  React.useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  const state = store.getState()
  const doc = state.doc
  const [layerSize, setLayerSize] = React.useState({ width: 1280, height: 800 })
  const [measured, setMeasured] = React.useState(false)
  const [seat, setSeat] = React.useState<QuickRect | null>(null)
  const [open, setOpen] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const [dragPos, setDragPos] = React.useState<{ left: number; top: number } | null>(null)
  const [openPath, setOpenPath] = React.useState<string[]>([])
  const [hoverRow, setHoverRow] = React.useState<Record<number, number>>({})
  const [scrolls, setScrolls] = React.useState<Record<number, number>>({})
  const [rowMenu, setRowMenu] = React.useState<RowMenuState | null>(null)
  const [dialog, setDialog] = React.useState<DialogState>({ kind: 'none' })
  const [active, setActive] = React.useState<{ depth: number; index: number }>({ depth: 0, index: 0 })
  const hoverTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * 测量浮层与输入框锚点（浮层坐标系）。
   * 值不变时返回原状态，避免轮询测量引起无意义重渲染。
   * @author ddj 2026年10月30号
   */
  const measure = React.useCallback((): void => {
    const layerEl = document.querySelector('[data-shell-overlay]')
    if (!layerEl) {
      setLayerSize((prev) => (prev.width === window.innerWidth && prev.height === window.innerHeight ? prev : { width: window.innerWidth, height: window.innerHeight }))
      setSeat(null)
      return
    }
    const layerRect = layerEl.getBoundingClientRect()
    setLayerSize((prev) => (prev.width === layerRect.width && prev.height === layerRect.height ? prev : { width: layerRect.width, height: layerRect.height }))
    setMeasured((prev) => (prev ? prev : true))
    const next = pickSeatRect(layerRect)
    setSeat((prev) => (prev && next && sameRect(prev, next) ? prev : next))
  }, [])

  React.useEffect(() => {
    store.markMounted(true)
    measure()
    void store.load()
    const onResize = (): void => measure()
    window.addEventListener('resize', onResize)
    // 冷启动时输入框还没布局完，首帧量到的锚点是错的：前几秒补测几次，
    // 之后用 ResizeObserver + 低频轮询兜底（measure 内部做等值短路，不会抖）。
    const timers = [80, 320, 900, 2000].map((delay) => setTimeout(measure, delay))
    const layerEl = document.querySelector('[data-shell-overlay]')
    const seatEl = document.querySelector('[data-composer-seat]')
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => measure())
      if (layerEl) observer.observe(layerEl)
      if (seatEl) observer.observe(seatEl)
    }
    const poll = setInterval(measure, 1200)
    return () => {
      window.removeEventListener('resize', onResize)
      timers.forEach((timer) => clearTimeout(timer))
      clearInterval(poll)
      observer?.disconnect()
      store.markMounted(false)
    }
  }, [measure, store])

  // 打开时重新测量并刷新绑定快照（规则/技能可能在别处变了）
  React.useEffect(() => {
    if (!open) return
    measure()
    void store.refreshBindings()
  }, [open, measure, store])

  const ctx = store.getContext()
  const basePos = React.useMemo(() => {
    const maxLeft = Math.max(8, layerSize.width - LAUNCHER_SIZE.width - 8)
    const maxTop = Math.max(8, layerSize.height - LAUNCHER_SIZE.height - 8)
    const savedX = doc.launcher.x
    const savedY = doc.launcher.y
    // 存的坐标可能来自别的窗口尺寸（甚至超界），先量到真实浮层再判断是否还落在可视区内；
    // 超界就回落到输入框左上角，避免按钮被夹在屏幕底边压住输入框。
    if (savedX !== null && savedY !== null) {
      const inBounds = savedX >= 8 && savedY >= 8 && savedX <= maxLeft && savedY <= maxTop
      if (inBounds || !measured) return { left: clamp(savedX, 8, maxLeft), top: clamp(savedY, 8, maxTop) }
    }
    const layer: QuickRect = { left: 0, top: 0, width: layerSize.width, height: layerSize.height }
    return anchorLauncher(seat, layer, LAUNCHER_SIZE, 8)
  }, [doc.launcher.x, doc.launcher.y, seat, layerSize, measured])

  const launcherPos = dragPos ?? basePos

  /**
   * 计算每一列的矩形（独立定位，子列右展放不下则自动翻到左侧）。
   * @author ddj 2026年10月30号
   */
  const columnRects = React.useMemo((): QuickRect[] => {
    const rects: QuickRect[] = []
    const layerRect: QuickRect = { left: 0, top: 0, width: layerSize.width, height: layerSize.height }
    let anchor: QuickRect = { left: launcherPos.left, top: launcherPos.top, width: LAUNCHER_SIZE.width, height: LAUNCHER_SIZE.height }
    const depthCount = openPath.length + 1
    for (let depth = 0; depth < depthCount; depth += 1) {
      const parentId = depth === 0 ? null : openPath[depth - 1]
      const items = childrenOf(doc, parentId, ctx.cwd)
      const extra = canCreateAt(doc, parentId) ? 1 : 0
      // 列高必须把 root 底栏和「新建」行间距算进去，否则滚动区被底栏挤压、行被裁掉；
      // 空列不渲染「＋ 新建」行而是空态卡片，按 EMPTY_HEIGHT 给足高度，避免说明文字被切。
      const foot = depth === 0 ? FOOT_HEIGHT : 0
      const rowCount = items.length + extra
      const rowHeight = items.length === 0
        ? EMPTY_HEIGHT
        : items.length * ROW_HEIGHT
          + (extra > 0 ? ROW_HEIGHT + ADD_GAP : 0)
          + Math.max(0, rowCount - 1) * ROW_GAP
          + COL_PAD * 2
      const height = Math.min(COL_MAX_HEIGHT, Math.max(ROW_HEIGHT * 2 + foot, rowHeight + foot + COL_BORDER))
      const placed = placeColumn(anchor, { width: COL_WIDTH, height }, layerSize, COL_GAP)
      let rect: QuickRect = { ...placed }
      if (depth > 0) {
        const rowIndex = hoverRow[depth - 1] ?? 0
        const wantedTop = anchor.top + COL_PAD + rowIndex * ROW_HEIGHT - (scrolls[depth - 1] ?? 0)
        rect = { ...rect, top: clamp(wantedTop, 8, Math.max(8, layerRect.height - height - 8)) }
      }
      rects.push(rect)
      anchor = rect
    }
    return rects
  }, [doc, ctx.cwd, launcherPos.left, launcherPos.top, layerSize, openPath, hoverRow, scrolls])

  /**
   * 关闭菜单并清空级联状态。
   * @author ddj 2026年10月30号
   */
  const closeMenu = React.useCallback((): void => {
    setOpen(false)
    setRowMenu(null)
    setOpenPath([])
    setHoverRow({})
    setScrolls({})
    setActive({ depth: 0, index: 0 })
  }, [])

  // 点空白关闭 + 键盘操作（↑↓ 选择、→ 展开组、← 收起、Enter 执行、Esc 关闭）
  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Element | null
      if (target && target.closest('[data-qm-root="1"]')) return
      closeMenu()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeMenu()
        return
      }
      const parentId = active.depth === 0 ? null : openPath[active.depth - 1]
      const items = childrenOf(doc, parentId, ctx.cwd)
      if (items.length === 0) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const index = (active.index + delta + items.length) % items.length
        setActive({ depth: active.depth, index })
        setHoverRow((prev) => ({ ...prev, [active.depth]: index }))
        return
      }
      if (event.key === 'ArrowRight') {
        const item = items[Math.min(active.index, items.length - 1)]
        if (item && item.type === 'group') {
          event.preventDefault()
          setOpenPath((prev) => prev.slice(0, active.depth).concat(item.id))
          setActive({ depth: active.depth + 1, index: 0 })
        }
        return
      }
      if (event.key === 'ArrowLeft' && active.depth > 0) {
        event.preventDefault()
        setOpenPath((prev) => prev.slice(0, active.depth - 1))
        setActive({ depth: active.depth - 1, index: 0 })
        return
      }
      if (event.key === 'Enter') {
        const item = items[Math.min(active.index, items.length - 1)]
        if (item) void activate(item)
      }
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  })

  /**
   * 拖动与点击的分流：移动超过阈值才算拖拽，否则当作点击开关。
   * @author ddj 2026年10月30号
   * @param event 指针按下事件
   */
  function beginDrag(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const start = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: launcherPos.left, top: launcherPos.top, moved: false }
    let last = { left: launcherPos.left, top: launcherPos.top }
    const onMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== start.pointerId) return
      const dx = moveEvent.clientX - start.x
      const dy = moveEvent.clientY - start.y
      if (!start.moved && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return
      start.moved = true
      setDragging(true)
      last = {
        left: clamp(start.left + dx, 8, Math.max(8, layerSize.width - LAUNCHER_SIZE.width - 8)),
        top: clamp(start.top + dy, 8, Math.max(8, layerSize.height - LAUNCHER_SIZE.height - 8)),
      }
      setDragPos(last)
    }
    const finish = (): void => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      window.removeEventListener('blur', onUp, true)
      setDragging(false)
      setDragPos(null)
      if (start.moved) {
        store.patchLauncher(last.left, last.top)
        void store.flushLauncher()
        return
      }
      // 未移动视为点击：开 / 关菜单
      if (open) closeMenu()
      else setOpen(true)
    }
    const onUp = (): void => finish()
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    window.addEventListener('blur', onUp, true)
  }

  /**
   * 悬停行：按钮只高亮；组延迟后在右侧展开（防抖动）。
   * @author ddj 2026年10月30号
   * @param depth 所在列序号
   * @param index 行序号
   * @param item 菜单项
   */
  function hoverItem(depth: number, index: number, item: QuickMenuItem): void {
    setHoverRow((prev) => ({ ...prev, [depth]: index }))
    setActive({ depth, index })
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
    if (item.type !== 'group') {
      setOpenPath((prev) => prev.slice(0, depth))
      return
    }
    hoverTimer.current = setTimeout(() => {
      setOpenPath((prev) => prev.slice(0, depth).concat(item.id))
    }, HOVER_DELAY)
  }

  /**
   * 执行一项：组则展开，按钮则合成文本后发送/填入。
   * @author ddj 2026年10月30号
   * @param item 菜单项
   */
  async function activate(item: QuickMenuItem): Promise<void> {
    if (item.type === 'group') return
    const inlineContents: Record<string, string> = {}
    if (item.ruleMode === 'inline') {
      for (const binding of item.rules) {
        if (validateRule(binding, ctx).state !== 'ok') continue
        try {
          inlineContents[bindingKey(binding)] = await host.readRule(binding)
        } catch {
          // 读不到正文时 composePrompt 会给出告警并跳过
        }
      }
    }
    const composed = composePrompt(item, { ...ctx, inlineContents, selection: selectionText(), date: todayText() })
    if (composed.text.trim() === '') {
      host.notify('「' + item.name + '」没有可发送的内容')
      return
    }
    if (composed.warnings.length > 0) {
      host.notify('已跳过 ' + composed.warnings.length + ' 项失效绑定：' + composed.warnings[0])
    }
    const action = item.clickAction ?? doc.clickAction
    closeMenu()
    const result = action === 'fill' ? await host.fill(composed.text) : await host.send(composed.text)
    if (!result.ok) host.notify(result.message ?? '操作失败')
  }

  /**
   * 复制一项（同组同级追加副本，名字加「副本」）。
   * @author ddj 2026年10月30号
   * @param item 源项
   */
  async function duplicate(item: QuickMenuItem): Promise<void> {
    const copy: QuickMenuItem = item.type === 'group'
      ? { ...item, id: store.nextId('group'), name: item.name + ' 副本', order: item.order + 1 }
      : { ...item, id: store.nextId('button'), name: item.name + ' 副本', order: item.order + 1 }
    const result = await store.createItem(copy)
    if (!result.ok) host.notify(result.error ?? '复制失败')
    setRowMenu(null)
  }

  /**
   * 删除一项（组连带子项）。
   * @author ddj 2026年10月30号
   * @param item 目标项
   */
  async function removeItem(item: QuickMenuItem): Promise<void> {
    setRowMenu(null)
    const suffix = item.type === 'group' ? '及其全部子项' : ''
    if (!window.confirm('确认删除「' + item.name + '」' + suffix + '？')) return
    const result = await store.removeItem(item.id)
    if (!result.ok) host.notify(result.error ?? '删除失败')
    setOpenPath([])
  }

  const launcher = (
    <div
      className={'edrv-qm-launcher' + (dragging ? ' edrv-qm-launcher--drag' : '') + (open ? ' edrv-qm-launcher--open' : '')}
      style={{ left: launcherPos.left, top: launcherPos.top }}
      title="快捷菜单（拖动可移动，右键更多）"
      role="button"
      tabIndex={0}
      aria-label="快捷菜单"
      aria-expanded={open}
      onPointerDown={beginDrag}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        if (open) closeMenu()
        else setOpen(true)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        setOpen(false)
        setDialog({ kind: 'global' })
      }}
    >
      <svg viewBox="0 0 23.16 17.04" aria-hidden="true">
        <path d={WHALE_PATH} fill="currentColor" />
      </svg>
    </div>
  )

  // 隐藏态（设置在「菜单设置」里可以关掉按钮）：收成一枚半透明小圆点，
  // 仍可拖动与点开，避免「关掉之后再也打不开」的死角。
  const miniDot = (
    <div
      className="edrv-qm-launcher edrv-qm-launcher--mini"
      style={{ left: launcherPos.left, top: launcherPos.top }}
      title="快捷菜单已隐藏，点击展开（右键打开设置）"
      role="button"
      tabIndex={0}
      aria-label="快捷菜单（已隐藏）"
      onPointerDown={beginDrag}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        if (open) closeMenu()
        else setOpen(true)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        setOpen(false)
        setDialog({ kind: 'global' })
      }}
    />
  )

  const panels = open ? columnRects.map((rect, depth) => {
    const parentId = depth === 0 ? null : openPath[depth - 1]
    return (
      <QuickColumn
        key={depth}
        depth={depth}
        rect={rect}
        items={childrenOf(doc, parentId, ctx.cwd)}
        canAdd={canCreateAt(doc, parentId)}
        ctx={ctx}
        status={state.status}
        error={state.error}
        activeIndex={active.depth === depth ? active.index : -1}
        scrollTop={scrolls[depth] ?? 0}
        onScroll={(top) => setScrolls((prev) => ({ ...prev, [depth]: top }))}
        onHover={(index, item) => hoverItem(depth, index, item)}
        onActivate={(item) => { void activate(item) }}
        onMore={(item, rowRect) => setRowMenu({ item, rect: rowRect })}
        onAdd={() => setDialog({ kind: 'item', parentId })}
        onSettings={depth === 0 ? () => { setOpen(false); setDialog({ kind: 'global' }) } : undefined}
        onRetry={() => { void store.load(true) }}
        onEmptyHint={depth === 0
          ? '把常做的提问连同技能、规则存成一个按钮，点一下就发出去。'
          : '组里还没有内容，新建一个按钮或子组。'}
      />
    )
  }) : null

  return (
    <>
      <div data-edrv-view="1" className="edrv-qm-root" data-qm-root="1">
        {doc.enabled ? launcher : miniDot}
      </div>
      {open
        ? createPortal(
          // 菜单本体挂到 body：shell.overlay 的层级（z-index 20）压不过输入框卡片，
          // 直接留在槽里会被输入框盖住；portal 后自成一个高层，专用于这块临时浮层。
          <div {...{ 'data-edrv-view': '1' }} className="edrv-qm-menu" data-qm-root="1">
            {panels}
            {rowMenu ? (
              <RowMenu
                state={rowMenu}
                onEdit={() => { setDialog({ kind: 'item', item: rowMenu.item }); setRowMenu(null) }}
                onDuplicate={() => { void duplicate(rowMenu.item) }}
                onDelete={() => { void removeItem(rowMenu.item) }}
              />
            ) : null}
          </div>,
          document.body,
        )
        : null}
      {dialog.kind === 'item' ? (
        <QuickItemDialog
          host={host}
          item={dialog.item}
          parentId={dialog.item ? dialog.item.parentId : dialog.parentId ?? null}
          onClose={() => setDialog({ kind: 'none' })}
        />
      ) : null}
      {dialog.kind === 'global' ? (
        <MenuGlobalDialog host={host} onClose={() => setDialog({ kind: 'none' })} />
      ) : null}
    </>
  )
}

/** 单列 props。 */
interface QuickColumnProps {
  depth: number
  rect: QuickRect
  items: QuickMenuItem[]
  canAdd: boolean
  ctx: ValidateContext
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  activeIndex: number
  scrollTop: number
  onScroll(top: number): void
  onHover(index: number, item: QuickMenuItem): void
  onActivate(item: QuickMenuItem): void
  onMore(item: QuickMenuItem, rect: QuickRect): void
  onAdd(): void
  onSettings?: () => void
  onRetry(): void
  onEmptyHint: string
}

/**
 * 一列（纵向滑动列表 + 末行「＋ 新建」 + root 底部设置）。
 * @author ddj 2026年10月30号
 * @param props 列数据与回调
 * @returns 列元素
 */
function QuickColumn(props: QuickColumnProps): React.ReactElement {
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const count = props.items.length + (props.canAdd ? 1 : 0)
  const isEmpty = props.items.length === 0 && props.status !== 'loading' && props.status !== 'error'
  // 渐隐只在内容真的超出列高时启用：短列若也套 mask，会把首尾行洗白
  const [overflow, setOverflow] = React.useState(false)

  React.useEffect(() => {
    // 子列对齐依赖滚动位置：挂载后同步一次实际值
    props.onScroll(scrollRef.current?.scrollTop ?? 0)
  }, [])

  React.useEffect(() => {
    const viewport = scrollRef.current
    if (!viewport) return
    const measure = (): void => setOverflow(viewport.scrollHeight > viewport.clientHeight + 8)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [props.items.length, props.canAdd, props.status])

  return (
    <div className="edrv-qm-col" style={{ left: props.rect.left, top: props.rect.top, height: props.rect.height }} role="menu">
      <div
        className={'edrv-qm-scroll' + (overflow ? ' edrv-qm-scroll--fade' : '')}
        ref={scrollRef}
        onScroll={(event) => props.onScroll(event.currentTarget.scrollTop)}
      >
        {props.status === 'loading' && props.items.length === 0 ? <div className="edrv-qm-empty">正在读取菜单…</div> : null}
        {props.status === 'error' && props.items.length === 0 ? (
          <div className="edrv-qm-empty">
            <div className="edrv-qm-empty-title">菜单没读出来</div>
            <div>{props.error ?? '读取失败'}</div>
            <button type="button" className="edrv-qm-btn" onClick={props.onRetry}>重试</button>
          </div>
        ) : null}
        {/* 空态是邀请：给一句说明 + 一个动作，列表里就不再重复「＋ 新建」行 */}
        {isEmpty ? (
          <div className="edrv-qm-empty">
            <div className="edrv-qm-empty-title">{props.depth === 0 ? '还没有快捷项' : '这一组是空的'}</div>
            <div>{props.onEmptyHint}</div>
            {props.canAdd ? (
              <button type="button" className="edrv-qm-btn edrv-qm-btn--primary" onClick={props.onAdd}>
                {props.depth === 0 ? '新建第一个' : '新建一项'}
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="edrv-qm-list">
          {props.items.map((item, index) => {
            // 当前行永远满尺寸：悬停/选中的项比「离中心远近」更该被强调
            const scale = index === props.activeIndex ? { scale: 1, opacity: 1 } : centerScale(index, count)
            const flags = itemStatus(item, props.ctx)
            const badge = flags.errors.length > 0 ? ' edrv-qm-row-badge--error' : ''
            const tip = flags.errors.concat(flags.warnings).join('\n')
            return (
              <div
                key={item.id}
                className={'edrv-qm-row' + (item.type === 'group' ? ' edrv-qm-row--group' : '') + (props.activeIndex === index ? ' edrv-qm-row--active' : '')}
                style={{ transform: 'scale(' + scale.scale.toFixed(3) + ')', opacity: scale.opacity }}
                title={tip}
                data-qm-row="1"
                role="menuitem"
                tabIndex={-1}
                aria-label={item.type === 'group' ? item.name + '（组）' : item.name}
                onPointerEnter={() => props.onHover(index, item)}
                onClick={() => props.onActivate(item)}
              >
                <span className="edrv-qm-row-label">{item.name}</span>
                {badge !== '' ? <span className={'edrv-qm-row-badge' + badge} /> : null}
                {item.type === 'group' ? (
                  <span className="edrv-qm-row-chevron" aria-hidden="true">
                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4.5 2.5 8 6l-3.5 3.5" />
                    </svg>
                  </span>
                ) : null}
                <button
                  type="button"
                  className="edrv-qm-row-more"
                  title="编辑 / 复制 / 删除"
                  aria-label={'「' + item.name + '」的更多操作'}
                  onClick={(event) => {
                    event.stopPropagation()
                    const rowRect: QuickRect = {
                      left: props.rect.left,
                      top: props.rect.top + COL_PAD + index * ROW_HEIGHT - props.scrollTop,
                      width: COL_WIDTH,
                      height: ROW_HEIGHT,
                    }
                    props.onMore(item, rowRect)
                  }}
                >⋯</button>
              </div>
            )
          })}
          {props.canAdd && !isEmpty ? (
            // 新建行是动作不是内容：不参与中心缩放，避免被压到 0.7 透明度后看不清
            <div
              className="edrv-qm-row edrv-qm-row--add"
              data-qm-row="1"
              role="menuitem"
              aria-label="新建"
              onClick={props.onAdd}
            >＋ 新建</div>
          ) : null}
        </div>
      </div>
      {props.onSettings ? (
        <div
          className="edrv-qm-foot"
          onClick={props.onSettings}
          title="显示、点击动作、最大嵌套层数、导入导出"
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            props.onSettings?.()
          }}
        >
          <span className="edrv-qm-foot-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
              <circle cx="8" cy="8" r="2.3" />
              <path d="M8 1.9v1.7M8 12.4v1.7M1.9 8h1.7M12.4 8h1.7M3.7 3.7l1.2 1.2M11.1 11.1l1.2 1.2M12.3 3.7l-1.2 1.2M4.9 11.1l-1.2 1.2" />
            </svg>
          </span>
          <span>菜单设置</span>
        </div>
      ) : null}
    </div>
  )
}

/** 行内小菜单 props。 */
interface RowMenuProps {
  state: RowMenuState
  onEdit(): void
  onDuplicate(): void
  onDelete(): void
}

/**
 * 行内小菜单（编辑 / 复制 / 删除）。
 * @author ddj 2026年10月30号
 * @param props 状态与动作
 * @returns 小菜单元素
 */
function RowMenu(props: RowMenuProps): React.ReactElement {
  return (
    <div
      className="edrv-qm-context"
      style={{ left: props.state.rect.left + COL_WIDTH - 10, top: props.state.rect.top + 26 }}
      data-qm-root="1"
      role="menu"
    >
      <div className="edrv-qm-context-item" role="menuitem" onClick={props.onEdit}>编辑</div>
      <div className="edrv-qm-context-item" role="menuitem" onClick={props.onDuplicate}>复制</div>
      <div className="edrv-qm-context-sep" />
      <div className="edrv-qm-context-item edrv-qm-context-item--danger" role="menuitem" onClick={props.onDelete}>删除</div>
    </div>
  )
}
