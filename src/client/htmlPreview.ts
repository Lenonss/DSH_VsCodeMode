/**
 * dsh-vscode-mode client — HTML 文件判定与官方 HTML 渲染器探测。
 *
 * 背景：.html/.htm 的网页渲染交给官方 documentpreviews 的内置 html body；
 * 本模块只回答两个问题：一是该路径是否 HTML，二是当前 DSH 是否真的注册了
 * HTML 渲染器。探针必须有界、可卸载、异常不抛：旧版 DSH 没有 documentPreviews
 * 服务时，调用方据此回退到本插件文本编辑，而不是把文件送进官方纯文本查看器。
 * 纯函数 + 模块级探针态，无 DOM 依赖，可在 node 环境单测。
 * @author ddj 2026年11月21号
 */

/** 可进入官方 HTML 预览的扩展名（小写、无点）。 */
const HTML_EXT_SET: Set<string> = new Set(['html', 'htm'])

/** 官方 documentpreviews 服务名（官方以 ctx.reflect.provide('documentPreviews') 暴露）。 */
export const DOCUMENT_PREVIEWS_SERVICE = 'documentPreviews'

/** 探针默认重试次数（与既有可选服务探测的 15×2s 同节奏）。 */
const PROBE_ATTEMPTS = 15

/** 探针默认重试间隔（毫秒）。 */
const PROBE_INTERVAL_MS = 2000

/** 官方 body 定义的最小结构面。 */
interface PreviewDefinition {
  extensions?: unknown
}

/** 官方 documentpreviews 服务的最小结构面。 */
export interface DocumentPreviewsLike {
  getSnapshot?: () => unknown
  subscribe?: (listener: () => void) => unknown
}

/** 探针安装选项（schedule 可注入，便于单测）。 */
export interface HtmlPreviewProbeOptions {
  /** 延时调度器（缺省 setTimeout）；注入后单测可同步推进。 */
  schedule?: (fn: () => void, ms: number) => void
  /** 尝试次数（含首次；缺省 15）。 */
  attempts?: number
  /** 尝试间隔毫秒（缺省 2000）。 */
  intervalMs?: number
}

/** 模块级探针态：true = 官方 HTML 渲染器可用。 */
let officialAvailable = false

/**
 * 判断路径是否为可进入官方预览的 HTML 文件（取 basename 后缀，大小写不敏感）。
 * @author ddj 2026年11月21号
 * @param path 文件路径（/ 或 \ 分隔均可）
 * @returns 是否 HTML 文件
 */
