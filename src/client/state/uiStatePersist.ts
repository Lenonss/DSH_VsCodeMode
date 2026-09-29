/**
 * dsh-vscode-mode client — 界面状态镜像（把 `edrv.*` 的 localStorage 状态写穿到 host）。
 *
 * 背景：Web GUI 的 origin（含端口）每次启动可能变化，而 localStorage 按 origin 分区，
 * 于是页签/侧栏/预览态等状态「重启就忘」。本模块包装 localStorage 写口：
 * 只拦 `edrv.` 前缀键（跳过镜像自身标记键与派生条目缓存，见 `SKIP_PREFIX`），400ms 去抖后
 * 增量上送 `edrv.uiState.set`：按体积分批，整批被拒则逐键回退，避免个别超大键拖垮同批。
 * 启动（含换 origin）后 `edrv.uiState.get` 水合，仅填本地缺失的键（本地优先，绝不覆盖）；
 * 首次搬运标记只在整批落盘成功后写入（失败则下次加载重试）。
 * 全局键（不随工作区变化）走 globals 分区，其余按键原值搬进工作区分区。
 *
 * 降级：存储不可用/包装失败/host 读写失败/超限一律静默退回纯 localStorage（诊断日志留痕）。
 * 纯逻辑与依赖注入分离，`createUiStateMirror` 可在 node 环境单测。
 * 作者 ddj 2026-09-28
 */
import { CACHE_KEY } from '../paths.js'
import { dbg, rpc } from '../rpc.js'
import { readSessionScope } from '../sessionScope.js'

// --region 常量
/** 参与镜像的键前缀（只拦插件自己的键，不碰其他插件的 localStorage）。 */
const MIRROR_PREFIX = 'edrv.'
/** 去抖间隔：改动密集时合并为一次上送（毫秒）。 */
export const FLUSH_DEBOUNCE_MS = 400
/** 首次回填标记键（把既有 `edrv.*` 状态一次性推给 host；自身不参与镜像）。 */
export const SEEDED_KEY = 'edrv.uistate.v1.seeded'
/** 水合完成事件名（换 origin 回填后广播，供界面重跑恢复逻辑）。 */
export const READY_EVENT = 'edrv:ui-state-ready'
/** 全局键（不随工作区变化，落用户级镜像文件）。 */
const GLOBAL_EXACT = ['edrv.debug', CACHE_KEY.sideHint]
/** 全局键前缀（不随工作区变化）。 */
const GLOBAL_PREFIX = [CACHE_KEY.workspaceFold]
/** 单次上送的字节上限（host 单文件上限 512KB；分批避免个别超大键拖垮整批）。 */
export const CHUNK_BYTES = 64 * 1024
/** 不参与镜像的派生缓存前缀（目录条目 SWR 缓存可达数百 KB，且 host 侧 tree.v1.json 已覆盖同类信息）。 */
const SKIP_PREFIX = [CACHE_KEY.entries]
/** 水合失败重试次数（启动早期会话尚未就绪时 host 会答「会话不存在」，须稍后补试）。 */
export const HYDRATE_RETRY_MAX = 8
/** 水合失败重试间隔（毫秒）。 */
export const HYDRATE_RETRY_MS = 800
// --endregion

// --region 类型
/** localStorage 最小接口（便于注入假实现）。 */
export interface UiStorage {
  /** 键数量。 */
  length: number
  /** 按下标取键名。 */
  key(index: number): string | null
  /** 读键值。 */
  getItem(key: string): string | null
  /** 写键值。 */
  setItem(key: string, value: string): void
  /** 删键。 */
  removeItem(key: string): void
}

/** 上送补丁：null 表示删除该键。 */
export interface UiStatePush {
  /** 工作区级补丁。 */
  keys?: Record<string, string | null>
  /** 全局补丁。 */
  globals?: Record<string, string | null>
}

/** host 取回快照。 */
export interface UiStateSnapshot {
  /** 工作区级键值表。 */
  keys?: Record<string, string>
  /** 全局键值表。 */
  globals?: Record<string, string>
}

