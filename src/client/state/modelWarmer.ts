/**
 * dsh-vscode-mode client — Monaco model 预热调度层。
 *
 * 背景：Monaco 的 GotoDefinitionAtPositionEditorContribution 在 Ctrl+hover 渲染定义链接
 * 预览时，对目标的 edrv:// uri 调 textModelResolverService.createModelReference 后
 * **只挂 then、没有 catch**；目标文件若从未在本会话打开过，该 uri 没有已注册 model，
 * createModelReference 直接 reject("Model not found")，成为未捕获的 promise 异常。
 * 本构建的 vendored Monaco 也没有 registerTextModelContentProvider 可供惰性喂内容，
 * 因此修法是在 provideDefinition 返回前把目标 model 建出来（预热）。
 *
 * 本模块只负责「让某路径的 model 存在」这件事的调度：安装/卸载实现、并发单飞、
 * 失败冷却与等待上限。真正建 model 的实现由 EditorView 注入（它才持有 monaco 与文档缓存）。
 * 纯逻辑，不依赖 monaco，可单测。
 * 作者 ddj 2026年10月20号
 */

// --region 常量与状态

/** 单次预热调用的等待上限：超过即放行 hover（预热仍在后台继续）。 */
export const WARM_TIMEOUT_MS = 400

/** 预热失败后该路径的冷却窗口，避免每次 hover 都重试同一失败目标。 */
export const WARM_COOLDOWN_MS = 10_000

/** 冷却表条目上限（超出按插入序丢最旧），防长会话里无限增长。 */
export const WARM_COOLDOWN_CAP = 64

/** 预热实现：给定工作区相对路径，成功让 model 存在则返回 true。 */
export type WarmImpl = (path: string) => Promise<boolean>

/** 当前安装的预热实现（EditorView 挂载时注入，未挂载则为 null）。 */
let impl: WarmImpl | null = null
/** path → 进行中的预热（单飞：连续 hover 同一目标只读一次盘）。 */
const inFlight = new Map<string, Promise<boolean>>()
/** path → 冷却截止时间戳（毫秒）。 */
const cooled = new Map<string, number>()
// --endregion

// --region 状态维护

/**
 * 清空进行中/冷却状态（安装或卸载实现时复位，避免跨实现串味）。
 * @author ddj 2026年10月20号
 */
function resetWarmerState(): void {
  inFlight.clear()
  cooled.clear()
}

/**
 * 该路径是否处于失败冷却窗口内（过期的顺手清掉）。
 * @author ddj 2026年10月20号
 * @param path 工作区相对路径
 * @returns 仍在冷却中返回 true
 */
function isCooling(path: string): boolean {
  const until = cooled.get(path)
  if (until === undefined) return false
  if (until > Date.now()) return true

  cooled.delete(path)
  return false
}

/**
 * 记录一次失败冷却，并把冷却表裁剪到上限以内。
 * @author ddj 2026年10月20号
 * @param path 工作区相对路径
 */
function coolDown(path: string): void {
  cooled.delete(path)
  cooled.set(path, Date.now() + WARM_COOLDOWN_MS)

  while (cooled.size > WARM_COOLDOWN_CAP) {
    const oldest = cooled.keys().next()
    if (oldest.done) break

    cooled.delete(oldest.value)
  }
}

/**
 * 结算一次预热：清 inFlight（仅当仍是自己那条）、按结果维护冷却。
 * @author ddj 2026年10月20号
 * @param path 工作区相对路径
 * @param run 该次预热的 promise（用于识别是否已被更新的一次替换）
 * @param ok 实现返回的成功与否
 */
function settleWarm(path: string, run: Promise<boolean>, ok: boolean): void {
  if (inFlight.get(path) === run) inFlight.delete(path)
  if (ok) {
    cooled.delete(path)
    return
  }

  coolDown(path)
}
// --endregion

// --region 底层预热

/**
 * 启动一次底层预热：登记 inFlight、把实现异常折叠成 false（绝不向调用方抛）。
 * @author ddj 2026年10月20号
 * @param path 工作区相对路径
 * @param fn 预热实现
 * @returns 永不 reject 的布尔 promise（已登记到 inFlight）
 */
function startWarm(path: string, fn: WarmImpl): Promise<boolean> {
  const run = Promise.resolve()
    .then(() => fn(path))
    .then(
      (ok) => ok === true,
      () => false,
    )

  inFlight.set(path, run)
  run.then((ok) => settleWarm(path, run, ok))
  return run
}

/**
 * 给底层预热挂一个等待上限：超时只是本次调用放行，底层继续跑（仍可能建成 model
 * 惠及下一次 hover），因此超时既不取消 promise，也不提前摘掉 inFlight。
 * @author ddj 2026年10月20号
 * @param path 工作区相对路径
 * @param run 底层预热 promise（永不 reject）
 * @returns 最多 WARM_TIMEOUT_MS 内结算的布尔结果
 */
function withTimeout(path: string, run: Promise<boolean>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (ok: boolean): void => {
      if (settled) return

      settled = true
      if (timer) clearTimeout(timer)
      resolve(ok)
    }

    timer = setTimeout(() => {
      coolDown(path)
      finish(false)
    }, WARM_TIMEOUT_MS)

    run.then(finish, () => finish(false))
  })
}
// --endregion

// --region 安装与卸载

/**
 * 安装预热实现（EditorView 挂载时调用；传 null 视同卸载）。
 * @author ddj 2026年10月20号
 * @param fn 预热实现，或 null 表示卸载
 */
export function setModelWarmer(fn: WarmImpl | null): void {
  impl = typeof fn === 'function' ? fn : null
  if (!impl) resetWarmerState()
}

/**
 * 卸载预热实现：仅当传入的仍是当前实现才清（防卸载竞态误清新挂载的实现）。
 * @author ddj 2026年10月20号
 * @param fn 当初安装的实现
 */
export function clearModelWarmer(fn: WarmImpl): void {
  if (impl !== fn) return

  impl = null
  resetWarmerState()
}
// --endregion

// --region 预热调度

/**
 * 确保目标路径的 Monaco model 存在（供 hover 定义预览的 createModelReference 命中）。
 *
 * 降级语义：未安装实现（编辑器页签未挂载）、路径为空、处于失败冷却、实现失败或超时，
 * 一律返回 false 且不抛异常——此时行为等价于修复前（预览不显示，但不再产生未捕获异常）。
 * @author ddj 2026年10月20号
 * @param path 工作区相对路径（或绝对路径，由实现决定如何解析）
 * @returns 预热成功返回 true；被跳过/失败/超时返回 false
 */
export function warmModelFor(path: string): Promise<boolean> {
  if (!path || !impl) return Promise.resolve(false)

  const running = inFlight.get(path)
  if (running) return withTimeout(path, running)
  if (isCooling(path)) return Promise.resolve(false)

  return withTimeout(path, startWarm(path, impl))
}
// --endregion