export function isHtmlPath(path: unknown): boolean {
  const base = String(path ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return false
  return HTML_EXT_SET.has(base.slice(dot + 1).toLowerCase())
}

/**
 * 判断官方 documentpreviews 快照里是否声明了 html/htm 渲染器。
 * 容忍带点、大小写、null/异常行；任何畸形输入一律按「没有」处理。
 * @author ddj 2026年11月21号
 * @param snapshot getSnapshot() 的返回值
 * @returns 是否命中 HTML body
 */
export function hasHtmlPreviewBody(snapshot: unknown): boolean {
  if (!Array.isArray(snapshot)) return false
  for (const row of snapshot) {
    if (row === null || typeof row !== 'object') continue
    const extensions = (row as PreviewDefinition).extensions
    if (!Array.isArray(extensions)) continue
    for (const raw of extensions) {
      if (typeof raw !== 'string') continue
      if (HTML_EXT_SET.has(raw.trim().replace(/^\./, '').toLowerCase())) return true
    }
  }
  return false
}

/**
 * 当前是否可用官方 HTML 渲染器。
 * @author ddj 2026年11月21号
 * @returns 探针结论
 */
export function hasOfficialHtmlPreview(): boolean {
  return officialAvailable
}

/**
 * 直接写入探针结论（测试注入与运行时校正用）。
 * @author ddj 2026年11月21号
 * @param available 是否可用
 */
export function setOfficialHtmlPreview(available: boolean): void {
  officialAvailable = available === true
}

/**
 * 复位探针结论（卸载/测试隔离用）。
 * @author ddj 2026年11月21号
 */
export function resetHtmlPreviewProbe(): void {
  officialAvailable = false
}

/**
 * 缺省调度器：setTimeout，并在可能时 unref，避免长驻进程被探针拖住。
 * @author ddj 2026年11月21号
 * @param fn 回调
 * @param ms 延时毫秒
 */
function defaultSchedule(fn: () => void, ms: number): void {
  const timer = setTimeout(fn, ms) as unknown as { unref?: () => void }
  try {
    timer.unref?.()
  } catch {
    /* 无 unref 的运行环境忽略 */
  }
}

/**
 * 安装官方 HTML 渲染器探针：命中即置真并订阅后续变化；未命中按间隔有界重试。
 * 服务缺失、快照畸形、订阅抛错都只影响探针结论，不影响插件装配。
 * @author ddj 2026年11月21号
 * @param ctx 客户端上下文（只需 get）
 * @param options 调度与重试参数
 * @returns 幂等卸载器（同时复位结论）
 */
export function installHtmlPreviewProbe(
  ctx: { get: (name: string) => unknown },
  options: HtmlPreviewProbeOptions = {},
): () => void {
  const schedule = typeof options.schedule === 'function' ? options.schedule : defaultSchedule
  const attempts = Number.isFinite(options.attempts) ? Math.max(1, Number(options.attempts)) : PROBE_ATTEMPTS
  const intervalMs = Number.isFinite(options.intervalMs) ? Math.max(0, Number(options.intervalMs)) : PROBE_INTERVAL_MS

  let disposed = false
  let remaining = attempts
  let offSubscribe: (() => void) | null = null
  let subscribing = false

  /** @private @author ddj 2026年11月21号 @returns Optional previews service. */
  function serviceOf(): DocumentPreviewsLike | undefined {
    try {
      return ctx.get(DOCUMENT_PREVIEWS_SERVICE) as DocumentPreviewsLike | undefined
    } catch {
      return undefined
    }
  }

  /**
   * 订阅服务变化（只订一次；回调自身异常不扩散）。
   * @author ddj 2026年11月21号
   * @param service 已命中的服务
   */
  function attach(service: DocumentPreviewsLike): void {
    if (offSubscribe !== null || subscribing || typeof service.subscribe !== 'function') return
    subscribing = true
    try {
      const off = service.subscribe(() => {
        refresh()
      })
      offSubscribe = typeof off === 'function' ? (off as () => void) : null
    } catch {
      offSubscribe = null
    } finally {
      subscribing = false
    }
  }

  /**
   * 读取一次快照并更新结论；命中时补订阅。
   * @author ddj 2026年11月21号
   * @returns 本次是否命中
   */
  function refresh(): boolean {
    if (disposed) return false
    const service = serviceOf()
    if (!service || typeof service.getSnapshot !== 'function') return false
    let present = false
    try {
      present = hasHtmlPreviewBody(service.getSnapshot())
    } catch {
      present = false
    }
    officialAvailable = present
    // 服务已就绪就订阅：官方 html body 可能晚于服务注册（客户端插件加载顺序不定），
    // 只在命中时订阅会漏掉「先有服务、后注册 html body」的时序。
    attach(service)
    return present
  }

  /**
   * 一轮探测：命中即停，否则按剩余次数继续调度。
   * @author ddj 2026年11月21号
   */
  function tick(): void {
    if (disposed) return
    if (refresh()) return
    remaining -= 1
    if (remaining > 0) schedule(tick, intervalMs)
  }

  tick()
  return () => {
    disposed = true
    officialAvailable = false
    const off = offSubscribe
    offSubscribe = null
    try {
      off?.()
    } catch {
      /* 卸载异常不影响调用方 */
    }
  }
}