/** 镜像依赖（全部可注入；缺省走浏览器存储 + RPC）。 */
export interface UiStateMirrorDeps {
  /** localStorage 替身。 */
  storage: UiStorage
  /** 上送补丁（拒绝即抛错，内部重试一次）。 */
  push: (payload: UiStatePush, sessionId?: string) => Promise<void>
  /** 取回镜像。 */
  fetch: (sessionId?: string) => Promise<UiStateSnapshot>
  /** 当前会话 id。 */
  sessionIdOf?: () => string | undefined
  /** 去抖调度（缺省 setTimeout）。 */
  schedule?: (fn: () => void, ms: number) => unknown
  /** 取消去抖（缺省 clearTimeout）。 */
  cancel?: (handle: unknown) => void
  /** 诊断日志（缺省静默）。 */
  log?: (text: string) => void
  /** 无门控上报（缺省退化为 `log`）：绕过客户端 debug 开关，供 host 侧留痕排查。 */
  report?: (text: string, level?: string) => void
  /** 单批体积上限（缺省 `CHUNK_BYTES`；测试注入小值以覆盖分批）。 */
  chunkBytes?: number
}

/** 镜像实例。 */
export interface UiStateMirror {
  /** 包装 localStorage 写口（写口不可用时返回 false）。 */
  install(): boolean
  /** 取回 host 镜像并回填本地缺失键，返回回填条数。 */
  hydrate(): Promise<number>
  /** 立即上送待推送批次，返回最终丢弃的键数（0 = 全部落盘；供卸载与测试驱动）。 */
  flush(): Promise<number>
  /** 是否已完成一次水合。 */
  hydrated(): boolean
  /** 水合阶段是否已结束（成功或重试耗尽）。未结束时界面不应写入存档，否则会把空初值推给 host。 */
  settled(): boolean
}
// --endregion

// --region 纯逻辑
/**
 * 是否参与镜像（`edrv.` 前缀且非标记键）。
 * @author ddj 2026年09月28号
 * @param key localStorage 键
 * @returns 是否镜像
 */
export function isMirroredKey(key: string): boolean {
  if (!key.startsWith(MIRROR_PREFIX) || key === SEEDED_KEY) return false
  return !SKIP_PREFIX.some((prefix) => key.startsWith(prefix))
}

/**
 * 是否全局键（不随工作区变化）。
 * @author ddj 2026年09月28号
 * @param key localStorage 键
 * @returns 是否全局键
 */
export function isGlobalKey(key: string): boolean {
  if (GLOBAL_EXACT.includes(key)) return true
  return GLOBAL_PREFIX.some((prefix) => key.startsWith(prefix))
}

/**
 * 收集本地全部镜像键（存储不可读 → 空数组）。
 * @author ddj 2026年09月28号
 * @param storage localStorage 替身
 * @returns 镜像键清单
 */
export function localMirrorKeys(storage: UiStorage): string[] {
  const keys: string[] = []
  try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (key && isMirroredKey(key)) keys.push(key)
    }
  } catch (error) { /* 存储不可读：视为空 */ }
  return keys
}

/**
 * 按键值体积切分补丁（单键超限则独占一批，仍由 host 容量上限裁决）。
 * @author ddj 2026年09月29号
 * @param patch 待上送补丁
 * @param limit 单批体积上限（字节；按字符数近似）
 * @returns 批次数组（空补丁 → 空数组）
 */
export function chunkPatch(patch: Record<string, string | null>, limit = CHUNK_BYTES): Array<Record<string, string | null>> {
  const chunks: Array<Record<string, string | null>> = []
  let current: Record<string, string | null> = {}
  let size = 0
  for (const [key, value] of Object.entries(patch)) {
    const cost = key.length + (value === null ? 0 : value.length)
    if (size > 0 && size + cost > limit) {
      chunks.push(current)
      current = {}
      size = 0
    }
    current[key] = value
    size += cost
  }
  if (size > 0) chunks.push(current)
  return chunks
}
// --endregion

/**
 * 创建界面状态镜像实例。
 * @author ddj 2026年09月28号
 * @param deps 依赖（存储/上送/取回/调度）
 * @returns 镜像实例
 */
export function createUiStateMirror(deps: UiStateMirrorDeps): UiStateMirror {
  const { storage } = deps
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const cancel = deps.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const log = deps.log ?? (() => { /* 默认静默 */ })
  const report = deps.report ?? ((text: string, level?: string) => log(text))
  const pending: Required<UiStatePush> = { keys: {}, globals: {} }
  let timer: unknown = null
  let inflight: Promise<void> | null = null
  let suppressed = 0
  let done = false
  let installed = false
  let lastError = ''
  /** 水合尝试次数（失败重试；超过 `HYDRATE_RETRY_MAX` 放弃并解禁）。 */
  let attempts = 0
  /** 重试定时器（与水合无关的 flush 去抖计时器分开，避免互相取消）。 */
  let retryTimer: unknown = null
  let settleDone = false

  /** 记入待推送批次并安排去抖上送（水合期间或非镜像键 → 跳过）。 */
  function queue(key: string, value: string | null): void {
    if (suppressed > 0 || !isMirroredKey(key)) return
    const bucket = isGlobalKey(key) ? pending.globals : pending.keys
    bucket[key] = value
    if (timer !== null) cancel(timer)
    timer = schedule(() => {
      timer = null
      void flush()
    }, FLUSH_DEBOUNCE_MS)
  }

  /** 上送一批补丁（失败重试一次）。 */
  async function pushBatch(payload: UiStatePush): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await deps.push(payload, deps.sessionIdOf?.())
        return true
      } catch (error) {
        lastError = String(error)
      }
    }
    return false
  }

  /** 逐键回退上送（整批被拒后用，避免个别大键拖垮同批其它键），返回丢弃键数。 */
  async function pushEach(bucket: Record<string, string | null>, asGlobal: boolean): Promise<number> {
    let lost = 0
    for (const [key, value] of Object.entries(bucket)) {
      if (await pushBatch(asGlobal ? { globals: { [key]: value } } : { keys: { [key]: value } })) continue
      lost++
      log('界面状态镜像上送失败（已丢弃 ' + key + '）: ' + lastError)
    }
    return lost
  }

  /** 分区上送：按体积分批，整批被拒则逐键回退，返回最终丢弃的键数。 */
  async function pushBucket(bucket: Record<string, string | null>, asGlobal: boolean): Promise<number> {
    let lost = 0
    for (const chunk of chunkPatch(bucket, deps.chunkBytes)) {
      if (!(await pushBatch(asGlobal ? { globals: chunk } : { keys: chunk }))) lost += await pushEach(chunk, asGlobal)
    }
    return lost
  }

  /** 立即上送待推送批次（空批次不请求；与在途上送串行），返回最终丢弃的键数。 */
  async function flush(): Promise<number> {
    if (inflight) await inflight.catch(() => { /* 在途失败不影响本批 */ })
    if (timer !== null) {
      cancel(timer)
      timer = null
    }
    const keys = pending.keys
    const globals = pending.globals
    const hasKeys = Object.keys(keys).length > 0
    const hasGlobals = Object.keys(globals).length > 0
    if (!hasKeys && !hasGlobals) return 0
    pending.keys = {}
    pending.globals = {}
    const run = (async (): Promise<number> => {
      let lost = 0
      // 两个分区各自成请求：任一分区被 host 拒绝都不牵连另一个分区
      if (hasKeys) lost += await pushBucket(keys, false)
      if (hasGlobals) lost += await pushBucket(globals, true)
      return lost
    })()
    inflight = run.then(() => { /* 结果由 run 返回 */ }, () => { /* 异常已在内部消化 */ })
    return run
  }

  /** 回填本地缺失键（本地已有值一律保留）。 */
  function applyHydration(snapshot: UiStateSnapshot): number {
    let filled = 0
    suppressed++
    try {
      const all = { ...snapshot.globals, ...snapshot.keys }
      for (const [key, value] of Object.entries(all)) {
        if (!isMirroredKey(key) || typeof value !== 'string') continue
        if (storage.getItem(key) !== null) continue
        storage.setItem(key, value)
        filled++
        report('回填键 ' + key + '（' + value.length + ' 字符）')
      }
    } catch (error) {
      log('界面状态回填写入失败: ' + String(error))
    } finally {
      suppressed--
    }
    return filled
  }

  /** 首次运行时把既有本地状态一次性推给 host（只入队；成功后才落标记，避免失败后永不重试）。 */
  function seedLocal(): number {
    try {
      if (storage.getItem(SEEDED_KEY) === '1') return 0
      const keys = localMirrorKeys(storage)
      for (const key of keys) queue(key, storage.getItem(key))
      return keys.length
    } catch (error) {
      log('界面状态首次搬运失败: ' + String(error))
      return 0
    }
  }

  /** 落首次搬运标记（仅在本批全部落盘成功后调用；写失败下次加载重搬，幂等）。 */
  function markSeeded(): void {
    try {
      storage.setItem(SEEDED_KEY, '1')
    } catch (error) { /* 标记写失败：下次加载重搬 */ }
  }

  /** 广播水合完成事件（无 window 环境静默）。 */
  function emitReady(): void {
    try {
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(READY_EVENT))
    } catch (error) { /* 事件广播失败忽略 */ }
  }

  /**
   * 结束水合阶段（成功或重试耗尽）：解禁界面落盘，并广播就绪事件让恢复逻辑补跑一次。
   * 冷启动早期会话未就绪时 `edrv.uiState.get` 会返回「会话不存在」，故本阶段必须可重试；
   * 未结束前界面不得写存档，否则空初值会覆盖 host 上的真实状态。
   */
  function settle(): void {
    if (settleDone) return
    settleDone = true
    emitReady()
    report('水合阶段结束（就绪；' + (done ? '已回填' : '未回填，退回纯 localStorage') + '）')
  }

  /**
   * 取回 host 镜像并回填本地缺失键；失败按 `HYDRATE_RETRY_MS` 重试，超限则结束水合阶段。
   * @returns 本次回填键数（失败/重试中为 0）
   */
  async function hydrate(): Promise<number> {
    try {
      report('水合开始（origin=' + originOf() + '，第 ' + (attempts + 1) + ' 次）')
      const snapshot = await deps.fetch(deps.sessionIdOf?.())
      // 先搬运本 origin 既有状态（只含换 origin 前就存在的键），再回填缺失键：
      // 顺序反过来会把刚回填的键再回送一遍（值与 host 完全相同，纯属多余流量）。
      const seeded = seedLocal()
      const filled = applyHydration(snapshot)
      const stored = Object.keys({ ...snapshot.globals, ...snapshot.keys }).length
      done = true
      report('水合完成：host 镜像 ' + stored + ' 键、本地搬运 ' + seeded + ' 键、回填 ' + filled + ' 键')
      if (seeded > 0) {
        const lost = await flush()
        report('首次搬运输送完成：丢弃 ' + lost + ' 键')
        if (lost === 0) markSeeded()
      }
      settle()
      return filled
    } catch (error) {
      attempts++
      if (attempts < HYDRATE_RETRY_MAX) {
        report('水合失败（第 ' + attempts + ' 次，' + HYDRATE_RETRY_MS + 'ms 后重试）: ' + String(error), 'warn')
        retryTimer = schedule(() => {
          retryTimer = null
          void hydrate()
        }, HYDRATE_RETRY_MS)
        return 0
      }
      report('水合放弃（重试 ' + attempts + ' 次仍失败）: ' + String(error), 'warn')
      settle()
      return 0
    }
  }

  return {
    install(): boolean {
      if (installed) return true
      try {
        const proto = Object.getPrototypeOf(storage) as Partial<UiStorage> | null
        const rawSet = proto?.setItem
        const rawRemove = proto?.removeItem
        if (typeof rawSet !== 'function' || typeof rawRemove !== 'function') return false
        storage.setItem = function (key: string, value: string): void {
          rawSet.call(storage, key, value)
          queue(String(key), String(value))
        }
        storage.removeItem = function (key: string): void {
          rawRemove.call(storage, key)
          queue(String(key), null)
        }
        installed = true
        report('镜像已包装 localStorage 写口')
        return true
      } catch (error) {
        report('界面状态镜像包装失败（退回纯 localStorage）: ' + String(error), 'warn')
        return false
      }
    },
    hydrate,
    flush,
    hydrated(): boolean {
      return done
    },
    settled(): boolean {
      return settleDone
    },
  }
}

// --region 插件接线
/** 单例镜像（installUiStatePersist 幂等：HMR 重挂不重复包装）。 */
let singleton: UiStateMirror | null = null
/** 是否已回填过（晚到的订阅者据此立即执行）。 */
let uiReady = false
/** 无门控上报出口（由 installUiStatePersist 注入；未装配时静默）。 */
let reporter: ((text: string, level?: string) => void) | null = null
/** 在途水合（供 apply 等待，尽量让回填先于界面挂载）。 */
let hydrating: Promise<number> | null = null

/** 当前页面 origin（无 location 环境返回 '?'）。 */
function originOf(): string {
  try {
    if (typeof location !== 'undefined' && location.origin) return location.origin
  } catch (error) { /* 无 location 环境 */ }
  return '?'
}

/**
 * 上报界面状态镜像事件（无门控：绕过客户端 debug 开关，直接落 host 诊断日志）。
 * @author ddj 2026年09月29号
 * @param text 事件文本
 * @param level 日志级别（缺省 'debug'）
 */
export function reportUiStateEvent(text: string, level?: string): void {
  try {
    reporter?.(text, level)
  } catch (error) { /* 上报失败忽略 */ }
}

/**
 * 触发（或加入）一次水合并等待结果：让界面挂载前尽量拿到回填值；水合阶段已结束则返回 0。
 * @author ddj 2026年09月29号
 * @returns 本次回填键数
 */
export async function hydrateUiState(): Promise<number> {
  if (!singleton || singleton.settled()) return 0
  if (hydrating) return hydrating
  return singleton.hydrate()
}

/**
 * 水合阶段是否已结束（未结束时界面不得写存档：空初值会覆盖 host 上的真实状态）。
 * @author ddj 2026年09月29号
 * @returns 是否已结束（未装配视为已结束，退回纯 localStorage 行为）
 */
export function uiStateSettled(): boolean {
  return singleton ? singleton.settled() : true
}

/** 读浏览器 localStorage（不可用 → null）。 */
function readLocalStorage(): UiStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage as unknown as UiStorage
  } catch (error) {
    return null
  }
}

/** 上送镜像（host 返回 ok:false 视为失败，触发内部重试）。 */
async function pushViaRpc(payload: UiStatePush, sessionId?: string): Promise<void> {
  const res = await rpc('edrv.uiState.set', { sessionId, keys: payload.keys, globals: payload.globals })
  if (!res.ok) throw new Error(res.error)
}

/** 取回镜像。 */
async function fetchViaRpc(sessionId?: string): Promise<UiStateSnapshot> {
  const res = await rpc('edrv.uiState.get', { sessionId })
  if (!res.ok) throw new Error(res.error)
  return { keys: res.keys, globals: res.globals }
}

/**
 * 安装界面状态镜像（幂等）：包装 localStorage 写口并触发一次回填。
 * @author ddj 2026年09月28号
 * @param ctx 客户端根上下文（只需 `get`，用于解析当前会话）
 * @param schedule 去抖调度（客户端 apply 提供的 ctx.timeout 包装）
 * @param report 无门控上报（缺省静默；传入后所有镜像事件绕过 debug 开关落 host 日志）
 * @returns 是否安装成功（存储不可用 → false，功能退回纯 localStorage）
 */
export function installUiStatePersist(
  ctx: { get: (name: string) => unknown },
  schedule: (fn: () => void, ms: number) => unknown,
  report?: (text: string, level?: string) => void,
): boolean {
  if (singleton) return true
  if (report) reporter = report
  const storage = readLocalStorage()
  if (!storage) {
    reportUiStateEvent('镜像安装失败：localStorage 不可用', 'warn')
    return false
  }
  const sessionIdOf = (): string | undefined => readSessionScope(ctx).sessionId
  const mirror = createUiStateMirror({
    storage,
    push: pushViaRpc,
    fetch: fetchViaRpc,
    sessionIdOf,
    schedule,
    report: (text: string, level?: string) => reportUiStateEvent(text, level),
    log: (text: string) => {
      try { dbg(sessionIdOf(), 'ui-state: ' + text, 'warn') } catch (error) { /* 日志失败忽略 */ }
    },
  })
  if (!mirror.install()) {
    reportUiStateEvent('镜像安装失败：localStorage 写口无法包装', 'warn')
    return false
  }
  singleton = mirror
  try {
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => { void mirror.flush() })
    }
  } catch (error) { /* 无 window 环境忽略 */ }
  hydrating = mirror.hydrate().then((filled) => {
    if (filled > 0 || mirror.settled()) uiReady = true
    return filled
  })
  void hydrating.finally(() => {
    // 首轮结束后：已结束水合阶段才允许后续 hydrateUiState() 重新发起（重试由镜像内部承担）
    if (mirror.settled()) {
      uiReady = true
      hydrating = null
    }
  })
  return true
}

/**
 * 订阅「界面状态回填完成」（已回填过则立即执行一次）。
 * @author ddj 2026年09月28号
 * @param listener 回调
 * @returns 取消订阅函数（幂等）
 */
export function onUiStateReady(listener: () => void): () => void {
  if (typeof window === 'undefined') {
    if (uiReady) listener()
    return () => { /* 无事件源 */ }
  }
  if (uiReady) {
    listener()
    return () => { /* 已完成后无需取消 */ }
  }
  const handler = (): void => { listener() }
  window.addEventListener(READY_EVENT, handler)
  return () => window.removeEventListener(READY_EVENT, handler)
}

/**
 * 立即上送待推送批次（卸载/隐藏前调用，尽量少丢最后一次改动）。
 * @author ddj 2026年09月28号
 * @returns 上送完成
 */
export async function flushUiState(): Promise<void> {
  if (singleton) await singleton.flush()
}
// --endregion
